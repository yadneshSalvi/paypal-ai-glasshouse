import {z} from 'zod';
import type {Database} from '@/packages/db/client';
import type {Actor,RecoveryPlan,SeedDataset,Snapshot} from '@/packages/domain/types';
import {FINDING_DEPENDENCY_POLICY,type FindingReference,type PlanDependencyReview} from '@/packages/findings/types';
import {recoveryMember} from '../recovery/authority';
import {HttpError} from '../errors';
import {hash} from '../repository';
import {requireFindingsSchema} from './schema';
import {findingService} from './runtime';
import {currentFindingSnapshot,sameSource} from './facts';
import {assertWorkspaceContext,withWorkspaceContext,workspaceContext,type WorkspaceRequestContext} from '../workspaces/authority';

const refSchema=z.array(z.object({findingId:z.string().min(1).max(180),revisionId:z.string().min(1).max(180),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(20).refine(refs=>new Set(refs.map(ref=>ref.findingId)).size===refs.length);
export function parseFindingReferences(raw:unknown):FindingReference[]{const value=refSchema.safeParse(raw??[]);if(!value.success)throw new HttpError(400,'FINDING_DEPENDENCIES_INVALID','Select up to twenty distinct exact finding versions.');return value.data.sort((a,b)=>a.findingId.localeCompare(b.findingId));}
export async function validateFindingReferences(tx:Database,actor:Actor,raw:unknown,snapshot?:Snapshot):Promise<PlanDependencyReview>{
  await requireFindingsSchema(tx);const refs=parseFindingReferences(raw),service=findingService(tx);await service.member(tx,actor);
  const dataset=(await tx.query<{body:SeedDataset}>('SELECT body FROM gh_datasets WHERE tenant_id=$1 FOR SHARE',[actor.tenantId]))[0]?.body;
  if(!dataset)throw new HttpError(409,'FINDING_SOURCE_REQUIRED','Open the source evidence before preparing a recovery.');
  const dependencies:PlanDependencyReview['dependencies']=[];
  for(const ref of refs){
    const {finding,revision}=await service.permitted(tx,actor,ref.findingId,ref.revisionId);
    const shared=!!(await tx.query('SELECT revision_id FROM gh_finding_shares WHERE tenant_id=$1 AND revision_id=$2 AND revision_hash=$3',[actor.tenantId,ref.revisionId,ref.hash]))[0];
    if(revision.hash!==ref.hash)throw new HttpError(409,'FINDING_DEPENDENCY_CHANGED','A finding hash differs from the selected version. Reopen the exact evidence review.');
    if(!shared)throw new HttpError(403,'FINDING_SHARE_REQUIRED','A workspace recovery can reference only a version explicitly shared by its creator. Private conversations stay private.');
    if(finding.current_revision_id!==ref.revisionId||revision.state!=='supported_for_current_scope')throw new HttpError(409,'FINDING_DEPENDENCY_STALE','A selected finding was superseded, challenged, retracted or has not yet been supported. Review its current interpretation before preparing new actions.');
    const current=currentFindingSnapshot(actor,dataset,revision.context);
    if(!sameSource(revision,current)||snapshot&&(revision.context.asOf!==snapshot.context.asOf||revision.context.clockDomain!==snapshot.context.clockDomain||revision.context.currency!==snapshot.context.currency||hash(revision.facts.affectedOrderIds)!==hash(snapshot.affectedOrderIds)))throw new HttpError(409,'FINDING_DEPENDENCY_SCOPE_CHANGED','A selected finding does not support the current source facts and exact action scope.');
    dependencies.push({...ref,title:revision.title,sequence:revision.sequence,state:revision.state,current:true,shared});
  }
  return {policy:FINDING_DEPENDENCY_POLICY,valid:true,checkedAt:new Date().toISOString(),dependencies,reason:null};
}
export async function savePlanFindingReferences(tx:Database,plan:RecoveryPlan){
  if(plan.contractVersion!==3)return;
  for(const ref of plan.findingDependencies??[])await tx.query('INSERT INTO gh_plan_finding_dependencies(tenant_id,plan_id,finding_id,revision_id,revision_hash) VALUES($1,$2,$3,$4,$5)',[plan.tenantId,plan.id,ref.findingId,ref.revisionId,ref.hash]);
}
export async function assertPlanFindingDependencies(tx:Database,actor:Actor,plan:RecoveryPlan){
  if(plan.contractVersion!==3)return; // Preserve the exact legacy approval contract.
  if(plan.findingDependencyPolicy!==FINDING_DEPENDENCY_POLICY||!Array.isArray(plan.findingDependencies))throw new HttpError(409,'FINDING_POLICY_REQUIRED','This manifest does not bind the current finding dependency policy.');
  const rows=await tx.query<{findingId:string;revisionId:string;hash:string}>('SELECT finding_id AS "findingId",revision_id AS "revisionId",revision_hash AS hash FROM gh_plan_finding_dependencies WHERE tenant_id=$1 AND plan_id=$2 ORDER BY finding_id',[actor.tenantId,plan.id]);
  if(hash(rows)!==hash(parseFindingReferences(plan.findingDependencies)))throw new HttpError(409,'FINDING_DEPENDENCY_UNVERIFIED','The saved dependency index and exact approval manifest differ.');
  return validateFindingReferences(tx,actor,plan.findingDependencies);
}

type FindingApprovalAuthority={kind:'workspace_session';context:WorkspaceRequestContext}|{kind:'admitted_legacy_membership'};
export async function bindFindingApprovalAuthority(tx:Database,actor:Actor,plan:RecoveryPlan){
  if(plan.contractVersion!==3)return;const service=findingService(tx),context=workspaceContext(actor),value:FindingApprovalAuthority=context?{kind:'workspace_session',context}:{kind:'admitted_legacy_membership'};
  await tx.query('INSERT INTO gh_plan_finding_authorities(tenant_id,plan_id,actor_id,membership_version,private_document) VALUES($1,$2,$3,$4,$5)',[actor.tenantId,plan.id,actor.id,actor.membershipVersion,service.secrets.seal(actor.tenantId,'approval-authority',plan.id,value)]);
}
export async function assertFindingApprovalAuthority(tx:Database,actor:Actor,plan:RecoveryPlan){
  if(plan.contractVersion!==3)return;
  const row=(await tx.query<{actor_id:string;membership_version:number;private_document:string}>('SELECT actor_id,membership_version,private_document FROM gh_plan_finding_authorities WHERE tenant_id=$1 AND plan_id=$2',[actor.tenantId,plan.id]))[0];
  if(!row||row.actor_id!==plan.approvedBy)throw new HttpError(403,'FINDING_APPROVAL_AUTHORITY_REQUIRED','This exact manifest has no separately recorded current approval authority.');
  await recoveryMember(tx,{...actor,id:row.actor_id,membershipVersion:row.membership_version},true,row.membership_version);
  const service=findingService(tx),value=service.secrets.open<FindingApprovalAuthority>(actor.tenantId,'approval-authority',plan.id,row.private_document);
  if(value.kind==='workspace_session'){
    if(value.context.tenantId!==actor.tenantId||value.context.actorId!==row.actor_id||value.context.membershipVersion!==row.membership_version)throw new HttpError(403,'FINDING_APPROVAL_AUTHORITY_REQUIRED','The saved approval authority does not match its current workspace identity.');
    await assertWorkspaceContext(tx,withWorkspaceContext({...actor,id:row.actor_id,membershipVersion:row.membership_version,role:value.context.role},value.context),true);
  }else if(value.kind!=='admitted_legacy_membership')throw new HttpError(403,'FINDING_APPROVAL_AUTHORITY_REQUIRED','The recorded approval authority could not be verified.');
}
