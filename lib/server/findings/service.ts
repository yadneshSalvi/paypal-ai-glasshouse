import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from '@/packages/db/client';
import type {Actor,QueryContext,RecoveryPlan,SeedDataset,Snapshot} from '@/packages/domain/types';
import type {AgentFinding} from '@/packages/agents/contracts';
import type {FindingCreate,FindingDecision,FindingDelta,FindingDetail,FindingList,FindingReference,FindingRevision,FindingSummary,FindingCorrection,SourceChange} from '@/packages/findings/types';
import {buildSnapshot} from '@/packages/domain';
import {hash,storePlan,audit} from '../repository';
import {HttpError} from '../errors';
import {recoveryMember} from '../recovery/authority';
import {assertWorkspaceRequestWrite} from '../workspaces/authority';
import {AgentSecrets} from '../agents/security';
import {FindingSecrets} from './crypto';
import {requireFindingsSchema} from './schema';
import {cite,currentFindingSnapshot,findingFacts,sameSource,sourceFingerprint} from './facts';

const id=z.string().min(1).max(180).regex(/^[A-Za-z0-9_:-]+$/),fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const text=(min:number,max:number)=>z.string().trim().min(min).max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const evidenceIds=z.array(id).max(80);
const createSchema=z.object({requestId:z.uuid(),snapshotHash:fingerprint,title:text(2,160),interpretation:text(10,5000),counterpoint:text(5,3000),evidenceIds:evidenceIds.min(1),counterEvidenceIds:evidenceIds.default([]),reason:text(5,1200)}).strict();
const decisionSchema=z.object({requestId:z.uuid(),expectedRevisionId:id,expectedHash:fingerprint,action:z.enum(['support','challenge','revise','retract']),reason:text(5,2000),snapshotHash:fingerprint.optional(),title:text(2,160).optional(),interpretation:text(10,5000).optional(),counterpoint:text(5,3000).optional(),evidenceIds:evidenceIds.optional(),counterEvidenceIds:evidenceIds.optional()}).strict();
const shareSchema=z.object({requestId:z.uuid(),revisionId:id,hash:fingerprint}).strict();
const adoptSchema=z.object({requestId:z.uuid(),documentId:id,documentHash:fingerprint,reason:text(5,1200)}).strict();
export type FindingRow=Record<string,unknown>&{tenant_id:string;id:string;creator_id:string;origin_document_id:string|null;current_revision_id:string;current_sequence:number;created_at:Date};
export type RevisionRow=Record<string,unknown>&{tenant_id:string;id:string;finding_id:string;sequence:number;previous_id:string|null;revision_hash:string;snapshot_hash:string;cohort_version:number;actor_id:string;state:FindingRevision['state'];private_document:string};
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new HttpError(400,'FINDING_REQUEST_INVALID','Use the exact current revision, a reason and permitted source records. Review text has a bounded length.');return result.data;};
export const findingReference=(revision:FindingRevision):FindingReference=>({findingId:revision.findingId,revisionId:revision.id,hash:revision.hash});
export const findingHash=(revision:Omit<FindingRevision,'hash'>|FindingRevision)=>{const {hash:unused,...body}=revision as FindingRevision;void unused;return hash(body);};

export class FindingService {
  constructor(readonly db:Database,readonly secrets:FindingSecrets,readonly agentSecrets:AgentSecrets){}
  async member(tx:Database,actor:Actor,write=false){
    if(write)await assertWorkspaceRequestWrite(tx,actor);
    const current=await recoveryMember(tx,actor);
    if(current.role!==actor.role)throw new HttpError(403,'CURRENT_AUTHORITY_REQUIRED','Your finding review role changed. Reopen the current workspace.');
    return current;
  }
  unpack(row:RevisionRow){
    const revision=this.secrets.open<FindingRevision>(row.tenant_id,'revision',row.id,row.private_document);
    if(revision.id!==row.id||revision.findingId!==row.finding_id||revision.tenantId!==row.tenant_id||revision.workspaceId!==row.tenant_id||revision.sequence!==row.sequence||revision.previousRevisionId!==row.previous_id||revision.hash!==row.revision_hash||revision.sourceSnapshotHash!==row.snapshot_hash||revision.cohortVersion!==row.cohort_version||revision.actorId!==row.actor_id||revision.state!==row.state||findingHash(revision)!==row.revision_hash)throw new HttpError(409,'FINDING_UNVERIFIED','This finding does not match its immutable source identity. The original is preserved.');
    return revision;
  }
  async resources(tx:Database,actor:Actor,revision:FindingRevision){
    const refs=revision.dependencies.resources;if(!refs.length)return;
    const rows=await tx.query<{kind:string;provider_id:string;order_id:string;active:boolean;body:Record<string,unknown>}>('SELECT kind,provider_id,order_id,active,body FROM gh_provider_resources WHERE tenant_id=$1 AND provider_id=ANY($2::text[]) FOR SHARE',[actor.tenantId,refs.map(row=>row.id)]);
    for(const ref of refs){const row=rows.find(row=>row.kind===ref.kind&&row.provider_id===ref.id);if(!row?.active||row.order_id!==ref.orderId||actor.allowedResourceIds&&!actor.allowedResourceIds.includes(ref.id)||ref.kind==='dispute'&&!refs.some(capture=>capture.kind==='capture'&&capture.orderId===ref.orderId&&capture.id===row.body.captureId))throw new HttpError(403,'FINDING_RESOURCE_ACCESS_CHANGED','A source resource in this finding is no longer permitted. Its saved evidence is preserved.');}
  }
  async permitted(tx:Database,actor:Actor,findingId:string,revisionId?:string,lock=false){
    const finding=(await tx.query<FindingRow>(`SELECT * FROM gh_findings WHERE tenant_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[actor.tenantId,findingId]))[0];
    if(!finding)throw new HttpError(404,'FINDING_NOT_FOUND','This finding is not available in the current workspace.');
    const rows=await tx.query<RevisionRow>(`SELECT r.* FROM gh_finding_revisions r WHERE r.tenant_id=$1 AND r.finding_id=$2 ${revisionId?'AND r.id=$4':''} AND ($3=true OR EXISTS(SELECT 1 FROM gh_finding_shares s WHERE s.tenant_id=r.tenant_id AND s.revision_id=r.id AND s.revision_hash=r.revision_hash)) ORDER BY r.sequence DESC LIMIT 1`,revisionId?[actor.tenantId,findingId,finding.creator_id===actor.id,revisionId]:[actor.tenantId,findingId,finding.creator_id===actor.id]);
    if(!rows[0])throw new HttpError(404,'FINDING_NOT_FOUND','This finding version is not available in the current workspace.');
    const revision=this.unpack(rows[0]);await this.resources(tx,actor,revision);return {finding,revision};
  }
  async admitted(tx:Database,actor:Actor,snapshotHash:string){
    const saved=(await tx.query<{context:QueryContext}>('SELECT context FROM gh_snapshots WHERE tenant_id=$1 AND hash=$2',[actor.tenantId,snapshotHash]))[0];
    if(!saved||saved.context.roleScope!==actor.role||saved.context.rolePolicyVersion!==`roles-v1:${actor.membershipVersion}`)throw new HttpError(409,'FINDING_SCOPE_CHANGED','Open this evidence under your current workspace role before reviewing it.');
    const dataset=await this.dataset(tx,actor.tenantId);const snapshot=buildSnapshot(dataset,saved.context);
    if(snapshot.hash!==snapshotHash)throw new HttpError(409,'FINDING_SOURCE_CHANGED','The selected evidence changed. Refresh the snapshot before recording a separate decision.');
    return {snapshot,dataset};
  }
  async dataset(tx:Database,tenantId:string,write=true){const dataset=(await tx.query<{body:SeedDataset}>(`SELECT body FROM gh_datasets WHERE tenant_id=$1 FOR ${write?'UPDATE':'SHARE'}`,[tenantId]))[0]?.body;if(!dataset)throw new HttpError(409,'FINDING_SOURCE_REQUIRED','Open a complete source snapshot before reviewing findings.');return dataset;}
  draft(actor:Actor,snapshot:Snapshot,input:Pick<FindingCreate,'title'|'interpretation'|'counterpoint'|'evidenceIds'|'counterEvidenceIds'|'reason'>,options:{findingId?:string;creatorId?:string;previous?:FindingRevision;event?:FindingRevision['event'];state?:FindingRevision['state'];delta?:FindingDelta;origin?:FindingRevision['origin']}={}):FindingRevision{
    const previous=options.previous,facts=findingFacts(snapshot),citations=cite(snapshot,input.evidenceIds,input.counterEvidenceIds,previous?.citations);
    const orderIds=[...new Set([...facts.scopeOrderIds,...citations.map(row=>row.orderId).filter((value):value is string=>!!value)])].sort();
    const resources:FindingRevision['dependencies']['resources']=[];
    for(const order of snapshot.orders.filter(row=>orderIds.includes(row.id)&&row.paymentSource==='sandbox')){if(order.paypalOrderId)resources.push({kind:'order',id:order.paypalOrderId,orderId:order.id});if(order.captureId)resources.push({kind:'capture',id:order.captureId,orderId:order.id});if(order.disputeSource==='sandbox'&&order.disputeId)resources.push({kind:'dispute',id:order.disputeId,orderId:order.id});}
    const state=options.state??'proposed';
    const value:FindingRevision={schemaVersion:1,id:'frev-'+randomUUID(),findingId:options.findingId??previous?.findingId??'finding-'+randomUUID(),tenantId:actor.tenantId,workspaceId:actor.tenantId,merchantId:actor.tenantId,
      sequence:(previous?.sequence??0)+1,previousRevisionId:previous?.id??null,previousHash:previous?.hash??null,hash:'',creatorId:options.creatorId??previous?.creatorId??actor.id,actorId:actor.id,actorRole:actor.role,createdAt:new Date().toISOString(),state,event:options.event??'created',
      title:input.title,interpretation:input.interpretation,counterpoint:input.counterpoint,reason:input.reason,interpretationReview:state==='supported_for_current_scope'?'supported_for_scope':state==='retracted'?'retracted':'required',
      sourceSnapshotId:snapshot.id,sourceSnapshotHash:snapshot.hash,context:snapshot.context,cohortVersion:snapshot.context.cohortVersion,facts,citations,sourceCoverage:snapshot.sourceCoverage,
      dependencies:{orderIds,sourceEventIds:[...new Set(citations.flatMap(row=>[...row.supports,...row.contradicts]))].sort(),evidenceIds:citations.map(row=>row.id).sort(),fingerprint:sourceFingerprint(snapshot,orderIds,citations.map(row=>row.id)),resources},
      delta:options.delta??null,openChallengeRevisionId:options.event==='source_revised'?(previous?.openChallengeRevisionId??(previous?.state==='challenged'?previous.id:null)):null,resolvedChallengeRevisionId:options.event!=='source_revised'&&state!=='challenged'?(previous?.openChallengeRevisionId??(previous?.state==='challenged'?previous.id:null)):null,
      origin:options.origin??previous?.origin??{kind:'human',documentId:null,documentHash:null,legacyCohortRevision:null}};
    if(state==='challenged')value.openChallengeRevisionId=value.id;value.hash=findingHash(value);return value;
  }
  async append(tx:Database,revision:FindingRevision,originDocumentId?:string|null){
    if(Buffer.byteLength(JSON.stringify(revision))>1_500_000)throw new HttpError(413,'FINDING_SIZE_LIMIT','This finding exceeds the complete evidence bound. Narrow the citations; nothing was partially saved.');
    if(!revision.previousRevisionId)await tx.query('INSERT INTO gh_findings(tenant_id,id,creator_id,origin_document_id,current_revision_id,current_sequence,created_at) VALUES($1,$2,$3,$4,$5,1,$6)',[revision.tenantId,revision.findingId,revision.creatorId,originDocumentId??null,revision.id,revision.createdAt]);
    await tx.query('INSERT INTO gh_finding_revisions(tenant_id,id,finding_id,sequence,previous_id,revision_hash,snapshot_hash,cohort_version,actor_id,state,private_document,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[revision.tenantId,revision.id,revision.findingId,revision.sequence,revision.previousRevisionId,revision.hash,revision.sourceSnapshotHash,revision.cohortVersion,revision.actorId,revision.state,this.secrets.seal(revision.tenantId,'revision',revision.id,revision),revision.createdAt]);
    if(revision.previousRevisionId){const moved=await tx.query('UPDATE gh_findings SET current_revision_id=$3,current_sequence=$4 WHERE tenant_id=$1 AND id=$2 AND current_revision_id=$5 AND current_sequence=$6 RETURNING id',[revision.tenantId,revision.findingId,revision.id,revision.sequence,revision.previousRevisionId,revision.sequence-1]);if(!moved.length)throw new HttpError(409,'FINDING_REVISION_CONFLICT','A newer review or source change was saved. Read it before making a separate decision.');}
    await this.event(tx,revision,revision.event,revision.actorId,revision.actorRole,{reason:revision.reason,previousRevisionId:revision.previousRevisionId,hash:revision.hash,delta:revision.delta});
  }
  async event(tx:Database,revision:FindingRevision,kind:string,actorId:string,actorRole:string,value:unknown){const id='fevent-'+randomUUID();await tx.query('INSERT INTO gh_finding_events(tenant_id,id,finding_id,revision_id,event_type,actor_id,actor_role,private_document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[revision.tenantId,id,revision.findingId,revision.id,kind,actorId,actorRole,this.secrets.seal(revision.tenantId,'event',id,{...findingReference(revision),context:revision.context,kind,actorId,actorRole,value})]);}
  private async replay(tx:Database,actor:Actor,requestId:string,input:unknown){
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`finding-command:${actor.tenantId}:${actor.id}:${requestId}`]);
    const saved=(await tx.query<{request_hash:string;revision_id:string}>('SELECT request_hash,revision_id FROM gh_finding_commands WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[actor.tenantId,actor.id,requestId]))[0];
    if(!saved)return null;if(saved.request_hash!==hash(input))throw new HttpError(409,'FINDING_REQUEST_CONFLICT','This request identity already belongs to different content or a different reviewed revision.');
    const row=(await tx.query<RevisionRow>('SELECT * FROM gh_finding_revisions WHERE tenant_id=$1 AND id=$2',[actor.tenantId,saved.revision_id]))[0];
    try{return (await this.permitted(tx,actor,row.finding_id,row.id)).revision;}catch(error){
      // A peer can recover the exact decision they authored on a creator-shared
      // version. This grants no general read/export access to later private work.
      if(!(error instanceof HttpError&&error.status===404)||row.actor_id!==actor.id||!row.previous_id||!['challenged','supported_for_current_scope'].includes(row.state))throw error;
      await this.permitted(tx,actor,row.finding_id,row.previous_id);const revision=this.unpack(row);await this.resources(tx,actor,revision);return revision;
    }
  }
  private async remember(tx:Database,actor:Actor,requestId:string,input:unknown,revisionId:string){await tx.query('INSERT INTO gh_finding_commands(tenant_id,actor_id,request_id,request_hash,revision_id) VALUES($1,$2,$3,$4,$5)',[actor.tenantId,actor.id,requestId,hash(input),revisionId]);}
  async create(actor:Actor,raw:unknown){await requireFindingsSchema(this.db);const input=parse(createSchema,raw);return this.db.transaction(async tx=>{
    await this.member(tx,actor,true);await this.dataset(tx,actor.tenantId);const prior=await this.replay(tx,actor,input.requestId,{kind:'create',...input});if(prior)return prior;
    const {snapshot}=await this.admitted(tx,actor,input.snapshotHash),revision=this.draft(actor,snapshot,input);await this.resources(tx,actor,revision);await this.append(tx,revision);await this.remember(tx,actor,input.requestId,{kind:'create',...input},revision.id);return revision;
  });}
  async decide(actor:Actor,findingId:string,raw:unknown){await requireFindingsSchema(this.db);const input:FindingDecision=parse(decisionSchema,raw);return this.db.transaction(async tx=>{
    await this.member(tx,actor,true);const dataset=await this.dataset(tx,actor.tenantId),command={kind:'decision',findingId,...input};const replay=await this.replay(tx,actor,input.requestId,command);if(replay)return replay;
    const {finding,revision:previous}=await this.permitted(tx,actor,findingId,input.expectedRevisionId,true);
    if(finding.current_revision_id!==previous.id||input.expectedHash!==previous.hash)throw new HttpError(409,'FINDING_REVISION_CONFLICT','A newer review or source change was saved. Read it before making a separate decision.');
    if(previous.state==='retracted')throw new HttpError(409,'FINDING_RETRACTED','A retracted finding keeps its history. Record a separately identified finding for a new explanation.');
    if(['revise','retract'].includes(input.action)&&finding.creator_id!==actor.id)throw new HttpError(403,'FINDING_CREATOR_REQUIRED','Only the finding creator can replace or retract its interpretation. Record a challenge for the creator to resolve.');
    if(input.action==='support'&&previous.state==='supported_for_current_scope')throw new HttpError(409,'FINDING_ALREADY_SUPPORTED','This exact version is already supported. A changed decision needs a challenge or a revision.');
    const current=currentFindingSnapshot(actor,dataset,previous.context);
    if(input.action==='support'&&!sameSource(previous,current))throw new HttpError(409,'FINDING_SOURCE_CHANGED','Current source facts differ from this version. Review a revised finding before supporting it.');
    let snapshot=buildSnapshot(dataset,previous.context);
    if(input.action==='revise'||input.action==='challenge'&&input.snapshotHash){if(!input.snapshotHash)throw new HttpError(400,'FINDING_SOURCE_REQUIRED','Select the current evidence snapshot for this revision.');snapshot=(await this.admitted(tx,actor,input.snapshotHash)).snapshot;}
    if(input.action==='revise'&&(!input.interpretation||!input.counterpoint||!input.evidenceIds?.length))throw new HttpError(400,'FINDING_REVISION_INCOMPLETE','A revision needs its own interpretation, counterpoint and source citations.');
    if(input.action!=='revise'&&(input.title||input.interpretation||input.counterpoint||input.evidenceIds)||!['revise','challenge'].includes(input.action)&&input.counterEvidenceIds)throw new HttpError(400,'FINDING_DECISION_FIELDS','Only a revision may replace the interpretation or supporting sources.');
    const state={support:'supported_for_current_scope',challenge:'challenged',revise:'revised',retract:'retracted'} as const;
    const evidence=previous.citations.filter(row=>row.relation==='supports').map(row=>row.id),counter=previous.citations.filter(row=>row.relation==='contradicts').map(row=>row.id);
    const counterIds=input.action==='challenge'?[...new Set([...counter,...input.counterEvidenceIds??[]])]:input.counterEvidenceIds??counter;
    const selected=input.action==='revise'?input.evidenceIds!:evidence.filter(value=>!counterIds.includes(value));
    const revision=this.draft(actor,snapshot,{title:input.title??previous.title,interpretation:input.interpretation??previous.interpretation,counterpoint:input.counterpoint??previous.counterpoint,evidenceIds:selected,counterEvidenceIds:counterIds,reason:input.reason},{previous,state:state[input.action],event:{support:'supported',challenge:'challenged',revise:'revised',retract:'retracted'}[input.action] as FindingRevision['event']});
    const staleIds=await invalidateFindingPlans(tx,actor,previous,`Finding ${input.action==='challenge'?'challenged':input.action==='retract'?'retracted':'superseded'} by a separately recorded decision.`,revision.id);
    revision.delta={beforeCount:previous.facts.affectedCount,afterCount:revision.facts.affectedCount,removedOrderIds:previous.facts.affectedOrderIds.filter(id=>!revision.facts.affectedOrderIds.includes(id)),addedOrderIds:revision.facts.affectedOrderIds.filter(id=>!previous.facts.affectedOrderIds.includes(id)),changedOrderIds:[],staleDependentPlanIds:staleIds,sourceChangeId:null};revision.hash=findingHash(revision);
    await this.resources(tx,actor,revision);await this.append(tx,revision);await this.remember(tx,actor,input.requestId,command,revision.id);return revision;
  });}
  async share(actor:Actor,findingId:string,raw:unknown){await requireFindingsSchema(this.db);const input=parse(shareSchema,raw);return this.db.transaction(async tx=>{
    await this.member(tx,actor,true);await this.dataset(tx,actor.tenantId);const command={kind:'share',findingId,...input},replay=await this.replay(tx,actor,input.requestId,command);if(replay)return replay;
    const {finding,revision}=await this.permitted(tx,actor,findingId,input.revisionId,true);
    if(finding.creator_id!==actor.id)throw new HttpError(403,'FINDING_CREATOR_REQUIRED','Only the creator can share a defined finding version. Workspace membership does not grant access to another person’s conversations.');
    if(input.hash!==revision.hash)throw new HttpError(409,'FINDING_REVISION_CONFLICT','The version selected for sharing changed. Review its exact saved hash.');
    const inserted=await tx.query('INSERT INTO gh_finding_shares(tenant_id,revision_id,revision_hash,shared_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING revision_id',[actor.tenantId,revision.id,revision.hash,actor.id]);
    if(inserted.length){await this.event(tx,revision,'shared',actor.id,actor.role,{scope:'current_workspace_members',revisionHash:revision.hash});await audit(tx,actor,'finding.shared','A defined finding version was shared with this workspace',revision.findingId,{revisionId:revision.id,hash:revision.hash});}
    await this.remember(tx,actor,input.requestId,command,revision.id);return revision;
  });}
  async adopt(actor:Actor,raw:unknown){await requireFindingsSchema(this.db);const input=parse(adoptSchema,raw);return this.db.transaction(async tx=>{
    await this.member(tx,actor,true);await this.dataset(tx,actor.tenantId);const command={kind:'adopt',...input},replay=await this.replay(tx,actor,input.requestId,command);if(replay)return replay;
    const row=(await tx.query<{id:string;run_id:string;snapshot_hash:string;private_document:string}>(`SELECT d.* FROM gh_agent_documents d JOIN gh_agent_runs r ON r.tenant_id=d.tenant_id AND r.id=d.run_id WHERE d.tenant_id=$1 AND d.id=$2 AND d.kind='finding' AND r.actor_id=$3`,[actor.tenantId,input.documentId,actor.id]))[0];
    if(!row)throw new HttpError(404,'FINDING_NOT_FOUND','This original finding is not owned by the current membership.');
    const old=this.agentSecrets.open<AgentFinding>(actor.tenantId,'document',row.id,row.private_document);
    if(hash(old)!==input.documentHash||old.id!==row.id||old.runId!==row.run_id||old.snapshotHash!==row.snapshot_hash)throw new HttpError(409,'FINDING_LEGACY_UNVERIFIED','The legacy document does not match the exact original selected for review.');
    const existing=(await tx.query<FindingRow>('SELECT * FROM gh_findings WHERE tenant_id=$1 AND origin_document_id=$2',[actor.tenantId,row.id]))[0];
    if(existing){const {revision}=await this.permitted(tx,actor,existing.id);await this.remember(tx,actor,input.requestId,command,revision.id);return revision;}
    const context=(await tx.query<{context:QueryContext}>('SELECT context FROM gh_snapshots WHERE tenant_id=$1 AND hash=$2',[actor.tenantId,old.snapshotHash]))[0]?.context;
    if(!context)throw new HttpError(409,'FINDING_LEGACY_UNVERIFIED','The original finding’s admitted snapshot is unavailable. Its encrypted document is preserved.');
    const snapshot=buildSnapshot(await this.dataset(tx,actor.tenantId),context);
    if(snapshot.hash!==old.snapshotHash||old.revision!==context.cohortVersion||old.evidence.some(source=>hash(snapshot.evidence.find(row=>row.id===source.id))!==source.hash))throw new HttpError(409,'FINDING_LEGACY_UNVERIFIED','The original source hashes no longer verify. The original document has not been rewritten.');
    const revision=this.draft(actor,snapshot,{title:old.title,interpretation:old.interpretation,counterpoint:old.counterpoint,evidenceIds:old.evidence.map(row=>row.id),counterEvidenceIds:[],reason:input.reason},{event:'legacy_adopted',origin:{kind:'legacy',documentId:old.id,documentHash:hash(old),legacyCohortRevision:old.revision}});
    await this.resources(tx,actor,revision);await this.append(tx,revision,old.id);await this.remember(tx,actor,input.requestId,command,revision.id);return revision;
  });}
  async recordAgent(tx:Database,actor:Actor,finding:AgentFinding,snapshot:Snapshot){
    await requireFindingsSchema(tx);await this.dataset(tx,actor.tenantId);
    const existing=(await tx.query<FindingRow>('SELECT * FROM gh_findings WHERE tenant_id=$1 AND origin_document_id=$2',[actor.tenantId,finding.id]))[0];if(existing)return (await this.permitted(tx,actor,existing.id)).revision;
    const revision=this.draft(actor,snapshot,{title:finding.title,interpretation:finding.interpretation,counterpoint:finding.counterpoint,evidenceIds:finding.evidence.map(row=>row.id),counterEvidenceIds:[],reason:'Agent proposed a sourced interpretation. Human support and explicit version sharing remain separate.'},{origin:{kind:'agent',documentId:finding.id,documentHash:hash(finding),legacyCohortRevision:finding.revision}});
    await this.resources(tx,actor,revision);await this.append(tx,revision,finding.id);return revision;
  }
  async summary(tx:Database,actor:Actor,finding:FindingRow,revision:FindingRevision,dataset:SeedDataset):Promise<FindingSummary>{
    const shared=!!(await tx.query('SELECT revision_id FROM gh_finding_shares WHERE tenant_id=$1 AND revision_id=$2 AND revision_hash=$3',[actor.tenantId,revision.id,revision.hash]))[0],isCurrent=finding.current_revision_id===revision.id,currentSource=sameSource(revision,currentFindingSnapshot(actor,dataset,revision.context));
    const writable=actor.role!=='viewer'&&(await tx.query<{status:string}>('SELECT status FROM gh_workspaces WHERE tenant_id=$1',[actor.tenantId]))[0]?.status!=='archived';
    return {...findingReference(revision),title:revision.title,sequence:revision.sequence,state:revision.state,creatorId:revision.creatorId,actorId:revision.actorId,createdAt:revision.createdAt,affectedCount:revision.facts.affectedCount,cohortVersion:revision.cohortVersion,sourceSnapshotHash:revision.sourceSnapshotHash,isCurrent,shared,currentSource,canReview:writable&&isCurrent&&revision.state!=='retracted',canEdit:writable&&finding.creator_id===actor.id&&isCurrent&&revision.state!=='retracted',canShare:writable&&finding.creator_id===actor.id&&!shared};
  }
  async list(actor:Actor,cursor?:string,includeLegacy=true):Promise<FindingList>{await requireFindingsSchema(this.db);if(cursor&&!id.safeParse(cursor).success)throw new HttpError(400,'FINDING_CURSOR_INVALID','Use a finding cursor from this workspace.');return this.db.transaction(async tx=>{
    await this.member(tx,actor);const dataset=await this.dataset(tx,actor.tenantId,false);
    if(cursor)await this.permitted(tx,actor,cursor);
    const rows=await tx.query<FindingRow>(`SELECT f.* FROM gh_findings f WHERE f.tenant_id=$1 AND (f.creator_id=$2 OR EXISTS(SELECT 1 FROM gh_finding_revisions r JOIN gh_finding_shares s ON s.tenant_id=r.tenant_id AND s.revision_id=r.id WHERE r.tenant_id=f.tenant_id AND r.finding_id=f.id)) ${cursor?'AND (f.created_at,f.id)<(SELECT created_at,id FROM gh_findings WHERE tenant_id=$1 AND id=$3)':''} ORDER BY f.created_at DESC,f.id DESC LIMIT 31`,cursor?[actor.tenantId,actor.id,cursor]:[actor.tenantId,actor.id]);
    const findings:FindingSummary[]=[];for(const row of rows.slice(0,30)){const {revision}=await this.permitted(tx,actor,row.id);findings.push(await this.summary(tx,actor,row,revision,dataset));}
    const legacy:FindingList['legacy']=[];
    if(includeLegacy){const docs=await tx.query<{id:string;private_document:string}>(`SELECT d.id,d.private_document FROM gh_agent_documents d JOIN gh_agent_runs r ON r.tenant_id=d.tenant_id AND r.id=d.run_id WHERE d.tenant_id=$1 AND r.actor_id=$2 AND d.kind='finding' AND NOT EXISTS(SELECT 1 FROM gh_findings f WHERE f.tenant_id=d.tenant_id AND f.origin_document_id=d.id) ORDER BY d.created_at DESC LIMIT 30`,[actor.tenantId,actor.id]);for(const row of docs){const old=this.agentSecrets.open<AgentFinding>(actor.tenantId,'document',row.id,row.private_document);legacy.push({documentId:row.id,documentHash:hash(old),title:old.title,createdAt:old.createdAt,snapshotHash:old.snapshotHash,cohortRevision:old.revision,explanation:'Legacy revision is a cohort version; no human review sequence was recorded.'});}}
    return {findings,legacy,hasMore:rows.length>30,nextCursor:rows.length>30?rows[29].id:null};
  });}
  async detail(actor:Actor,findingId:string,revisionId?:string):Promise<FindingDetail>{await requireFindingsSchema(this.db);return this.db.transaction(async tx=>{
    await this.member(tx,actor);
    // Reject foreign/private identities before requiring source initialization,
    // then take the dataset lock before any resource-grant lock.
    const visible=await tx.query(`SELECT f.id FROM gh_findings f WHERE f.tenant_id=$1 AND f.id=$2 AND (f.creator_id=$3 OR EXISTS(SELECT 1 FROM gh_finding_revisions r JOIN gh_finding_shares s ON s.tenant_id=r.tenant_id AND s.revision_id=r.id AND s.revision_hash=r.revision_hash WHERE r.tenant_id=f.tenant_id AND r.finding_id=f.id))`,[actor.tenantId,findingId,actor.id]);
    if(!visible.length)throw new HttpError(404,'FINDING_NOT_FOUND','This finding is not available in the current workspace.');
    const dataset=await this.dataset(tx,actor.tenantId,false),{finding,revision}=await this.permitted(tx,actor,findingId,revisionId);
    const rows=await tx.query<RevisionRow>('SELECT r.* FROM gh_finding_revisions r WHERE r.tenant_id=$1 AND r.finding_id=$2 AND ($3=true OR EXISTS(SELECT 1 FROM gh_finding_shares s WHERE s.tenant_id=r.tenant_id AND s.revision_id=r.id)) ORDER BY r.sequence DESC',[actor.tenantId,findingId,finding.creator_id===actor.id]);
    const revisions:FindingSummary[]=[];for(const row of rows){const value=this.unpack(row);await this.resources(tx,actor,value);revisions.push(await this.summary(tx,actor,finding,value,dataset));}
    const plans=await tx.query<{id:string;hash:string;status:string;createdAt:string;dependencyRevisionId:string;invalidated:boolean}>(`SELECT p.id,p.plan_hash AS hash,p.status,p.body->>'createdAt' AS "createdAt",d.revision_id AS "dependencyRevisionId",EXISTS(SELECT 1 FROM gh_plan_dependency_invalidations i WHERE i.tenant_id=p.tenant_id AND i.plan_id=p.id) AS invalidated FROM gh_plan_finding_dependencies d JOIN gh_plans p ON p.tenant_id=d.tenant_id AND p.id=d.plan_id WHERE d.tenant_id=$1 AND d.finding_id=$2 ORDER BY p.created_at DESC`,[actor.tenantId,findingId]);
    return {revision,summary:await this.summary(tx,actor,finding,revision,dataset),revisions,plans,corrections:await this.correctionsIn(tx,actor,[findingReference(revision)],dataset),correctionMoment:await this.correctionMoment(tx,revision)};
  });}
  async correctionMoment(tx:Database,revision:FindingRevision):Promise<FindingDetail['correctionMoment']>{
    const delta=revision.delta;if(revision.event!=='source_revised'||!delta?.sourceChangeId||delta.beforeCount!==63||delta.afterCount!==54||new Set(delta.removedOrderIds).size!==9||delta.addedOrderIds.length||!delta.staleDependentPlanIds.length)return null;
    const row=(await tx.query<{private_document:string}>('SELECT private_document FROM gh_finding_source_changes WHERE tenant_id=$1 AND id=$2',[revision.tenantId,delta.sourceChangeId]))[0];if(!row)return null;
    const change=this.secrets.open<SourceChange>(revision.tenantId,'source-change',delta.sourceChangeId,row.private_document);
    if(!change.revisions.some(ref=>ref.revisionId===revision.id&&ref.hash===revision.hash)||hash(change.removedOrderIds)!==hash([...delta.removedOrderIds].sort())||!delta.staleDependentPlanIds.every(id=>change.staleDependentPlanIds.includes(id)))return null;
    return {sourceChangeId:change.id,revisionId:revision.id,removedOrderIds:delta.removedOrderIds,stalePlanIds:delta.staleDependentPlanIds};
  }
  async correctionsIn(tx:Database,actor:Actor,refs:FindingReference[],dataset?:SeedDataset):Promise<FindingCorrection[]>{
    const corrections:FindingCorrection[]=[];for(const ref of refs){
      let current:Awaited<ReturnType<FindingService['permitted']>>;
      try{current=await this.permitted(tx,actor,ref.findingId,ref.revisionId);}catch(error){if(error instanceof HttpError&&error.status===404)continue;throw error;}
      if(current.revision.hash!==ref.hash)throw new HttpError(409,'FINDING_UNVERIFIED','The saved finding reference no longer verifies.');
      const {finding,revision}=current;if(finding.current_revision_id===revision.id&&revision.state!=='challenged'&&revision.state!=='retracted')continue;
      let later:FindingRevision|null=null;try{later=(await this.permitted(tx,actor,ref.findingId,finding.current_revision_id)).revision;}catch(error){if(!(error instanceof HttpError&&error.status===404))throw error;}
      // A later private interpretation is never a correction-notice payload.
      // Shared readers can see only the status of their already shared version.
      corrections.push({findingId:ref.findingId,revisionId:revision.id,revisionHash:revision.hash,currentRevisionId:later?.id??null,reason:later?.reason??'A later review or source change superseded this shared version. Its creator has not shared the later interpretation.',createdAt:later?.createdAt??revision.createdAt,state:later?.state??'superseded',delta:later?.delta??null});
    }void dataset;return corrections;
  }
}

export async function invalidateFindingPlans(tx:Database,actor:Pick<Actor,'tenantId'|'id'>,previous:FindingRevision,reason:string,causeId:string,ownPlanId?:string){
  const plans=await tx.query<{body:RecoveryPlan}>(`SELECT p.body FROM gh_plans p JOIN gh_plan_finding_dependencies d ON d.tenant_id=p.tenant_id AND d.plan_id=p.id WHERE p.tenant_id=$1 AND d.revision_id=$2 AND p.id<>$3 AND p.status IN ('draft','ready_for_review','approved','executing','partially_complete') ORDER BY p.id FOR UPDATE OF p`,[actor.tenantId,previous.id,ownPlanId??'']);
  for(const {body:plan} of plans){await storePlan(tx,{...plan,status:'stale',staleReason:reason});await tx.query('INSERT INTO gh_plan_dependency_invalidations(tenant_id,id,plan_id,finding_id,revision_id,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[actor.tenantId,'pinv-'+hash([causeId,plan.id,previous.id]).slice(0,36),plan.id,previous.findingId,previous.id,reason]);}
  return plans.map(row=>row.body.id).sort();
}
