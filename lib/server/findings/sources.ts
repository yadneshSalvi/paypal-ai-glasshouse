import type {Database} from '@/packages/db/client';
import type {Actor,RecoveryPlan,SeedDataset} from '@/packages/domain/types';
import type {FindingRevision,SourceChange} from '@/packages/findings/types';
import {hash,storePlan,audit} from '../repository';
import {hasFindingsSchema} from './schema';
import {findingService} from './runtime';
import {currentFindingSnapshot,changedSourceOrders,sameSource} from './facts';
import {findingHash,findingReference,invalidateFindingPlans,type FindingRow,type RevisionRow} from './service';

/** Called inside the source writer's existing dataset-lock transaction. Its
 * complete before/after inputs are server projections, never browser deltas. */
export async function recordFindingSourceChange(tx:Database,actor:Actor,before:SeedDataset,after:SeedDataset,input:{kind:string;reason:string;sourceId:string;ownPlanId?:string}):Promise<SourceChange|null>{
  if(before.tenantId!==after.tenantId||actor.tenantId!==after.tenantId)throw new Error('Finding source changes cannot cross workspace/merchant boundaries.');
  if(!await hasFindingsSchema(tx))return null; // Additive migration compatibility for old source writers.
  const service=findingService(tx),oldSnapshot=currentFindingSnapshot(actor,before),newSnapshot=currentFindingSnapshot(actor,after);
  const sourceHash=hash({kind:input.kind,sourceId:input.sourceId,before:oldSnapshot.hash,after:newSnapshot.hash});
  const saved=(await tx.query<{id:string;private_document:string}>('SELECT id,private_document FROM gh_finding_source_changes WHERE tenant_id=$1 AND source_hash=$2',[actor.tenantId,sourceHash]))[0];
  if(saved)return service.secrets.open<SourceChange>(actor.tenantId,'source-change',saved.id,saved.private_document);
  const changedOrderIds=changedSourceOrders(oldSnapshot,newSnapshot),sourceId='fsource-'+sourceHash.slice(0,36);
  const rows=await tx.query<FindingRow&{revision:RevisionRow}>(`SELECT f.*,row_to_json(r) AS revision FROM gh_findings f JOIN gh_finding_revisions r ON r.tenant_id=f.tenant_id AND r.id=f.current_revision_id WHERE f.tenant_id=$1 AND r.state<>'retracted' ORDER BY f.id FOR UPDATE OF f`,[actor.tenantId]);
  const prepared:{previous:FindingRevision;next:FindingRevision}[]=[];
  for(const row of rows){
    const previous=service.unpack(row.revision),current=currentFindingSnapshot(actor,after,previous.context);
    if(sameSource(previous,current))continue;
    const newCitations=current.evidence.filter(source=>!previous.dependencies.evidenceIds.includes(source.id)&&(source.orderId&&previous.dependencies.orderIds.includes(source.orderId)||source.contradicts.some(id=>previous.dependencies.evidenceIds.includes(id)))&&!before.evidence.some(old=>old.id===source.id));
    const support=previous.citations.filter(row=>row.relation==='supports').map(row=>row.id),counter=previous.citations.filter(row=>row.relation==='contradicts').map(row=>row.id);
    for(const citation of newCitations.slice(0,Math.max(0,80-support.length-counter.length))){if(citation.kind==='contradiction'||citation.contradicts.length)counter.push(citation.id);else support.push(citation.id);}
    const next=service.draft(actor,current,{title:previous.title,interpretation:previous.interpretation,counterpoint:previous.counterpoint,evidenceIds:support,counterEvidenceIds:counter,reason:input.reason+' The factual scope changed; the interpretation needs a separate human review.'},{previous,event:'source_revised',state:'revised'});
    next.actorRole='source';next.delta={beforeCount:previous.facts.affectedCount,afterCount:next.facts.affectedCount,removedOrderIds:previous.facts.affectedOrderIds.filter(id=>!next.facts.affectedOrderIds.includes(id)).sort(),addedOrderIds:next.facts.affectedOrderIds.filter(id=>!previous.facts.affectedOrderIds.includes(id)).sort(),changedOrderIds:changedOrderIds.filter(id=>next.dependencies.orderIds.includes(id)||previous.dependencies.orderIds.includes(id)),staleDependentPlanIds:[],sourceChangeId:sourceId};
    prepared.push({previous,next});
  }
  if(!changedOrderIds.length&&!prepared.length)return null;
  const staleIds=new Set<string>();
  for(const {previous,next} of prepared){const ids=await invalidateFindingPlans(tx,actor,previous,input.reason,sourceId);for(const id of ids)staleIds.add(id);next.delta!.staleDependentPlanIds=ids;}
  // Source-only proposals also retain explicit invalidation. An already approved
  // operation's own receipt advances only that original saga's existing fence.
  const plans=await tx.query<{body:RecoveryPlan}>("SELECT body FROM gh_plans WHERE tenant_id=$1 AND id<>$2 AND status IN ('draft','ready_for_review','approved','executing','partially_complete') ORDER BY id FOR UPDATE",[actor.tenantId,input.ownPlanId??'']);
  for(const {body:plan} of plans){if(!plan.branch.actions.some(action=>changedOrderIds.includes(action.orderId)))continue;await storePlan(tx,{...plan,status:'stale',staleReason:input.reason});staleIds.add(plan.id);await tx.query('INSERT INTO gh_plan_dependency_invalidations(tenant_id,id,plan_id,source_change_id,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[actor.tenantId,'pinv-'+hash([sourceId,plan.id]).slice(0,36),plan.id,sourceId,input.reason]);}
  for(const {next} of prepared){next.delta!.staleDependentPlanIds=[...new Set([...next.delta!.staleDependentPlanIds,...staleIds])].sort();next.hash=findingHash(next);await service.append(tx,next);}
  const change:SourceChange={id:sourceId,tenantId:actor.tenantId,kind:input.kind,reason:input.reason,createdAt:new Date().toISOString(),actorId:actor.id,beforeSnapshotHash:oldSnapshot.hash,afterSnapshotHash:newSnapshot.hash,previousCohortVersion:before.revision,cohortVersion:after.revision,changedOrderIds,removedOrderIds:oldSnapshot.affectedOrderIds.filter(id=>!newSnapshot.affectedOrderIds.includes(id)).sort(),addedOrderIds:newSnapshot.affectedOrderIds.filter(id=>!oldSnapshot.affectedOrderIds.includes(id)).sort(),revisions:prepared.map(({next})=>findingReference(next)),staleDependentPlanIds:[...staleIds].sort(),ownPlanId:input.ownPlanId??null};
  await tx.query('INSERT INTO gh_finding_source_changes(tenant_id,id,source_hash,private_document) VALUES($1,$2,$3,$4)',[actor.tenantId,sourceId,sourceHash,service.secrets.seal(actor.tenantId,'source-change',sourceId,change)]);
  // Workspace audit contains only source facts and workspace-visible plans, never
  // private finding IDs, interpretations, conversations or model receipts.
  await audit(tx,actor,'source.dependencies_changed','Source facts changed; dependent unstarted work needs review',sourceId,{kind:input.kind,removedOrderIds:change.removedOrderIds,addedOrderIds:change.addedOrderIds,staleDependentPlanIds:change.staleDependentPlanIds});
  return change;
}
