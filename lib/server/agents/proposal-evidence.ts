import type {RecoveryPlan} from '@/packages/domain/types';
import {exactPlanHash} from '../recovery/contracts';
import {HttpError} from '../errors';
import {bounded} from './security';

/** Exact approval contract, read from storage before disclosure. This evidence
 * never changes approval, policy authority, execution state or provider data. */
export function proposalEvidence(plan:RecoveryPlan){
  if(plan.contractVersion!==2||!plan.context||exactPlanHash(plan)!==plan.hash||plan.branch.snapshotHash!==plan.snapshotHash)throw new HttpError(409,'AGENT_PROPOSAL_UNVERIFIED','The saved proposal does not match its immutable approval contract.');
  const {branch}=plan;
  const manifest={contractVersion:2 as const,tenantId:plan.tenantId,id:plan.id,version:plan.version,branch,cohortVersion:plan.cohortVersion,snapshotHash:plan.snapshotHash,context:plan.context,expiresAt:plan.expiresAt,executionMode:plan.executionMode};
  const evidence={
    id:plan.id,hash:plan.hash,status:plan.status,branch:branch.name,eligibleCount:branch.eligibleCount,refundTotalMinor:branch.refundTotalMinor,budgetMinor:branch.budgetMinor,trackingCount:branch.trackingCount,disputeCount:branch.disputeCount,executionMode:plan.executionMode,snapshotHash:plan.snapshotHash,expiresAt:plan.expiresAt,
    evidenceSource:'saved_immutable_proposal',hashVerified:true,manifest,
    eligibleOrderIds:branch.rows.filter(row=>row.eligible).map(row=>row.orderId),
    excludedOrders:branch.rows.filter(row=>!row.eligible).map(row=>({orderId:row.orderId,reasons:row.excludedReasons})),
    sourceClasses:[...new Set(branch.actions.map(action=>action.sourceClass))].sort(),
    policy:{id:branch.policyId,scenario:branch.id,graceHours:branch.graceHours,refundAmountMinor:branch.amountMinor,currency:branch.currency,comparisonOnly:branch.id==='comprehensive',overrideAuthorization:'not_granted_by_this_tool'},
    approval:{approvedBy:plan.approvedBy,approvedAt:plan.approvedAt,approvalGrantedByThisTool:false,executionStartedByThisTool:false},
    disclosure:branch.id==='comprehensive'?'This is a no-grace comparison scenario, not an authorized policy override. The exact saved proposal still requires separate human policy review and approval; no action was approved or executed by this tool.':'The exact saved 48-hour-grace proposal requires separate human review and approval. No action was approved or executed by this tool.',
  };
  // No partial manifest is described as complete. Oversized proposals need an
  // explicit paginated evidence interface before they can be disclosed here.
  bounded(evidence,650000,'The exact proposal exceeds this bounded agent evidence view. Open the saved review sheet; no truncated manifest was returned.');
  return evidence;
}
