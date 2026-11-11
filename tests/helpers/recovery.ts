import { randomUUID } from 'node:crypto';
import { paymentHarness, approvedRun } from './payments';
import { RecoveryService } from '../../lib/server/recovery/service';
import { RecoveryEvidenceGateway } from '../../lib/server/recovery/evidence';
import { RecoveryExecutor } from '../../lib/server/recovery/execution';
import { ensureRecoverySchema } from '../../lib/server/recovery/schema';
import { datasetFor, persistDataset, storePlan } from '../../lib/server/repository';
import { buildSnapshot, stableHash } from '../../packages/domain';
import { freezeAction, exactPlanHash } from '../../lib/server/recovery/contracts';
import { digest } from '../../packages/payments/security';
import type { DisputeObservation, DisputeInventory, FulfillmentEvidence } from '../../lib/server/recovery/disputes';
import type { RecoveryPlan } from '../../packages/domain/types';
import { ProviderError } from '@fracture/paypal-core';

export class RecoveryCases {
  observations=new Map<string,DisputeObservation>();
  posts:FulfillmentEvidence[]=[];
  loseResponse=false;readsUnavailable=false;
  list=async(owner:{captureId:string}):Promise<DisputeInventory>=>{
    if(this.readsUnavailable)throw new ProviderError('connection','Fixture inventory unavailable.','unknown',502);
    return{captureId:owner.captureId,ids:[...this.observations.values()].filter(value=>value.captureId===owner.captureId).map(value=>value.id),complete:true,observedAt:new Date().toISOString(),bodyHash:stableHash(owner),pages:[{status:200,debugId:null,bodyHash:stableHash(owner)}]};
  };
  get=async(id:string):Promise<DisputeObservation>=>{
    if(this.readsUnavailable)throw new ProviderError('connection','Fixture case read unavailable.','unknown',502);
    const value=this.observations.get(id);if(!value)throw new ProviderError('api','Fixture case missing.','unknown',404);return structuredClone(value);
  };
  provideEvidence=async(request:FulfillmentEvidence,authorize:()=>Promise<void>)=>{
    const current=await this.get(request.disputeId);if(current.bodyHash!==request.expectedBodyHash)throw new ProviderError('encode','Fixture case changed.','not_sent',409);
    await authorize();this.posts.push(request);
    const observation={...current,updatedAt:new Date().toISOString(),observedAt:new Date().toISOString(),evidence:[...current.evidence,{type:'PROOF_OF_FULFILLMENT',source:'SUBMITTED_BY_SELLER',date:new Date().toISOString(),itemId:null,notesHash:digest(request.notes),tracking:[{carrier:'OTHER',carrierOther:request.carrierName,number:request.trackingNumber}]}]};
    observation.bodyHash=digest({...observation,bodyHash:undefined,observedAt:undefined});this.observations.set(request.disputeId,observation);
    if(this.loseResponse){this.loseResponse=false;throw new ProviderError('connection','Fixture lost evidence response.','unknown',502);}
    return{receipt:{status:200,debugId:null,bodyHash:observation.bodyHash,observedAt:observation.observedAt},observation,submitted:true};
  };
}
export async function recoveryHarness(count=1,external?:Parameters<typeof paymentHarness>[0]){
  const h=await paymentHarness(external);await ensureRecoverySchema(h.db);
  const run=await approvedRun(h);await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  const ids=Array.from({length:count},(_,index)=>`fernwood-order-${String(14+index).padStart(4,'0')}`);
  await h.db.query("UPDATE gh_seed_items SET next_attempt_at=now()+interval '1 day' WHERE tenant_id=$1 AND NOT(order_id=ANY($2::text[]))",[h.who.tenantId,ids]);
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:count,concurrency:1});
  const dataset=await datasetFor(h.who,h.db);for(const order of dataset.orders)order.incidentMember=ids.includes(order.id);
  await persistDataset(h.db,dataset);
  const cases=new RecoveryCases(),recoveryService=new RecoveryService(h.db,h.secrets),recoveryEvidence=new RecoveryEvidenceGateway(h.sdk.client,h.evidence,h.transport);
  const worker=()=>new RecoveryExecutor({service:recoveryService,store:h.store,provider:h.sdk,transport:h.transport,evidence:recoveryEvidence,disputes:cases});
  const plan=async(branchId:'targeted'|'comprehensive'='targeted')=>{
    const snapshot=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString(),roleScope:h.who.role});
    const id=`test-plan-${randomUUID()}`,branch=snapshot.branches.find(value=>value.id===branchId)!;
    const value:RecoveryPlan={id,tenantId:h.who.tenantId,version:1,createdBy:h.who.id,createdAt:new Date().toISOString(),status:'ready_for_review',branch:{...branch,actions:branch.actions.map(action=>freezeAction(h.who.tenantId,id,action))},
      snapshotId:snapshot.id,snapshotHash:snapshot.hash,cohortVersion:snapshot.context.cohortVersion,hash:'',expiresAt:new Date(Date.now()+1_800_000).toISOString(),staleReason:null,approvedBy:null,approvedAt:null,executionMode:'sandbox',contractVersion:2,context:snapshot.context};
    value.hash=exactPlanHash(value);await storePlan(h.db,value);return value;
  };
  const approveAndQueue=async(value:RecoveryPlan)=>{await recoveryService.approve(h.who,value.id,value.hash,true);return recoveryService.enqueue(h.who,value.id,value.hash);};
  const due=()=>h.db.query("UPDATE gh_recovery_intents SET next_attempt_at=now()-interval '1 second',lease_until=NULL,lease_owner=NULL WHERE tenant_id=$1",[h.who.tenantId]);
  return{...h,run,ids,cases,recoveryService,recoveryEvidence,worker,plan,approveAndQueue,due};
}
