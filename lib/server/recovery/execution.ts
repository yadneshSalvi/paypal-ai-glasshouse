import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PaymentCore, PaymentError, ProviderError, type AuthorizationDecision, type PaymentCommand, type ProviderAdapter, type SqlPaymentStore } from '@fracture/paypal-core';
import type { Actor, Operation, OperationStatus } from '@/packages/domain/types';
import { projectOrders } from '@/packages/domain/temporal';
import { evaluateBranches } from '@/packages/domain/policy';
import { digest } from '@/packages/payments/security';
import { HttpError } from '../errors';
import { audit, datasetFor, storePlan } from '../repository';
import { commandIdentity } from '../payments/records';
import type { OneWriteTransport } from '../payments/transport';
import { ownedPayment, ownedPaymentResource, recoveryMember } from './authority';
import type { RecoveryCommand, RecoveryIntent, RecoveryRun } from './contracts';
import type { RecoveryService } from './service';
import { evidenceObserved, type DisputesGateway, type DisputeObservation } from './disputes';
import type { RecoveryEvidenceGateway, CaptureCapacity } from './evidence';
import { projectRecoveryResult, projectRecoveryReview } from './projection';
import { projectDispute } from './dispute-service';

interface Options {
  service:RecoveryService;store:SqlPaymentStore;provider:ProviderAdapter;transport:OneWriteTransport;
  evidence:Pick<RecoveryEvidenceGateway,'capacity'|'refund'|'addTracking'|'tracking'>;
  disputes:Pick<DisputesGateway,'list'|'get'|'provideEvidence'>;
}
const actorFor=(command:RecoveryCommand):Actor=>({tenantId:command.owned.tenantId,id:command.actorId,role:'operator',membershipVersion:command.membershipVersion});
const safeReason=(error:unknown)=>error instanceof HttpError||error instanceof PaymentError||error instanceof ProviderError?error.message:'The original result requires independent provider verification.';

export interface RecoveryCheck {
  operationId: string; outcome: 'verified'|'pending'|'unresolved'|'not_dispatched'|'not_completed'|'busy';
  observedAt: string; providerId: string|null; providerStatus: string|null; bodyHash: string|null;
  reason: string; evidenceSubmitted?: boolean; caseResolved?: boolean;
}

export class RecoveryExecutor {
  readonly core:PaymentCore;
  private readonly dispatchContext=new AsyncLocalStorage<{tenantId:string;id:string;leaseOwner:string}>();
  constructor(readonly options:Options){
    const guardedProvider=options.transport.provider(options.provider,async command=>{
      const intent=await this.intent(command.scope.tenantId,command.operationId),dispatch=this.dispatchContext.getStore();
      if(!dispatch||dispatch.tenantId!==intent.tenant_id||dispatch.id!==intent.id||dispatch.leaseOwner!==intent.lease_owner)throw new ProviderError('encode','The original domain dispatch lease is unavailable.','not_sent',409);
      try{await this.authorizeDomain(intent);await this.markDispatch(intent);}catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError('encode','Current application authority did not permit the original refund write.','not_sent',403);}
    });
    this.core=new PaymentCore({store:options.store,provider:{...options.provider,source:options.provider.source,
      execute:(command,signal)=>guardedProvider.execute(command,signal),read:(kind,id,signal)=>options.provider.read(kind,id,signal??AbortSignal.timeout(25_000)),reconcile:(operation,signal)=>options.provider.reconcile(operation,signal??AbortSignal.timeout(25_000))},
      policy:{authorize:command=>this.authorizeRefund(command)}});
  }
  private get db(){return this.options.service.db;}
  async intent(tenantId:string,id:string):Promise<RecoveryIntent>{
    const row=(await this.db.query<RecoveryIntent>('SELECT * FROM gh_recovery_intents WHERE tenant_id=$1 AND id=$2',[tenantId,id]))[0];
    if(!row||row.payload_hash!==digest(row.command)||row.command.operationId!==row.id||row.command.planId!==row.plan_id||row.command.actionId!==row.action_id||row.command.owned.tenantId!==tenantId||row.command.action.orderId!==row.order_id)throw new HttpError(409,'IMMUTABLE_INTENT_REQUIRED','The original immutable recovery intent is unavailable.');
    return row;
  }
  /** Intentionally separate from dispatch. This entry point has no provider write branch. */
  async reconcileOnly(tenantId: string, operationId: string, caller?: AbortSignal): Promise<RecoveryCheck> {
    const original = await this.intent(tenantId,operationId);
    const result = (outcome: RecoveryCheck['outcome'], reason: string, facts: Partial<RecoveryCheck> = {}): RecoveryCheck =>
      ({ operationId,outcome,observedAt:new Date().toISOString(),providerId:original.provider_id,providerStatus:null,bodyHash:null,reason,...facts });
    if (original.status === 'queued' || original.status === 'claimed') return result('not_dispatched','This original action has not reached dispatch. A status check cannot send it.');
    const owner = randomUUID();
    const claimed = await this.db.transaction(async tx => {
      const current = (await tx.query<RecoveryIntent>('SELECT * FROM gh_recovery_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,operationId]))[0];
      if (!current || current.lease_until && Date.parse(String(current.lease_until)) > Date.now()) return null;
      if (current.status === 'queued' || current.status === 'claimed') return null;
      return (await tx.query<RecoveryIntent>("UPDATE gh_recovery_intents SET lease_owner=$3,lease_until=now()+interval '180 seconds' WHERE tenant_id=$1 AND id=$2 RETURNING *",[tenantId,operationId,owner]))[0];
    });
    if (!claimed) return result('busy','The original worker still owns this action. Its acknowledgement will be checked after the lease ends.');
    const signal = caller ? AbortSignal.any([caller,AbortSignal.timeout(100_000)]) : AbortSignal.timeout(100_000);
    try {
      const intent = await this.intent(tenantId,operationId), command = intent.command;
      const owned = await ownedPaymentResource(this.db,tenantId,intent.order_id);
      if (digest(owned) !== digest(command.owned)) throw new HttpError(409,'RESOURCE_GRANT_CHANGED','The original owned payment changed; its status remains held for review.');
      let check: RecoveryCheck;
      let receipt: Record<string,unknown>;
      if (intent.kind === 'refund') {
        if (!command.payment) throw new HttpError(409,'REFUND_COMMAND_MISSING','The original immutable refund command is required.');
        const stored = await this.options.store.get(command.payment.scope,operationId);
        if (!stored) return result('unresolved','No original core receipt exists. This status check cannot create or send a refund.');
        if (stored.status === 'claimed' || stored.status === 'not_sent') return result('not_dispatched','The original core record does not establish a dispatched refund. No write was attempted by this check.');
        if (stored.status === 'refused') return result('not_completed','The original refund was refused. This status check cannot send a replacement.',{providerStatus:'REFUSED'});
        // Never use recoverOperation here: an expired claim may be write-resumable there.
        const operation = await this.core.reconcile(command.payment.scope,operationId,signal);
        const refunds = operation.receipt?.resources.filter(resource => resource.kind === 'refund' && resource.money?.currency === 'USD' &&
          resource.money.minor === command.action.amountMinor && (resource.parentId === null || resource.parentId === owned.captureId) && resource.customId === operationId) ?? [];
        const id = refunds.length === 1 ? refunds[0].id : intent.provider_id;
        if (!id) return result('unresolved','The original refund has no independently established identity. No refund was resent.');
        const observation = await this.options.evidence.refund(id,owned,operationId,command.action.amountMinor,signal);
        receipt = {...observation};
        check = result(observation.status === 'COMPLETED' ? 'verified' : ['FAILED','CANCELLED'].includes(observation.status) ? 'not_completed' : 'pending',`PayPal reports the original refund as ${observation.status.toLowerCase()}.`,
          {providerId:id,providerStatus:observation.status,bodyHash:observation.bodyHash,observedAt:observation.observedAt});
        if (check.outcome === 'verified') await projectRecoveryResult(this.db,intent,observation);
      } else if (intent.kind === 'tracking') {
        if (!command.tracking || !intent.provider_id) return result('unresolved','The original tracking write has no established tracker identity. A status check cannot add another tracker.');
        const observation = await this.options.evidence.tracking(owned,command.tracking,intent.provider_id,signal);
        receipt = {...observation};
        check = result('verified','The original tracking identity remains on its owning order. Shipping is still synthetic.',
          {providerId:intent.provider_id,providerStatus:observation.status,bodyHash:observation.bodyHash,observedAt:observation.observedAt});
        await projectRecoveryResult(this.db,intent,observation);
      } else {
        if (!command.evidence) throw new HttpError(409,'CASE_COMMAND_MISSING','The exact original case evidence is required.');
        const observation = await this.options.disputes.get(command.evidence.disputeId,{captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'},signal);
        await this.projectCase(intent,observation);
        const submitted = evidenceObserved(observation,command.evidence);
        receipt = {bodyHash:observation.bodyHash,observedAt:observation.observedAt,status:observation.status,evidenceSubmitted:submitted,caseResolved:observation.status==='RESOLVED'};
        check = result(submitted ? 'verified' : 'pending',submitted ? 'The original evidence is present. Submission and case resolution remain separate.' : 'This read has not confirmed the original submitted evidence. No additional evidence was sent.',
          {providerId:observation.id,providerStatus:observation.status,bodyHash:observation.bodyHash,observedAt:observation.observedAt,evidenceSubmitted:submitted,caseResolved:observation.status==='RESOLVED'});
      }
      if (check.outcome === 'verified') {
        // A completed receipt is an immutable historical record; checks live in their own outbox result.
        if (intent.status !== 'provider_success') await this.update(intent,'provider_success',check.reason,check.providerId,receipt);
        await projectRecoveryReview(this.db,intent,check.observedAt);
        if (intent.status !== 'provider_success') await this.rollup(tenantId,intent.plan_id);
      } else if (check.outcome === 'not_completed' && intent.status !== 'provider_success') {
        await this.update(intent,'provider_failed',check.reason,check.providerId,receipt);
        await this.rollup(tenantId,intent.plan_id);
      }
      return check;
    } finally {
      await this.db.query('UPDATE gh_recovery_intents SET lease_owner=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3',[tenantId,operationId,owner]);
    }
  }
  private async authorizeDomain(intent:RecoveryIntent){
    const command=intent.command,actor=actorFor(command);
    await recoveryMember(this.db,actor,true,command.membershipVersion);
    const plan=await this.options.service.plan(this.db,actor,intent.plan_id);
    this.options.service.validateContract(plan,command.approval.hash);
    const run=(await this.db.query<RecoveryRun>('SELECT * FROM gh_recovery_runs WHERE tenant_id=$1 AND plan_id=$2',[intent.tenant_id,intent.plan_id]))[0];
    if(!run||!run.fixture_acknowledged||run.plan_hash!==plan.hash||run.approved_by!==command.actorId||run.membership_version!==command.membershipVersion||
      plan.approvedBy!==command.actorId||plan.approvalMembershipVersion!==command.membershipVersion||plan.version!==command.approval.version||plan.expiresAt!==command.approval.expiresAt||
      !['approved','executing','partially_complete'].includes(plan.status)||Date.parse(plan.expiresAt)<=Date.now())throw new HttpError(403,'RECOVERY_APPROVAL_NOT_CURRENT','The exact recovery approval is no longer current.');
    const action=plan.branch.actions.find(action=>action.id===command.actionId);
    if(!action||digest(action)!==digest(command.action))throw new HttpError(409,'ACTION_CHANGED','The immutable approved action changed.');
    const dataset=await datasetFor(actor,this.db),record=dataset.orders.find(order=>order.id===intent.order_id);
    if(!record||dataset.revision!==run.accepted_revision||record.resourceVersion!==run.accepted_resources[intent.order_id])throw new HttpError(409,'EVIDENCE_CHANGED','New evidence outside this recovery made its unstarted actions stale.');
    const owned=await ownedPayment(this.db,actor,intent.order_id);
    if(digest(owned)!==digest(command.owned))throw new HttpError(409,'RESOURCE_GRANT_CHANGED','The original payment grant changed.');
    const knownAt=dataset.events.reduce((latest,event)=>event.ingestedAt>latest?event.ingestedAt:latest,plan.context!.knownAt);
    const current=projectOrders(dataset,{...plan.context!,knownAt,cohortVersion:dataset.revision,projectionVersion:dataset.revision}).find(order=>order.id===intent.order_id);
    if(!current)throw new HttpError(409,'POLICY_RECORD_REQUIRED','The current policy record is unavailable.');
    if(intent.kind==='refund'){
      const policy=evaluateBranches([current],plan.branch.budgetMinor).find(branch=>branch.id===plan.branch.id);
      if(command.action.amountMinor!==500||!policy?.rows[0]?.eligible)throw new HttpError(409,'REFUND_POLICY_CHANGED','The order no longer meets all five goodwill conditions.');
    }else{
      if(current.trackingNumber!==command.action.payload.trackingNumber||current.carrier!==command.action.payload.carrier||!['delivered','delayed','in_transit','shipped'].includes(current.fulfillmentState))throw new HttpError(409,'SHIPMENT_CHANGED','The approved fixture shipment no longer matches current evidence.');
      if(intent.kind==='tracking'&&current.trackingInPayPal)throw new HttpError(409,'TRACKING_ALREADY_RECORDED','An existing tracking assignment must be reconciled, not duplicated.');
      if(intent.kind==='dispute_response'&&(current.disputeId!==command.action.resourceId||current.disputeSource!=='sandbox'||current.disputeEvidenceHash!==command.action.payload.providerDisputeHash))throw new HttpError(409,'CASE_CHANGED','The provider case changed after this exact evidence review.');
    }
    return {actor,plan,run,owned};
  }
  private async authorizeRefund(command:PaymentCommand):Promise<AuthorizationDecision>{
    const deny=(reason:string):AuthorizationDecision=>({allowed:false,reason,resourceIds:[],currency:'USD',maximumMinor:0,approvalId:command.approval.id,approvalVersion:command.approval.version,approvalDigest:command.approval.digest});
    try{
      if(command.scope.projectId!=='glasshouse'||command.action.kind!=='refund_capture')return deny('This recovery policy only authorizes its own approved goodwill refunds.');
      const intent=await this.intent(command.scope.tenantId,command.operationId);
      if(intent.kind!=='refund'||!intent.command.payment||digest(intent.command.payment)!==digest(command))return deny('The original refund command does not match the recovery intent.');
      const record=(await this.db.query<{private_document:string;payload_hash:string}>('SELECT private_document,payload_hash FROM gh_payment_commands WHERE tenant_id=$1 AND operation_id=$2 AND plan_id=$3',[command.scope.tenantId,command.operationId,intent.plan_id]))[0];
      if(!record||record.payload_hash!==command.payloadHash||digest(this.options.service.secrets.open<PaymentCommand>(record.private_document,commandIdentity(command.scope.tenantId,command.operationId)))!==digest(command))return deny('The encrypted original refund command is missing or changed.');
      const {owned}=await this.authorizeDomain(intent);
      const signal=AbortSignal.timeout(25_000);
      const results=await Promise.allSettled([this.options.evidence.capacity(owned,signal),this.options.disputes.list({captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'},signal)]);
      const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason;
      const capacity=(results[0] as PromiseFulfilledResult<CaptureCapacity>).value;
      const inventory=(results[1] as PromiseFulfilledResult<Awaited<ReturnType<DisputesGateway['list']>>>).value;
      if(!inventory.complete||capacity.consumedMinor!==0||capacity.totalMinor-capacity.consumedMinor<command.action.money.minor)return deny('Current provider refunds do not permit ordinary goodwill.');
      for(const id of inventory.ids){
        const dispute=await this.options.disputes.get(id,{captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'},signal);
        if(dispute.status!=='RESOLVED')return deny('A current provider dispute prevents ordinary goodwill.');
      }
      await this.authorizeDomain(await this.intent(intent.tenant_id,intent.id));
      return {allowed:true,reason:'Current SQL authority, exact policy and complete provider headroom verified.',resourceIds:[owned.providerOrderId,owned.captureId],currency:'USD',maximumMinor:500,
        approvalId:command.approval.id,approvalVersion:command.approval.version,approvalDigest:command.approval.digest,
        reservation:{resourceKey:`capture:${owned.captureId}`,currency:'USD',totalMinor:capacity.totalMinor,externallyConsumedMinor:capacity.consumedMinor,
          observedProviderIds:capacity.refunds.filter(refund=>['COMPLETED','PENDING'].includes(refund.status)).map(refund=>refund.id),observedAt:capacity.observedAt}};
    }catch(error){return deny(safeReason(error));}
  }
  private async markDispatch(intent:RecoveryIntent){
    const rows=await this.db.query("UPDATE gh_recovery_intents SET status='submitting',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='claimed' AND lease_until>now() AND lease_owner=$3 RETURNING id",[intent.tenant_id,intent.id,intent.lease_owner]);
    if(!rows.length)throw new ProviderError('encode','The original dispatch claim is no longer available.','not_sent',409);
    await this.update(intent,'submitting','Sending the original approved action.');
  }
  private async update(intent:RecoveryIntent,status:OperationStatus,reason:string|null,providerId:string|null=intent.provider_id,result:Record<string,unknown>|null=null,release=false){
    await this.db.transaction(async tx=>{
      const claim=(await tx.query<{lease_owner:string|null}>('SELECT lease_owner FROM gh_recovery_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[intent.tenant_id,intent.id]))[0];
      if(!claim||claim.lease_owner!==intent.lease_owner)return;
      const existing=(await tx.query<{body:Operation}>('SELECT body FROM gh_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[intent.tenant_id,intent.id]))[0]?.body;
      if(!existing)throw new HttpError(409,'OPERATION_MISSING','The original operation row is unavailable.');
      if(existing.status==='provider_success'&&status!=='provider_success')return;
      const operation:Operation={...existing,status,reason,providerId,result:result??existing.result,attempts:intent.attempt,updatedAt:new Date().toISOString()};
      await tx.query('UPDATE gh_operations SET status=$3,body=$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2',[intent.tenant_id,intent.id,status,JSON.stringify(operation)]);
      await tx.query(`UPDATE gh_recovery_intents SET status=$3,provider_id=$4,receipt=COALESCE($5::jsonb,receipt),reason=$6,updated_at=now()${release?",lease_owner=NULL,lease_until=NULL,next_attempt_at=now()+interval '30 seconds'":''} WHERE tenant_id=$1 AND id=$2`,[intent.tenant_id,intent.id,status,providerId,result?JSON.stringify(result):null,reason]);
    });
  }
  private async projectCase(intent:RecoveryIntent,observation:DisputeObservation){
    await this.db.transaction(async tx=>{
      await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[intent.tenant_id]);
      await projectDispute(tx,actorFor(intent.command),intent.command.owned,observation,intent.plan_id);
    });
  }
  private async process(claim:RecoveryIntent):Promise<void>{
    let intent=await this.intent(claim.tenant_id,claim.id);
    if(intent.lease_owner!==claim.lease_owner||!intent.lease_until||Date.parse(String(intent.lease_until))<=Date.now())return;
    const command=intent.command,signal=AbortSignal.timeout(100_000);
    try{
      const owned=await ownedPaymentResource(this.db,intent.tenant_id,intent.order_id);
      if(digest(owned)!==digest(command.owned))throw new HttpError(409,'RESOURCE_GRANT_CHANGED','The original owned payment changed; its outcome remains held for review.');
      if(intent.kind==='refund'){
        if(!command.payment)throw new HttpError(409,'REFUND_COMMAND_MISSING','The original immutable refund command is required.');
        const original=await this.options.store.get(command.payment.scope,intent.id);
        if(!original&&intent.status!=='claimed')throw new HttpError(409,'ORIGINAL_OPERATION_MISSING','A possibly dispatched refund has no original core record; it cannot be resent.');
        if(original?.status==='claimed'&&Date.parse(original.leaseUntil)<=Date.now()){
          await this.db.query("UPDATE gh_recovery_intents SET status='claimed' WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3",[intent.tenant_id,intent.id,intent.lease_owner]);
          intent={...intent,status:'claimed'};
        }
        const operation=original?await this.core.recoverOperation(command.payment.scope,intent.id,signal):await this.core.execute(command.payment,signal);
        const refunds=operation.receipt?.resources.filter(resource=>resource.kind==='refund'&&resource.money?.currency==='USD'&&resource.money.minor===command.action.amountMinor&&(resource.parentId===null||resource.parentId===owned.captureId)&&resource.customId===intent.id)??[];
        const refundId=refunds.length===1?refunds[0].id:intent.provider_id;
        const receipt=operation.receipt?{receiptId:operation.receipt.id,bodyHash:operation.receipt.bodyHash,reconciled:operation.receipt.reconciled,status:operation.receipt.status,observedAt:operation.receipt.observedAt,transport:operation.receipt.transport}:null;
        if(operation.status==='refused'||operation.status==='not_sent'){
          await this.update(intent,operation.status==='refused'?'provider_failed':'blocked',operation.error?.message??'The original refund was not completed.',refundId,receipt,true);return;
        }
        if(!refundId){await this.update(intent,'unknown_outcome','The original refund result is unresolved. Only independent reads may reconcile it.',null,receipt,true);return;}
        await this.update(intent,'provider_pending','Checking the original refund directly with PayPal.',refundId,receipt);
        const observation=await this.options.evidence.refund(refundId,owned,intent.id,command.action.amountMinor,signal);
        if(observation.status!=='COMPLETED'){
          await this.update(intent,['FAILED','CANCELLED'].includes(observation.status)?'provider_failed':'provider_pending',`PayPal reports the original refund as ${observation.status.toLowerCase()}.`,refundId,{...observation},true);return;
        }
        await projectRecoveryResult(this.db,intent,observation);
        await this.update(intent,'provider_success','The exact $5 refund was independently verified. Delivery and dispute outcomes remain separate.',refundId,{...observation},true);return;
      }
      if(intent.kind==='tracking'){
        if(!command.tracking)throw new HttpError(409,'TRACKING_COMMAND_MISSING','The original approved shipment is required.');
        let trackerId=intent.provider_id;
        if(intent.status==='claimed'){
          await this.authorizeDomain(intent);
          const sent=await this.options.evidence.addTracking(owned,command.tracking,async()=>{await this.authorizeDomain(intent);await this.markDispatch(intent);},signal);
          trackerId=sent.trackerId;
          await this.update(intent,'provider_pending','Checking the original tracking assignment directly with PayPal.',trackerId,{...sent.receipt});
        }
        if(!trackerId){await this.update(intent,'unknown_outcome','The tracking response did not establish a tracker identity. The original write will not be repeated.',null,intent.receipt,true);return;}
        const observation=await this.options.evidence.tracking(owned,command.tracking,trackerId,signal);
        await projectRecoveryResult(this.db,intent,observation);
        await this.update(intent,'provider_success','The returned tracking identity was independently verified on its owning order. Shipping remains synthetic.',trackerId,{...observation},true);return;
      }
      if(!command.evidence)throw new HttpError(409,'CASE_COMMAND_MISSING','The exact original case evidence is required.');
      let observation:DisputeObservation;
      if(intent.status==='claimed'){
        await this.authorizeDomain(intent);
        const result=await this.options.disputes.provideEvidence(command.evidence,async()=>{await this.authorizeDomain(intent);await this.markDispatch(intent);},signal);
        observation=result.observation;
        await this.update(intent,'provider_pending','Checking the exact original evidence submission.',command.evidence.disputeId,{...result.receipt});
      }else observation=await this.options.disputes.get(command.evidence.disputeId,{captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'},signal);
      if(!evidenceObserved(observation,command.evidence)){
        await this.update(intent,'provider_pending','The case read has not yet confirmed the original evidence marker and shipment fields. No additional submission will be sent.',observation.id,{bodyHash:observation.bodyHash,observedAt:observation.observedAt,status:observation.status},true);return;
      }
      await this.projectCase(intent,observation);
      await this.update(intent,'provider_success','The exact evidence submission was independently observed. This does not mean the dispute is resolved.',observation.id,{bodyHash:observation.bodyHash,observedAt:observation.observedAt,status:observation.status,evidenceSubmitted:true,caseResolved:observation.status==='RESOLVED'},true);
    }catch(error){
      intent=await this.intent(claim.tenant_id,claim.id);
      if(intent.lease_owner!==claim.lease_owner)return;
      const status:OperationStatus=error instanceof ProviderError&&error.outcome==='rejected'?'provider_failed':
        error instanceof ProviderError&&error.outcome==='not_sent'||intent.status==='claimed'&&(error instanceof HttpError||error instanceof PaymentError)?'blocked':'unknown_outcome';
      await this.update(intent,status,safeReason(error),intent.provider_id,intent.receipt,true);
    }
  }
  private async claim(options:{tenantId?:string;planId?:string;kind?:RecoveryIntent['kind'];operationId?:string}):Promise<RecoveryIntent|null>{
    return this.db.transaction(async tx=>{
      const values:unknown[]=[];
      const condition=(column:string,value:string|undefined)=>{if(value===undefined)return '';values.push(value);return ` AND ${column}=$${values.length}`;};
      const scope=condition('i.tenant_id',options.tenantId)+condition('i.plan_id',options.planId)+condition('i.kind',options.kind)+condition('i.id',options.operationId);
      const row=(await tx.query<RecoveryIntent>(`SELECT i.* FROM gh_recovery_intents i JOIN gh_recovery_runs r ON r.tenant_id=i.tenant_id AND r.plan_id=i.plan_id
        WHERE i.status IN ('queued','claimed','submitting','unknown_outcome','provider_pending') AND i.next_attempt_at<=now()
        AND (i.lease_until IS NULL OR i.lease_until<now())${scope}
        AND (i.status<>'queued' OR NOT EXISTS(SELECT 1 FROM gh_recovery_intents other WHERE other.tenant_id=i.tenant_id AND other.order_id=i.order_id AND other.id<>i.id AND other.status IN ('claimed','submitting','unknown_outcome','provider_pending')))
        ORDER BY CASE WHEN i.status<>'queued' THEN 0 ELSE 1 END,CASE i.kind WHEN 'refund' THEN 0 WHEN 'dispute_response' THEN 1 ELSE 2 END,i.created_at,i.id
        LIMIT 1 FOR UPDATE OF r,i SKIP LOCKED`,values))[0];
      if(!row)return null;
      const leaseOwner=randomUUID();
      const claimed=(await tx.query<RecoveryIntent>(`UPDATE gh_recovery_intents SET lease_owner=$3,lease_until=now()+interval '180 seconds',
        attempt=attempt+CASE WHEN status='queued' THEN 1 ELSE 0 END,status=CASE WHEN status='queued' THEN 'claimed' ELSE status END,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,[row.tenant_id,row.id,leaseOwner]))[0];
      return claimed;
    });
  }
  private async rollup(tenantId:string,planId:string){
    await this.db.transaction(async tx=>{
      const original=(await tx.query<{body:import('@/packages/domain/types').RecoveryPlan}>('SELECT body FROM gh_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,planId]))[0]?.body;
      if(!original)return;
      const rows=await tx.query<{status:OperationStatus;count:string}>('SELECT status,count(*)::text AS count FROM gh_operations WHERE tenant_id=$1 AND plan_id=$2 GROUP BY status',[tenantId,planId]);
      const counts=Object.fromEntries(rows.map(row=>[row.status,Number(row.count)]));
      const total=Object.values(counts).reduce((sum,count)=>sum+count,0),success=counts.provider_success??0;
      const status=total===original.branch.actions.length&&success===total?'completed':success>0?'partially_complete':(counts.queued??0)+(counts.submitting??0)>0?'executing':'blocked';
      if(original.status!=='stale')await storePlan(tx,{...original,status});
      await tx.query('UPDATE gh_recovery_runs SET status=$3,updated_at=now() WHERE tenant_id=$1 AND plan_id=$2',[tenantId,planId,status]);
      await tx.query('UPDATE gh_jobs SET state=$3,lease_until=NULL,body=body||$4::jsonb WHERE tenant_id=$1 AND id=$2',[tenantId,`recovery-${planId}`,status==='completed'?'complete':status,JSON.stringify({counts,lastCheckedAt:new Date().toISOString()})]);
    });
  }
  /** Stop signals stop new claims; a dispatched write is allowed to finish its bounded verification. */
  async drain(options:{tenantId?:string;planId?:string;kind?:RecoveryIntent['kind'];operationId?:string;limit?:number;concurrency?:number;signal?:AbortSignal}={}){
    const limit=options.limit??20,concurrency=options.concurrency??2;
    if(!Number.isSafeInteger(limit)||limit<1||limit>40||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>3||options.kind&&!['refund','tracking','dispute_response'].includes(options.kind))throw new HttpError(400,'INVALID_WORKER_BOUND','The recovery worker bounds are invalid.');
    const stopAt=Date.now()+60_000;let claimed=0,failed=0;
    const touched=new Map<string,{tenantId:string;planId:string}>();
    while(claimed<limit&&!options.signal?.aborted&&Date.now()<stopAt){
      const batch:RecoveryIntent[]=[];
      for(let index=0;index<Math.min(concurrency,limit-claimed);index++){
        if(options.signal?.aborted||Date.now()>=stopAt)break;
        const intent=await this.claim(options);if(!intent)break;
        batch.push(intent);touched.set(`${intent.tenant_id}/${intent.plan_id}`,{tenantId:intent.tenant_id,planId:intent.plan_id});
      }
      if(!batch.length)break;
      claimed+=batch.length;
      const results=await Promise.allSettled(batch.map(intent=>this.dispatchContext.run({tenantId:intent.tenant_id,id:intent.id,leaseOwner:intent.lease_owner!},()=>this.process(intent))));
      for(const result of results)if(result.status==='rejected')failed++;
    }
    for(const run of touched.values())await this.rollup(run.tenantId,run.planId);
    return {claimed,plans:touched.size,failed};
  }
}
