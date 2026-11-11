import type { PaymentCommand } from '@fracture/paypal-core';
import type { ActionRow, RecoveryPlan } from '@/packages/domain/types';
import { digest } from '@/packages/payments/security';
import type { OwnedPayment } from './authority';
import type { FulfillmentEvidence } from './disputes';
import type { TrackingCommand } from './evidence';

export const recoveryOperationId=(tenantId:string,planId:string,actionId:string)=>'recovery-'+digest([tenantId,planId,actionId]).slice(0,32);
export function exactPlanHash(plan:Pick<RecoveryPlan,'tenantId'|'id'|'version'|'branch'|'cohortVersion'|'snapshotHash'|'context'|'expiresAt'|'executionMode'|'contractVersion'|'findingDependencyPolicy'|'findingDependencies'>):string {
  const legacy={contractVersion:2,tenantId:plan.tenantId,id:plan.id,version:plan.version,branch:plan.branch,cohortVersion:plan.cohortVersion,
    snapshotHash:plan.snapshotHash,context:plan.context,expiresAt:plan.expiresAt,executionMode:plan.executionMode};
  // Version two hashes are a historical approval boundary and must remain exact.
  return digest(plan.contractVersion===3?{...legacy,contractVersion:3,findingDependencyPolicy:plan.findingDependencyPolicy,findingDependencies:plan.findingDependencies}:legacy);
}
export function freezeAction(tenantId:string,planId:string,action:ActionRow):ActionRow {
  const operationId=recoveryOperationId(tenantId,planId,action.id);
  const payload={...action.payload,operationId};
  if(action.kind==='dispute_response')Object.assign(payload,{
    statement:`Sandbox exercise; synthetic shipping evidence. No physical delivery is asserted. Glasshouse operation ${operationId}. The fixture record for ${action.reference} reports a regional shipping delay. Tracking ${String(action.payload.trackingNumber)}; carrier ${String(action.payload.carrier)}. This submission does not assert a case outcome.`,
    evidenceType:'PROOF_OF_FULFILLMENT',fixtureShipping:true,
  });
  if(action.kind==='tracking')Object.assign(payload,{providerStatus:'SHIPPED',providerStatusMeaning:'Tracking assigned; physical delivery is not asserted.',notifyPayer:false});
  return {...action,payload};
}
export interface RecoveryCommand {
  operationId:string;planId:string;actionId:string;actorId:string;membershipVersion:number;
  action:ActionRow;owned:OwnedPayment;approval:{hash:string;version:number;expiresAt:string};
  payment:PaymentCommand|null;tracking:TrackingCommand|null;evidence:FulfillmentEvidence|null;
}
export type RecoveryIntent=Record<string,unknown>&{
  tenant_id:string;id:string;semantic_key:string;plan_id:string;action_id:string;order_id:string;kind:ActionRow['kind'];
  payload_hash:string;command:RecoveryCommand;status:string;provider_id:string|null;receipt:Record<string,unknown>|null;
  reason:string|null;attempt:number;lease_owner:string|null;lease_until:string|Date|null;
};
export type RecoveryRun=Record<string,unknown>&{
  tenant_id:string;plan_id:string;plan_hash:string;membership_version:number;approved_by:string;
  accepted_revision:number;accepted_resources:Record<string,number>;fixture_acknowledged:boolean;status:string;
};
export function semanticKey(action:ActionRow,owned:OwnedPayment):string {
  if(action.kind==='refund')return `goodwill-delay-v1:${owned.orderId}`;
  if(action.kind==='tracking')return `tracking:${owned.providerOrderId}:${digest([action.payload.trackingNumber,action.payload.carrier]).slice(0,32)}`;
  return `dispute:${action.resourceId}:fulfillment:${digest([action.payload.trackingNumber,action.payload.carrier]).slice(0,32)}`;
}
