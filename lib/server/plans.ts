import { randomUUID } from 'node:crypto';
import { applyDeliveryRevision, buildSnapshot } from '@/packages/domain';
import type { Actor, RecoveryPlan, Operation } from '@/packages/domain/types';
import { database } from '@/packages/db/client';
import { requireRole } from './auth';
import { audit, datasetFor, hash, persistDataset, storePlan } from './repository';
import { snapshotFor, snapshotContext } from './snapshots';
import {FINDING_DEPENDENCY_POLICY} from '@/packages/findings/types';
import {parseFindingReferences,validateFindingReferences,savePlanFindingReferences,assertPlanFindingDependencies,bindFindingApprovalAuthority,assertFindingApprovalAuthority} from './findings/dependencies';
import {recordFindingSourceChange} from './findings/sources';
import { HttpError } from './errors';
import { exactPlanHash, freezeAction } from './recovery/contracts';
import { recoveryRuntime } from './recovery/runtime';
import type {Database} from '@/packages/db/client';
import type {Role} from '@/packages/domain/types';
import {recoveryMember} from './recovery/authority';
import {assertWorkspaceContext,assertWorkspaceWritable} from './workspaces/authority';

async function currentWriter(tx:Database,actor:Actor,roles:Role[]){
  await assertWorkspaceContext(tx,actor,true);await assertWorkspaceWritable(tx,actor.tenantId);
  const current=await recoveryMember(tx,actor);requireRole(current,roles);return current;
}

export async function reviseEvidence(actor: Actor) {
  const db = await database();
  return db.transaction(async tx => {
    await currentWriter(tx,actor,['owner','operator','judge','investigator']);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.tenantId]);
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE', [actor.tenantId]);
    const old = await datasetFor(actor, tx);
    const before=buildSnapshot(old,snapshotContext(actor,old));
    if (old.events.some(event=>event.id.endsWith(':fulfillment.delivered:v2'))) return {revision:old.revision,removed:before.removedOrderIds,stalePlanIds:[],alreadyApplied:true};
    const revised=applyDeliveryRevision(old),after=buildSnapshot(revised,snapshotContext(actor,revised));
    await persistDataset(tx,revised);
    const removed=before.affectedOrderIds.filter(id=>!after.affectedOrderIds.includes(id)).sort();
    const change=await recordFindingSourceChange(tx,actor,old,revised,{kind:'delivery_correction',reason:'New carrier delivery records changed the factual scope. Review the current interpretation and a new exact manifest.',sourceId:'carrier-delivery-v2'});
    const stalePlanIds=change?.staleDependentPlanIds??[];
    if(!change){
      const plans=await tx.query<{body:RecoveryPlan}>("SELECT body FROM gh_plans WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved') FOR UPDATE",[actor.tenantId]);
      for(const {body:plan} of plans){await storePlan(tx,{...plan,status:'stale',staleReason:'New delivery records changed the affected cohort. Review a current source snapshot.'});stalePlanIds.push(plan.id);}
    }
    await audit(tx,actor,'source.delivery_corrected',`${removed.length} delivery records changed the incident scope from ${before.affectedOrderIds.length} to ${after.affectedOrderIds.length}`,'carrier-delay-pnw',{removedOrderIds:removed,source:'fixture_shipping',stalePlanIds,revision:revised.revision,sourceChangeId:change?.id??null});
    return {revision:revised.revision,removed,stalePlanIds,beforeCount:before.affectedOrderIds.length,afterCount:after.affectedOrderIds.length,sourceChangeId:change?.id??null};
  });
}

export async function createPlan(actor: Actor, branchId: string, budgetMinor: number, expectedSnapshotHash?:string,rawFindingDependencies:unknown=[]) {
  requireRole(actor,['owner','operator','judge','investigator']);
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor<0 || budgetMinor>100_000) throw new HttpError(400,'INVALID_BUDGET','Choose a budget between $0 and $1,000 in whole cents.');
  const snapshot = await snapshotFor(actor);
  if(expectedSnapshotHash && expectedSnapshotHash!==snapshot.hash) throw new HttpError(409,'SNAPSHOT_CHANGED','Return to the latest time and knowledge cutoff before preparing a recovery. The reviewed snapshot is no longer current.');
  const chosen = snapshot.branches.find(b=>b.id===branchId);
  if (!chosen) throw new HttpError(400,'INVALID_BRANCH','Choose one of the evaluated recovery branches.');
  const id = 'plan-' + randomUUID();
  const branch = {...chosen,budgetMinor,withinBudget:chosen.refundTotalMinor<=budgetMinor,actions:chosen.actions.map(action=>freezeAction(actor.tenantId,id,action))};
  if (!branch.withinBudget) throw new HttpError(409,'BUDGET_EXCEEDED','This branch exceeds the refund budget. Raise the cap or choose another branch.');
  const now = new Date();
  const executionMode = snapshot.sourceCoverage.sandboxPayments > 0 && branch.actions.filter(a=>a.kind==='refund').every(a=>a.sourceClass==='sandbox') ? 'sandbox' : 'sample';
  const plan: RecoveryPlan = { id,tenantId:actor.tenantId,version:1,createdBy:actor.id,createdAt:now.toISOString(),status:'ready_for_review',branch,
    snapshotId:snapshot.id,snapshotHash:snapshot.hash,cohortVersion:snapshot.context.cohortVersion,hash:'',
    expiresAt:new Date(now.getTime()+30*60_000).toISOString(),staleReason:null,approvedBy:null,approvedAt:null,executionMode,contractVersion:3,context:snapshot.context,findingDependencyPolicy:FINDING_DEPENDENCY_POLICY,findingDependencies:parseFindingReferences(rawFindingDependencies) };
  plan.hash=exactPlanHash(plan);
  const db = await database();
  await db.transaction(async tx=>{
    await currentWriter(tx,actor,['owner','operator','judge','investigator']);
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR SHARE',[actor.tenantId]);
    if(buildSnapshot(await datasetFor(actor,tx),snapshot.context).hash!==snapshot.hash)throw new HttpError(409,'SNAPSHOT_CHANGED','Evidence changed before the recovery could be frozen. Review the current snapshot and prepare a new proposal.');
    await validateFindingReferences(tx,actor,plan.findingDependencies,snapshot);
    await storePlan(tx,plan);await savePlanFindingReferences(tx,plan);await audit(tx,actor,'plan.created',`${branch.eligibleCount} proposed refunds · $${(branch.refundTotalMinor/100).toFixed(2)} · exact manifest frozen`,id,{planHash:plan.hash,mode:executionMode});
  });
  return plan;
}

export async function approvePlan(actor: Actor, planId: string, submittedHash: string,fixtureAcknowledged=false) {
  requireRole(actor,['owner','operator','judge']);
  const db = await database();
  const existing=(await db.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE tenant_id=$1 AND id=$2',[actor.tenantId,planId]))[0]?.body;
  if(existing?.executionMode==='sandbox')return (await recoveryRuntime()).recoveryService.approve(actor,planId,submittedHash,fixtureAcknowledged);
  return db.transaction(async tx=>{
    await currentWriter(tx,actor,['owner','operator','judge']);
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR SHARE',[actor.tenantId]);
    const rows=await tx.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,planId]);
    const plan=rows[0]?.body;
    if (!plan) throw new HttpError(404,'PLAN_NOT_FOUND','This plan is not in your workspace.');
    if (plan.hash!==submittedHash) throw new HttpError(409,'MANIFEST_CHANGED','The reviewed manifest differs from this request. Reopen the exact approval sheet.');
    await assertPlanFindingDependencies(tx,actor,plan);
    if (plan.status==='approved'){await assertFindingApprovalAuthority(tx,actor,plan);return plan;}
    if (plan.status!=='ready_for_review') throw new HttpError(409,'PLAN_STALE',plan.staleReason || `This plan is ${plan.status}. Create a fresh plan.`);
    if (Date.parse(plan.expiresAt)<Date.now()) throw new HttpError(409,'PLAN_EXPIRED','This approval window expired. Refresh the current provider state and rebuild the plan.');
    const dataset=await datasetFor(actor,tx);
    if (dataset.revision!==plan.cohortVersion) throw new HttpError(409,'COHORT_CHANGED','Evidence changed after this plan was prepared. Rebuild it first.');
    for (const action of plan.branch.actions) {
      const order=dataset.orders.find(o=>o.id===action.orderId);
      if (!order || order.resourceVersion!==action.resourceVersion) throw new HttpError(409,'RESOURCE_CHANGED','An order changed after this manifest was created. Rebuild the plan.');
      if (action.kind==='refund' && (order.disputeOpen || order.refundedMinor>0 || order.goodwillCreditMinor>0 || order.refundableMinor<action.amountMinor)) throw new HttpError(409,'REFUND_INELIGIBLE','A refund is no longer eligible under the policy. Rebuild the plan.');
    }
    const approved={...plan,status:'approved' as const,approvedBy:actor.id,approvedAt:new Date().toISOString()};
    await bindFindingApprovalAuthority(tx,actor,approved);
    await storePlan(tx,approved);
    await audit(tx,actor,'plan.approved',`${plan.executionMode==='sample'?'Rehearsal':'Sandbox'} manifest approved`,plan.id,{planHash:plan.hash,amountMinor:plan.branch.refundTotalMinor,expiresAt:plan.expiresAt});
    return approved;
  });
}

export async function enqueuePlan(actor: Actor, planId: string, submittedHash: string) {
  requireRole(actor,['owner','operator','judge']);
  const db=await database();
  const existing=(await db.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE tenant_id=$1 AND id=$2',[actor.tenantId,planId]))[0]?.body;
  if(existing?.executionMode==='sandbox')return (await recoveryRuntime()).recoveryService.enqueue(actor,planId,submittedHash);
  return db.transaction(async tx=>{
    await currentWriter(tx,actor,['owner','operator','judge']);
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR SHARE',[actor.tenantId]);
    const rows=await tx.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,planId]);
    const plan=rows[0]?.body;
    if (!plan || plan.hash!==submittedHash) throw new HttpError(409,'APPROVAL_MISMATCH','A matching exact approval is required.');
    await assertPlanFindingDependencies(tx,actor,plan);
    await assertFindingApprovalAuthority(tx,actor,plan);
    if (!['approved','executing','partially_complete','completed','blocked'].includes(plan.status)) throw new HttpError(409,'APPROVAL_REQUIRED','Approve a current exact manifest before execution.');
    if (plan.status==='approved' && Date.parse(plan.expiresAt)<Date.now()) throw new HttpError(409,'APPROVAL_EXPIRED','The approved plan expired before execution. Rebuild it.');
    const dataset=await datasetFor(actor,tx);
    if (plan.status==='approved' && dataset.revision!==plan.cohortVersion) throw new HttpError(409,'COHORT_CHANGED','This approval is stale after new evidence.');
    let inserted=0;
    for (const action of plan.branch.actions) {
      const id='op-'+hash({tenantId:actor.tenantId,planId:plan.id,actionId:action.id}).slice(0,28);
      const operation: Operation={id,tenantId:actor.tenantId,planId:plan.id,actionId:action.id,orderId:action.orderId,kind:action.kind,amountMinor:action.amountMinor,currency:action.currency,
        status:'blocked',providerRequestId:id,payloadHash:hash(action.payload),providerId:null,attempts:0,updatedAt:new Date().toISOString(),sourceClass:action.sourceClass,result:null,
        reason:plan.executionMode==='sample'?'Sample order: connect a verified sandbox capture to execute this action.':action.blockedReason || 'Provider execution is awaiting verified capability and resource grant.'};
      const result=await tx.query('INSERT INTO gh_operations(tenant_id,id,plan_id,action_id,status,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,plan_id,action_id) DO NOTHING RETURNING id',[actor.tenantId,id,plan.id,action.id,operation.status,JSON.stringify(operation)]);
      inserted+=result.length;
    }
    await storePlan(tx,{...plan,status:'blocked'});
    if (inserted) await audit(tx,actor,'execution.checked',`${inserted} action rows checked · provider prerequisites shown per action`,plan.id,{count:inserted,planHash:plan.hash,mode:plan.executionMode});
    return {planId:plan.id,inserted,status:'blocked'};
  });
}

/** A fresh review reads current authority and dependency facts without changing
 * the previously frozen approval manifest or completed provider outcomes. */
export async function reviewPlan(actor:Actor,planId:string){
  const db=await database();return db.transaction(async tx=>{
    await recoveryMember(tx,actor);await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR SHARE',[actor.tenantId]);
    const plan=(await tx.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE tenant_id=$1 AND id=$2',[actor.tenantId,planId]))[0]?.body;
    if(!plan)throw new HttpError(404,'PLAN_NOT_FOUND','This exact recovery manifest is not in the current workspace.');
    let dependencies;try{if(plan.approvedBy)await assertFindingApprovalAuthority(tx,actor,plan);dependencies=await assertPlanFindingDependencies(tx,actor,plan)??{policy:'legacy-v2',valid:true,checkedAt:new Date().toISOString(),dependencies:[],reason:'This earlier manifest retains its original approval contract.'};}
    catch(error){if(!(error instanceof HttpError))throw error;dependencies={policy:plan.findingDependencyPolicy??'legacy-v2',valid:false,checkedAt:new Date().toISOString(),dependencies:[],reason:error.message,code:error.code};}
    return {plan,dependencies};
  });
}
