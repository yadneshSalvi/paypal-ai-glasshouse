import { randomUUID } from 'node:crypto';
import { payloadHash, type PaymentCommand } from '@fracture/paypal-core';
import type { Database } from '@/packages/db/client';
import type { Actor, ActionRow, Operation, RecoveryPlan } from '@/packages/domain/types';
import { buildSnapshot } from '@/packages/domain';
import { digest, type PaymentSecrets } from '@/packages/payments/security';
import { HttpError } from '../errors';
import { audit, datasetFor, storePlan } from '../repository';
import { commandIdentity } from '../payments/records';
import { ownedPayment, recoveryMember, type OwnedPayment } from './authority';
import { exactPlanHash, freezeAction, recoveryOperationId, semanticKey, type RecoveryCommand, type RecoveryIntent, type RecoveryRun } from './contracts';
import type { DisputeObservation } from './disputes';

export class RecoveryService {
  constructor(readonly db:Database,readonly secrets:PaymentSecrets){}
  async plan(db:Database,actor:Actor,id:string,lock=false):Promise<RecoveryPlan>{
    const plan=(await db.query<{body:RecoveryPlan}>(`SELECT body FROM gh_plans WHERE tenant_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[actor.tenantId,id]))[0]?.body;
    if(!plan)throw new HttpError(404,'PLAN_NOT_FOUND','This recovery plan is outside your workspace.');
    return plan;
  }
  validateContract(plan:RecoveryPlan,submittedHash:string){
    if(plan.contractVersion!==2||!plan.context||plan.executionMode!=='sandbox')throw new HttpError(409,'CURRENT_CONTRACT_REQUIRED','Prepare a new sandbox manifest with exact evidence and current resource authority.');
    if(plan.hash!==submittedHash||exactPlanHash(plan)!==plan.hash)throw new HttpError(409,'MANIFEST_CHANGED','The exact reviewed manifest changed. Rebuild it before approval.');
    if(plan.branch.currency!=='USD'||plan.branch.policyId!=='goodwill-delay-v1'||plan.branch.refundTotalMinor>plan.branch.budgetMinor||
      plan.branch.actions.filter(action=>action.kind==='refund').reduce((sum,action)=>sum+action.amountMinor,0)!==plan.branch.refundTotalMinor)throw new HttpError(409,'BUDGET_CHANGED','The complete manifest does not match its approved refund cap.');
    if(new Set(plan.branch.actions.map(action=>action.id)).size!==plan.branch.actions.length)throw new HttpError(409,'DUPLICATE_ACTION','An exact manifest cannot repeat an action identity.');
  }
  private async qualifyAction(tx:Database,actor:Actor,action:ActionRow,owned:OwnedPayment){
    if(action.currency!=='USD'||action.orderId!==owned.orderId||action.payload.captureId&&action.payload.captureId!==owned.captureId||action.payload.paypalOrderId&&action.payload.paypalOrderId!==owned.providerOrderId)throw new HttpError(409,'RESOURCE_CHANGED','A proposed action refers to a different payment.');
    if(action.kind==='refund'){
      if(action.resourceId!==owned.captureId||action.sourceClass!=='sandbox'||action.amountMinor!==500)throw new HttpError(409,'REFUND_CONTRACT_CHANGED','Goodwill refunds require the original capture and exactly $5.');
      return;
    }
    if(!String(action.payload.trackingNumber??'').startsWith('SYNTHETIC-')||typeof action.payload.carrier!=='string'||!action.payload.carrier)throw new HttpError(409,'SHIPMENT_EVIDENCE_REQUIRED','The exact labelled fixture shipment is missing.');
    if(action.kind==='tracking'){
      if(action.resourceId!==owned.providerOrderId||action.payload.notifyPayer!==false||action.payload.fixtureShipping!==true)throw new HttpError(409,'TRACKING_CONTRACT_CHANGED','The approved tracking scope changed.');
      return;
    }
    if(!action.resourceId||action.sourceClass!=='sandbox'||action.payload.disputeId!==action.resourceId)throw new HttpError(409,'OWNED_DISPUTE_REQUIRED','Import the genuine PayPal case before approving its response.');
    const record=(await tx.query<{body:DisputeObservation}>("SELECT body FROM gh_provider_resources WHERE tenant_id=$1 AND kind='dispute' AND provider_id=$2 AND order_id=$3 AND active=true",[actor.tenantId,action.resourceId,action.orderId]))[0]?.body;
    if(!record||record.bodyHash!==action.payload.providerDisputeHash||record.captureId!==owned.captureId||record.status!=='WAITING_FOR_SELLER_RESPONSE'||!record.actions.includes('provide-evidence')||
      !record.evidence.some(evidence=>evidence.source==='REQUESTED_FROM_SELLER'&&evidence.type==='PROOF_OF_FULFILLMENT'&&evidence.itemId===null)||
      !record.sellerResponseDueAt||Date.parse(record.sellerResponseDueAt)<=Date.now())throw new HttpError(409,'DISPUTE_EVIDENCE_NOT_READY','The current provider case does not yet permit this exact fulfillment response. Refresh its state before approval.');
  }
  async approve(actor:Actor,id:string,submittedHash:string,fixtureAcknowledged:boolean):Promise<RecoveryPlan>{
    return this.db.transaction(async tx=>{
      await recoveryMember(tx,actor,true);
      await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[actor.tenantId]);
      const plan=await this.plan(tx,actor,id,true);this.validateContract(plan,submittedHash);
      if(plan.status==='approved')return plan;
      if(plan.status!=='ready_for_review'||Date.parse(plan.expiresAt)<=Date.now())throw new HttpError(409,'PLAN_NOT_CURRENT','Prepare a fresh exact manifest before approving this recovery.');
      if(!fixtureAcknowledged)throw new HttpError(400,'FIXTURE_ACKNOWLEDGEMENT_REQUIRED','Review and acknowledge the synthetic shipment evidence before its sandbox submission.');
      const dataset=await datasetFor(actor,tx);const snapshot=buildSnapshot(dataset,plan.context);
      if(dataset.revision!==plan.cohortVersion||snapshot.hash!==plan.snapshotHash)throw new HttpError(409,'COHORT_CHANGED','The evidence changed after this exact manifest was prepared.');
      const policyBranch=snapshot.branches.find(branch=>branch.id===plan.branch.id);
      if(!policyBranch||digest({...policyBranch,budgetMinor:plan.branch.budgetMinor,withinBudget:policyBranch.refundTotalMinor<=plan.branch.budgetMinor,actions:policyBranch.actions.map(action=>freezeAction(actor.tenantId,plan.id,action))})!==digest(plan.branch))throw new HttpError(409,'POLICY_MANIFEST_CHANGED','The proposed actions no longer match the deterministic recovery policy.');
      const resources:Record<string,number>={};const payments=new Map<string,OwnedPayment>();
      for(const action of plan.branch.actions){
        const order=dataset.orders.find(order=>order.id===action.orderId);
        if(!order||order.resourceVersion!==action.resourceVersion)throw new HttpError(409,'RESOURCE_CHANGED','An order changed after review. Prepare a fresh manifest.');
        let owned=payments.get(action.orderId);if(!owned){owned=await ownedPayment(tx,actor,action.orderId);payments.set(action.orderId,owned);}
        await this.qualifyAction(tx,actor,action,owned);resources[action.orderId]=order.resourceVersion;
      }
      const approved:RecoveryPlan={...plan,status:'approved',approvedBy:actor.id,approvedAt:new Date().toISOString(),approvalMembershipVersion:actor.membershipVersion,fixtureShippingAcknowledged:true};
      await storePlan(tx,approved);
      await tx.query(`INSERT INTO gh_recovery_runs(tenant_id,plan_id,plan_hash,membership_version,approved_by,accepted_revision,accepted_resources,fixture_acknowledged,status)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,true,'approved')`,[actor.tenantId,id,plan.hash,actor.membershipVersion,actor.id,dataset.revision,JSON.stringify(resources)]);
      await audit(tx,actor,'plan.approved','Exact sandbox recovery and labelled shipment evidence approved',id,{planHash:plan.hash,actions:plan.branch.actions.length,refundMinor:plan.branch.refundTotalMinor,capMinor:plan.branch.budgetMinor,expiresAt:plan.expiresAt});
      return approved;
    });
  }
  async enqueue(actor:Actor,id:string,submittedHash:string){
    return this.db.transaction(async tx=>{
      await recoveryMember(tx,actor,true);
      await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[actor.tenantId]);
      const plan=await this.plan(tx,actor,id,true);this.validateContract(plan,submittedHash);
      const run=(await tx.query<RecoveryRun>('SELECT * FROM gh_recovery_runs WHERE tenant_id=$1 AND plan_id=$2 FOR UPDATE',[actor.tenantId,id]))[0];
      if(!run||!['approved','executing','partially_complete','completed','blocked'].includes(plan.status)||run.plan_hash!==plan.hash)throw new HttpError(409,'APPROVAL_REQUIRED','Approve this exact sandbox manifest before execution.');
      const existing=(await tx.query<{count:string}>('SELECT count(*)::text AS count FROM gh_operations WHERE tenant_id=$1 AND plan_id=$2',[actor.tenantId,id]))[0];
      if(Number(existing?.count)===plan.branch.actions.length)return {planId:id,inserted:0,status:plan.status};
      await recoveryMember(tx,{...actor,id:run.approved_by,membershipVersion:run.membership_version},true,run.membership_version);
      if(Date.parse(plan.expiresAt)<=Date.now())throw new HttpError(409,'APPROVAL_EXPIRED','The recovery approval expired before execution.');
      const dataset=await datasetFor(actor,tx);if(dataset.revision!==run.accepted_revision)throw new HttpError(409,'COHORT_CHANGED','New evidence made this approval stale.');
      let inserted=0,scheduled=0;
      const payments=new Map<string,OwnedPayment>();
      for(const action of plan.branch.actions){
        let owned=payments.get(action.orderId);if(!owned){owned=await ownedPayment(tx,actor,action.orderId);payments.set(action.orderId,owned);}
        await this.qualifyAction(tx,actor,action,owned);
        const operationId=recoveryOperationId(actor.tenantId,id,action.id),semantic=semanticKey(action,owned);
        const payment:PaymentCommand|null=action.kind==='refund'?{
          scope:{tenantId:actor.tenantId,projectId:'glasshouse'},operationId,businessKey:semantic,intentId:semantic,providerRequestId:randomUUID(),
          action:{kind:'refund_capture',captureId:owned.captureId,orderId:owned.providerOrderId,money:{currency:'USD',minor:action.amountMinor}},
          payloadHash:'',approval:{id:plan.id,version:plan.version,digest:plan.hash,expiresAt:plan.expiresAt},
        }:null;
        if(payment)payment.payloadHash=payloadHash(payment.action);
        const command:RecoveryCommand={operationId,planId:id,actionId:action.id,actorId:run.approved_by,membershipVersion:run.membership_version,action,owned,
          approval:{hash:plan.hash,version:plan.version,expiresAt:plan.expiresAt},payment,
          tracking:action.kind==='tracking'?{operationId,orderId:owned.providerOrderId,captureId:owned.captureId,trackingNumber:String(action.payload.trackingNumber),carrierName:String(action.payload.carrier),notifyPayer:false}:null,
          evidence:action.kind==='dispute_response'?{operationId,disputeId:action.resourceId!,captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD',trackingNumber:String(action.payload.trackingNumber),carrierName:String(action.payload.carrier),notes:String(action.payload.statement),expectedBodyHash:String(action.payload.providerDisputeHash)}:null};
        if(action.payload.operationId!==operationId)throw new HttpError(409,'OPERATION_ID_CHANGED','The reviewed operation identity changed.');
        const created=await tx.query(`INSERT INTO gh_recovery_intents(tenant_id,id,semantic_key,plan_id,action_id,order_id,kind,payload_hash,command)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[actor.tenantId,operationId,semantic,id,action.id,action.orderId,action.kind,digest(command),JSON.stringify(command)]);
        const prior=(await tx.query<RecoveryIntent>('SELECT * FROM gh_recovery_intents WHERE tenant_id=$1 AND semantic_key=$2',[actor.tenantId,semantic]))[0];
        const belongs=prior?.id===operationId;
        scheduled+=created.length;
        if(created.length&&payment)await tx.query('INSERT INTO gh_payment_commands(tenant_id,operation_id,business_key,run_id,order_id,plan_id,action_kind,created_by,membership_version,payload_hash,private_document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [actor.tenantId,operationId,semantic,owned.runId,action.orderId,id,'refund_capture',run.approved_by,run.membership_version,payment.payloadHash,this.secrets.seal(payment,commandIdentity(actor.tenantId,operationId))]);
        const operation:Operation={id:operationId,tenantId:actor.tenantId,planId:id,actionId:action.id,orderId:action.orderId,kind:action.kind,amountMinor:action.amountMinor,currency:action.currency,
          status:belongs?'queued':'blocked',providerRequestId:belongs?(prior.command.payment?.providerRequestId??operationId):operationId,payloadHash:belongs?prior.payload_hash:digest(command),providerId:null,attempts:0,updatedAt:new Date().toISOString(),sourceClass:action.sourceClass,result:null,
          reason:belongs?'Queued for current provider and policy verification.':`The same business intent already belongs to ${prior?.id}. Review its original outcome; this plan cannot create another write.`};
        const result=await tx.query('INSERT INTO gh_operations(tenant_id,id,plan_id,action_id,status,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,plan_id,action_id) DO NOTHING RETURNING id',[actor.tenantId,operationId,id,action.id,operation.status,JSON.stringify(operation)]);inserted+=result.length;
      }
      const status=scheduled?'executing':'blocked';
      await storePlan(tx,{...plan,status});
      await tx.query('UPDATE gh_recovery_runs SET status=$3,updated_at=now() WHERE tenant_id=$1 AND plan_id=$2',[actor.tenantId,id,status]);
      if(scheduled)await tx.query("INSERT INTO gh_jobs(tenant_id,id,kind,state,body) VALUES($1,$2,'recovery','queued',$3::jsonb) ON CONFLICT DO NOTHING",[actor.tenantId,`recovery-${id}`,JSON.stringify({planId:id,planHash:plan.hash})]);
      await audit(tx,actor,'recovery.queued',`${inserted} exact recovery actions recorded for durable execution`,id,{planHash:plan.hash});
      return {planId:id,inserted,status};
    });
  }
}
