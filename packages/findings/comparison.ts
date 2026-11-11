import type {FindingRevision,FindingScopeComparison} from './types';

/** Compare only the two authorized endpoint versions. Intermediate private
 * reviews, their reasons and their source-change identities are not consulted. */
export function compareFindingScopes(before:FindingRevision,after:FindingRevision):FindingScopeComparison{
  if(before.findingId!==after.findingId||before.tenantId!==after.tenantId)throw new Error('A finding comparison must retain its workspace and finding identity.');
  const reference=(row:FindingRevision)=>({findingId:row.findingId,revisionId:row.id,hash:row.hash,sequence:row.sequence,cohortVersion:row.cohortVersion,snapshotHash:row.sourceSnapshotHash});
  const previous=new Set(before.facts.affectedOrderIds),current=new Set(after.facts.affectedOrderIds);
  return {basis:'referenced_revision_to_current_permitted_revision',from:reference(before),to:reference(after),beforeCount:before.facts.affectedCount,afterCount:after.facts.affectedCount,
    removedOrderIds:[...previous].filter(id=>!current.has(id)).sort(),addedOrderIds:[...current].filter(id=>!previous.has(id)).sort()};
}
