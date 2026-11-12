import {nativePrint} from '@/packages/studio/native-print';
import {isCommerceResourceSemantics} from '@/packages/domain/commerce-resources';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from '@/packages/db/client';
import type {Actor,AuditEvent,Operation,QueryContext,RecoveryPlan,SeedDataset,Snapshot} from '@/packages/domain/types';
import type {AgentFinding} from '@/packages/agents/contracts';
import type {ReportDocument,ReportGrant,ReportList,ReportPaper,ReportRequest,ReportSummary,SavedReport,PdfRepresentation,ReportFindingCorrection} from '@/packages/reports/types';
import type {ReportHistory} from '@/packages/studio/history-saves';
import type {SeedManifest,SeedManifestEntry} from '@/packages/payments/types';
import type {DisputeObservation} from '../recovery/disputes';
import {buildSnapshot} from '@/packages/domain';
import {historyCounts} from '@/packages/reports/semantics';
import {digest} from '@/packages/payments/security';
import {audit,hash} from '../repository';
import {HttpError} from '../errors';
import {validateHistory} from '../layouts';
import {recoveryMember} from '../recovery/authority';
import {assertWorkspaceRequestWrite} from '../workspaces/authority';
import {proposalEvidence} from '../agents/proposal-evidence';
import {AgentSecrets} from '../agents/security';
import {ReportSecrets} from './crypto';
import {requireReportsSchema} from './schema';
import {parseFindingReferences,validateFindingReferences} from '../findings/dependencies';
import {findingService} from '../findings/runtime';
import {hasFindingsSchema} from '../findings/schema';
import type {FindingRevision,FindingReference} from '@/packages/findings/types';
import type {FindingRow,RevisionRow} from '../findings/service';

const cleanText=(min:number,max:number)=>z.string().trim().min(min).max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const createSchema=z.object({requestId:z.uuid(),title:cleanText(2,120),description:cleanText(0,1200).default(''),snapshotHash:fingerprint,expectedLayoutVersion:z.number().int().min(1),expectedLayoutHash:fingerprint,planIds:z.array(id).max(10).refine(ids=>new Set(ids).size===ids.length),parentId:id.optional(),findingDependencies:z.array(z.object({findingId:id,revisionId:id,hash:fingerprint}).strict()).max(20).optional()}).strict();
type EditionRow=Record<string,unknown>&{tenant_id:string;id:string;created_by:string;membership_version:number;request_id:string;request_hash:string;document_hash:string;snapshot_hash:string;layout_version:number;layout_hash:string;parent_id:string|null;private_document:string;private_summary:string};
type PdfRow=Record<string,unknown>&{state:'rendering'|'ready'|'failed';lease_id:string|null;lease_until:Date|null;private_bytes:string|null;byte_hash:string|null;page_count:number|null;attempts:number};
type SummaryEnvelope={summary:ReportSummary;grants:ReportGrant[]};
type ResourceRow=Record<string,unknown>&{kind:'order'|'capture'|'dispute';provider_id:string;order_id:string;run_id:string;active:boolean;body:Record<string,unknown>};
export interface ReportRenderer {version:string;render(document:SavedReport,paper:ReportPaper):Promise<{bytes:Buffer;pages:number}>}
const bad=(message:string)=>new HttpError(409,'REPORT_SOURCE_UNVERIFIED',message);
const limit=(value:unknown,maximum:number,message:string)=>{if(Buffer.byteLength(JSON.stringify(value),'utf8')>maximum)throw new HttpError(413,'REPORT_SIZE_LIMIT',message);};

/** Editions are immutable evidence. Rendering is a separately leased pure local
 * computation: a lost response can recover the same stored bytes without ever
 * submitting a model or payment operation. */
export class ReportService {
  constructor(readonly db:Database,readonly secrets:ReportSecrets,readonly agentSecrets:AgentSecrets,readonly renderer?:ReportRenderer){}
  private async member(tx:Database,actor:Actor,write=false){
    if(write)await assertWorkspaceRequestWrite(tx,actor);
    const member=await recoveryMember(tx,actor);
    if(member.role!==actor.role)throw new HttpError(403,'CURRENT_AUTHORITY_REQUIRED','The membership that opened this report changed. Reopen the current workspace.');
    return member;
  }
  private unpack(row:EditionRow):SavedReport{
    const document=this.secrets.open<ReportDocument>(row.tenant_id,'edition',row.id,row.private_document);
    const envelope=this.secrets.open<SummaryEnvelope>(row.tenant_id,'summary',row.id,row.private_summary),summary=envelope.summary;
    if(!([1,2].includes(document.schemaVersion))||document.id!==row.id||document.workspace.id!==row.tenant_id||document.snapshot.context.tenantId!==row.tenant_id||document.creator.actorId!==row.created_by||document.snapshot.hash!==row.snapshot_hash||document.layout.version!==row.layout_version||document.layout.hash!==row.layout_hash||hash(document.layout.history)!==row.layout_hash||hash(document)!==row.document_hash||summary.documentHash!==row.document_hash||summary.id!==row.id||hash(envelope.grants)!==hash(document.grants))throw new HttpError(409,'REPORT_UNVERIFIED','This saved report does not match its encrypted immutable identity. Its original is preserved.');
    return {document,summary};
  }
  private async edition(tx:Database,actor:Actor,reportId:string){
    const row=(await tx.query<EditionRow>('SELECT * FROM gh_report_editions WHERE tenant_id=$1 AND id=$2',[actor.tenantId,reportId]))[0];
    if(!row)throw new HttpError(404,'REPORT_NOT_FOUND','This report is not available in the current workspace.');
    const report=this.unpack(row);await this.currentGrants(tx,actor,report.document.grants);return report;
  }
  private async currentGrants(tx:Database,actor:Actor,expected:ReportGrant[]){
    if(!expected.length)return;
    const resources=await tx.query<ResourceRow>('SELECT kind,provider_id,order_id,run_id,active,body FROM gh_provider_resources WHERE tenant_id=$1 AND provider_id=ANY($2::text[]) FOR SHARE',[actor.tenantId,expected.map(row=>row.id)]);
    for(const grant of expected){
      const row=resources.find(item=>item.kind===grant.kind&&item.provider_id===grant.id);
      if(!row?.active||row.order_id!==grant.orderId||row.run_id!==grant.runId||actor.allowedResourceIds&&!actor.allowedResourceIds.includes(grant.id))throw new HttpError(403,'REPORT_RESOURCE_ACCESS_CHANGED','A provider resource grant in this edition is no longer available to the current membership. The saved report is preserved.');
      if(grant.kind==='dispute'&&!expected.some(capture=>capture.kind==='capture'&&capture.orderId===grant.orderId&&capture.id===row.body.captureId))throw new HttpError(403,'REPORT_RESOURCE_ACCESS_CHANGED','The case is no longer bound to the exact capture preserved in this edition.');
    }
  }
  private async freezeGrants(tx:Database,actor:Actor,snapshot:Snapshot,plans:RecoveryPlan[]){
    const ownedOrders=snapshot.orders.filter(row=>row.paymentSource==='sandbox');
    const extraOrders=plans.flatMap(plan=>plan.branch.actions.filter(row=>row.sourceClass==='sandbox').map(row=>row.orderId));
    const orderIds=[...new Set([...ownedOrders.map(row=>row.id),...extraOrders])];
    if(!orderIds.length)return [];
    if(orderIds.length>2500)throw new HttpError(413,'REPORT_SIZE_LIMIT','This edition exceeds the verified resource bound. No partial report was created.');
    type Item=Record<string,unknown>&{order_id:string;run_id:string;entry:SeedManifestEntry;provider_order_id:string;provider_capture_id:string;status:string};
    const items=await tx.query<Item>('SELECT order_id,run_id,entry,provider_order_id,provider_capture_id,status FROM gh_seed_items WHERE tenant_id=$1 AND order_id=ANY($2::text[])',[actor.tenantId,orderIds]);
    const runs=await tx.query<Record<string,unknown>&{id:string;manifest:SeedManifest;manifest_hash:string}>('SELECT id,manifest,manifest_hash FROM gh_seed_runs WHERE tenant_id=$1 AND id=ANY($2::text[])',[actor.tenantId,[...new Set(items.map(row=>row.run_id))]]);
    const resources=await tx.query<ResourceRow>("SELECT kind,provider_id,order_id,run_id,active,body FROM gh_provider_resources WHERE tenant_id=$1 AND order_id=ANY($2::text[]) AND kind IN ('order','capture','dispute') FOR SHARE",[actor.tenantId,orderIds]);
    const grants:ReportGrant[]=[];
    for(const orderId of orderIds){
      const item=items.find(row=>row.order_id===orderId),run=runs.find(row=>row.id===item?.run_id),expected=run?.manifest.entries.find(row=>row.orderId===orderId),snapshotOrder=ownedOrders.find(row=>row.id===orderId);
      if(!item||item.status!=='captured'||!expected||run?.manifest.hash!==run?.manifest_hash||digest(expected)!==digest(item.entry)||snapshotOrder&&(snapshotOrder.captureId!==item.provider_capture_id||snapshotOrder.paypalOrderId!==item.provider_order_id))throw bad('The saved snapshot does not match independently bound sandbox payment evidence.');
      for(const [kind,providerId] of [['order',item.provider_order_id],['capture',item.provider_capture_id]] as const){
        const resource=resources.find(row=>row.kind===kind&&row.provider_id===providerId);
        if(!resource?.active||resource.order_id!==orderId||resource.run_id!==item.run_id)throw bad('An exact sandbox payment grant is missing or inactive.');
        grants.push({kind,id:providerId,orderId,runId:item.run_id});
      }
      const caseIds=[...new Set([snapshotOrder?.disputeSource==='sandbox'?snapshotOrder.disputeId:null,...plans.flatMap(plan=>plan.branch.actions.filter(row=>row.orderId===orderId&&row.kind==='dispute_response'&&row.sourceClass==='sandbox').map(row=>row.resourceId))].filter((value):value is string=>!!value))];
      for(const caseId of caseIds){const resource=resources.find(row=>row.kind==='dispute'&&row.provider_id===caseId);if(!resource?.active||resource.order_id!==orderId||resource.body.captureId!==item.provider_capture_id)throw bad('A saved case is not independently bound to the owned capture.');grants.push({kind:'dispute',id:caseId,orderId,runId:resource.run_id});}
    }
    await this.currentGrants(tx,actor,grants);return grants;
  }
  async create(actor:Actor,raw:unknown):Promise<SavedReport>{
    await requireReportsSchema(this.db);const parsed=createSchema.safeParse(raw);
    if(!parsed.success)throw new HttpError(400,'INVALID_REPORT_REQUEST','Use a title, the admitted snapshot, the exact saved layout revision and up to ten distinct saved manifests.');
    const input:ReportRequest=parsed.data,requestHash=hash(input);
    try{return await this.db.transaction(async tx=>{
      // One database snapshot binds source facts, observed outcomes and audit.
      // Current authority is row-locked for the complete write transaction.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await this.member(tx,actor,true);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`report:${actor.tenantId}:${actor.id}:${input.requestId}`]);
      const existing=(await tx.query<EditionRow>('SELECT * FROM gh_report_editions WHERE tenant_id=$1 AND created_by=$2 AND request_id=$3',[actor.tenantId,actor.id,input.requestId]))[0];
      if(existing){if(existing.request_hash!==requestHash)throw new HttpError(409,'REPORT_REQUEST_CONFLICT','This saved request identity belongs to different report content.');const report=this.unpack(existing);await this.currentGrants(tx,actor,report.document.grants);return report;}
      if(input.parentId)await this.edition(tx,actor,input.parentId);
      const saved=(await tx.query<{context:QueryContext}>('SELECT context FROM gh_snapshots WHERE tenant_id=$1 AND hash=$2',[actor.tenantId,input.snapshotHash]))[0];
      if(!saved||saved.context.roleScope!==actor.role||saved.context.rolePolicyVersion!==`roles-v1:${actor.membershipVersion}`)throw new HttpError(409,'REPORT_SCOPE_CHANGED','Open an admitted snapshot under your current workspace role before creating an edition.');
      const dataset=(await tx.query<{body:SeedDataset}>('SELECT body FROM gh_datasets WHERE tenant_id=$1 FOR SHARE',[actor.tenantId]))[0]?.body;
      if(!dataset)throw bad('Open a complete investigation before creating an edition.');
      const snapshot=buildSnapshot(dataset,saved.context);
      if(snapshot.hash!==input.snapshotHash)throw new HttpError(409,'REPORT_SNAPSHOT_CHANGED','Evidence changed before the report was saved. Refresh the investigation and create a separately identified edition.');
      const layout=(await tx.query<{body:unknown;version:number}>('SELECT body,version FROM gh_layouts WHERE tenant_id=$1 AND id=$2 FOR SHARE',[actor.tenantId,'incident-room']))[0];
      if(!layout||layout.version!==input.expectedLayoutVersion||hash(layout.body)!==input.expectedLayoutHash)throw new HttpError(409,'REPORT_LAYOUT_CHANGED','Save and review the current native workspace revision before creating this edition.');
      const history=validateHistory(layout.body) as unknown as ReportHistory;
      const planRows=await tx.query<{body:RecoveryPlan;id:string;plan_hash:string;version:number;status:string}>('SELECT id,body,plan_hash,version,status FROM gh_plans WHERE tenant_id=$1 AND id=ANY($2::text[]) FOR SHARE',[actor.tenantId,input.planIds]);
      if(planRows.length!==input.planIds.length)throw new HttpError(404,'REPORT_MANIFEST_NOT_FOUND','One selected manifest is outside this workspace or no longer available.');
      const plans=input.planIds.map(id=>{const row=planRows.find(row=>row.id===id)!;if(row.body.tenantId!==actor.tenantId||row.body.id!==row.id||row.body.hash!==row.plan_hash||row.body.version!==row.version||row.body.status!==row.status)throw bad('A saved manifest does not match its persisted identity.');proposalEvidence(row.body);const operations=row.body.branch.actions.map(action=>action.payload.operationId);if(operations.some(value=>typeof value!=='string'||!value)||new Set(operations).size!==operations.length||new Set(row.body.branch.actions.map(action=>action.id)).size!==operations.length)throw bad('A selected manifest does not contain distinct frozen action and operation identities.');return row.body;});
      const grants=await this.freezeGrants(tx,actor,snapshot,plans);
      const workspace=(await tx.query<{name:string;merchant_name:string;source_kind:'sample'|'existing';organization_name:string|null}>(`SELECT w.name,w.merchant_name,w.source_kind,o.name AS organization_name FROM gh_workspaces w LEFT JOIN gh_organizations o ON o.id=w.organization_id WHERE w.tenant_id=$1`,[actor.tenantId]))[0];
      const person=(await tx.query<{display_name:string}>(`SELECT p.display_name FROM gh_actor_people a JOIN gh_people p ON p.id=a.person_id WHERE a.tenant_id=$1 AND a.actor_id=$2`,[actor.tenantId,actor.id]))[0];
      // A report is a workspace share. Its author chooses already shared exact
      // lifecycle versions; creating an edition never publishes a private chat.
      const refs=parseFindingReferences(input.findingDependencies),findingRevisions:FindingRevision[]=[];
      if(refs.length){await validateFindingReferences(tx,actor,refs,snapshot);const service=findingService(tx);for(const ref of refs)findingRevisions.push((await service.permitted(tx,actor,ref.findingId,ref.revisionId)).revision);}
      const findings:AgentFinding[]=[];
      const orderIds=new Set(snapshot.orders.map(row=>row.id));
      const operationsRows=await tx.query<{id:string;plan_id:string;action_id:string;status:string;body:Operation}>('SELECT id,plan_id,action_id,status,body FROM gh_operations WHERE tenant_id=$1 ORDER BY updated_at,id LIMIT 5001',[actor.tenantId]);
      if(operationsRows.length>5000)throw new HttpError(413,'REPORT_SIZE_LIMIT','The observed operation history exceeds this edition bound. No incomplete operation inventory was saved.');
      const operations=operationsRows.filter(row=>orderIds.has(row.body.orderId)||input.planIds.includes(row.plan_id)).map(row=>{
        const value=row.body;
        if(value.tenantId!==actor.tenantId||row.id!==value.id||row.plan_id!==value.planId||row.action_id!==value.actionId||row.status!==value.status)throw bad('An observed operation does not match its persisted identity.');
        const {id,planId,actionId,orderId,kind,amountMinor,currency,status,providerId,attempts,updatedAt,sourceClass,reason}=value;
        return {id,planId,actionId,orderId,kind,amountMinor,currency,status,providerId,attempts,updatedAt,sourceClass,reason,receiptHash:value.result?hash(value.result):null};
      });
      // Read observed cases only through exact grants already admitted above.
      const caseRows=await tx.query<{provider_id:string;order_id:string;body:DisputeObservation}>("SELECT provider_id,order_id,body FROM gh_provider_resources WHERE tenant_id=$1 AND kind='dispute' AND provider_id=ANY($2::text[]) AND active=true FOR SHARE",[actor.tenantId,grants.filter(row=>row.kind==='dispute').map(row=>row.id)]);
      const cases=caseRows.map(row=>{const value=row.body;if(value.id!==row.provider_id||!grants.some(grant=>grant.kind==='capture'&&grant.orderId===row.order_id&&grant.id===value.captureId))throw bad('An observed case is not bound to its owned capture.');return {id:value.id,orderId:row.order_id,captureId:value.captureId,status:value.status,stage:value.stage,dueAt:value.sellerResponseDueAt,observedAt:value.observedAt,bodyHash:value.bodyHash};});
      const auditRows=await tx.query<{sequence:string;body:AuditEvent}>('SELECT sequence,body FROM gh_audit WHERE tenant_id=$1 ORDER BY sequence LIMIT 10001',[actor.tenantId]);
      if(auditRows.length>10000)throw new HttpError(413,'REPORT_SIZE_LIMIT','The full workspace audit exceeds this edition bound. No partial audit was presented as complete.');
      const events=auditRows.map(row=>{if(row.body.tenantId!==actor.tenantId)throw bad('An audit entry is outside this workspace.');const {id,timestamp,actorId,type,summary,refId}=row.body;return {id,timestamp,actorId,type,summary,refId};});
      const reportId=`report-${randomUUID()}`,createdAt=new Date().toISOString();
      const exactPrint=isCommerceResourceSemantics(snapshot.context.semanticModelVersion)?await nativePrint(snapshot,history.current,createdAt):undefined;
      const draft:ReportDocument={schemaVersion:exactPrint?2:1,...exactPrint?{nativePrint:exactPrint}:{},id:reportId,title:input.title,description:input.description,createdAt,parentId:input.parentId??null,
        workspace:{id:actor.tenantId,name:workspace?.name??'Existing investigation',merchantName:workspace?.merchant_name??'Fernwood Supply',organizationName:workspace?.organization_name??null,source:workspace?.source_kind??'existing'},
        creator:{actorId:actor.id,displayName:person?.display_name??'Existing workspace member',role:actor.role,membershipVersion:actor.membershipVersion,identityKind:'browser_capability'},snapshot,layout:{history,version:layout.version,hash:input.expectedLayoutHash},plans,findings,findingRevisions,
        observed:{capturedAt:createdAt,operations,cases},audit:{scope:'workspace_at_export',events,throughSequence:Number(auditRows.at(-1)?.sequence??0)},grants,
        coverage:{snapshotOrders:snapshot.orders.length,snapshotEvidence:snapshot.evidence.length,snapshotTransitions:snapshot.tables.transition_snapshot.length,...historyCounts(history),fullSnapshotInJson:true,staticInstruments:exactPrint?'exact_native_queries':'whole_admitted_snapshot',customMappings:exactPrint?'exact_supported_mappings':'preserved_in_native_history',agentNarratives:'explicitly_shared_exact_finding_versions',sharing:'current_workspace_members_only',limitations:[
          ...(exactPrint?[`Static instruments use the saved native mappings and filters. ${exactPrint.widgets.filter(widget=>widget.status==='unsupported').length} unsupported widget mappings are explicitly identified without substituted results. Complete authorized sources remain in JSON, including excerpts hidden in presentation.`]:['The six static instruments describe the whole admitted snapshot. Native filters, mappings, custom charts and full undo/redo entries are preserved exactly in the attached JSON; they are not silently reinterpreted as the static overview.']),
          'Snapshot event time T, knowledge cutoff K, source observation times and report generation time are distinct. Observed operations and cases may be later than the snapshot.',
          'A proposal, approved action, observed refund, tracking update, submitted evidence and resolved dispute are distinct states. A comparison branch grants no policy override.',
          'Findings are source-bound interpretations, not causal proof. Only explicitly selected, creator-shared finding versions are included in this edition. Private findings, chats and model reasoning are excluded.',
          'A browser display name is self-declared. Saved report access requires current workspace membership and active grants for included provider resources.',
        ]}};
      // Bind responses, encrypted storage and hashes to the same JSON transport
      // value. Optional JS undefined fields are absent in every stored edition.
      const document=JSON.parse(JSON.stringify(draft)) as ReportDocument;
      limit(document,24_000_000,'This complete edition exceeds the 24 MB evidence bound. The saved investigation is unchanged.');
      const documentHash=hash(document),summary:ReportSummary={id:reportId,title:input.title,description:input.description,createdAt,createdBy:actor.id,creatorName:document.creator.displayName,workspaceName:document.workspace.name,merchantName:document.workspace.merchantName,parentId:document.parentId,documentHash,snapshotHash:snapshot.hash,context:snapshot.context,layoutVersion:layout.version,planCount:plans.length,operationCount:operations.length,findingCount:findings.length+findingRevisions.length};
      await tx.query(`INSERT INTO gh_report_editions(tenant_id,id,created_by,membership_version,request_id,request_hash,document_hash,snapshot_hash,layout_version,layout_hash,parent_id,private_document,private_summary,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[actor.tenantId,reportId,actor.id,actor.membershipVersion,input.requestId,requestHash,documentHash,snapshot.hash,layout.version,input.expectedLayoutHash,input.parentId??null,this.secrets.seal(actor.tenantId,'edition',reportId,document),this.secrets.seal(actor.tenantId,'summary',reportId,{summary,grants}),createdAt]);
      await audit(tx,actor,'report.created','Immutable private report edition saved',reportId,{documentHash,snapshotHash:snapshot.hash,layoutHash:input.expectedLayoutHash,layoutVersion:layout.version});
      return {document,summary};
    });}catch(error){if(error&&typeof error==='object'&&'code'in error&&['40001','23505'].includes(String(error.code)))throw new HttpError(409,'REPORT_SOURCE_CHANGED','Source, access or the same saved request changed while this edition was being frozen. Retry the original request to recover any saved result.');throw error;}
  }
  async read(actor:Actor,reportId:string){await requireReportsSchema(this.db);return this.db.transaction(async tx=>{await this.member(tx,actor);return this.edition(tx,actor,reportId);});}
  async corrections(actor:Actor,reportId:string){
    await requireReportsSchema(this.db);return this.db.transaction(async tx=>{
      await this.member(tx,actor);const report=await this.edition(tx,actor,reportId);
      const notices=[];if(await hasFindingsSchema(tx)){
        const service=findingService(tx),refs:FindingReference[]=(report.document.findingRevisions??[]).map(row=>({findingId:row.findingId,revisionId:row.id,hash:row.hash}));
        // Legacy editions keep their exact bytes. Only an authorized separately
        // adopted lifecycle can supply an external current correction notice.
        for(const old of report.document.findings){
          const found=(await tx.query<FindingRow>('SELECT * FROM gh_findings WHERE tenant_id=$1 AND origin_document_id=$2',[actor.tenantId,old.id]))[0];
          if(!found)continue;const first=(await tx.query<RevisionRow>('SELECT * FROM gh_finding_revisions WHERE tenant_id=$1 AND finding_id=$2 AND sequence=1',[actor.tenantId,found.id]))[0];
          if(first)refs.push({findingId:found.id,revisionId:first.id,hash:first.revision_hash});
        }
        for(const ref of refs){try{notices.push(...await service.correctionsIn(tx,actor,[ref]));}catch(error){if(error instanceof HttpError&&[403,404].includes(error.status))continue;throw error;}}
      }
      const savedPlans=report.document.plans,currentPlans=notices.some(notice=>notice.comparison)&&savedPlans.length?await tx.query<{id:string;hash:string;status:RecoveryPlan['status']}>('SELECT id,plan_hash AS hash,status FROM gh_plans WHERE tenant_id=$1 AND id=ANY($2::text[])',[actor.tenantId,savedPlans.map(plan=>plan.id)]):[];
      for(const current of currentPlans)if(savedPlans.find(plan=>plan.id===current.id)?.hash!==current.hash)throw bad('A current manifest does not match the exact identity saved in this edition.');
      const currentById=new Map(currentPlans.map(plan=>[plan.id,plan]));
      const qualified:ReportFindingCorrection[]=notices.map(notice=>{
        if(!notice.comparison)return {...notice,savedManifests:null};
        const changed=new Set([...notice.comparison.removedOrderIds,...notice.comparison.addedOrderIds]);
        const savedManifests=savedPlans.filter(plan=>plan.findingDependencies?.some(ref=>ref.findingId===notice.findingId)||!plan.findingDependencies?.length&&plan.branch.actions.some(action=>changed.has(action.orderId)))
          .map(plan=>currentById.get(plan.id)).filter((plan):plan is NonNullable<typeof plan>=>!!plan&&['stale','expired'].includes(plan.status));
        return {...notice,savedManifests};
      });
      return {reportId,documentHash:report.summary.documentHash,checkedAt:new Date().toISOString(),scope:'currently_permitted_findings' as const,notices:qualified};
    });
  }
  async list(actor:Actor,cursor?:string):Promise<ReportList>{
    await requireReportsSchema(this.db);
    if(cursor&&!id.safeParse(cursor).success)throw new HttpError(400,'INVALID_REPORT_CURSOR','Use a saved report cursor from this workspace.');
    return this.db.transaction(async tx=>{
      await this.member(tx,actor);
      if(cursor&&!(await tx.query('SELECT id FROM gh_report_editions WHERE tenant_id=$1 AND id=$2',[actor.tenantId,cursor]))[0])throw new HttpError(404,'REPORT_NOT_FOUND','This report cursor is outside the current workspace.');
      // Listing never loads 30 complete 24 MB documents. The separately
      // authenticated summary carries only its bounded access-grant inventory.
      const rows=await tx.query<Pick<EditionRow,'tenant_id'|'id'|'document_hash'|'private_summary'>>(`SELECT tenant_id,id,document_hash,private_summary FROM gh_report_editions WHERE tenant_id=$1 ${cursor?'AND (created_at,id)<(SELECT created_at,id FROM gh_report_editions WHERE tenant_id=$1 AND id=$2)':''} ORDER BY created_at DESC,id DESC LIMIT 31`,cursor?[actor.tenantId,cursor]:[actor.tenantId]);
      // Even summaries can name private resources; require the same live grants.
      const reports:ReportSummary[]=[];for(const row of rows.slice(0,30)){const {summary,grants}=this.secrets.open<SummaryEnvelope>(row.tenant_id,'summary',row.id,row.private_summary);if(summary.id!==row.id||summary.documentHash!==row.document_hash||summary.context.tenantId!==actor.tenantId)throw new HttpError(409,'REPORT_UNVERIFIED','This report summary does not match its saved immutable identity.');await this.currentGrants(tx,actor,grants);reports.push(summary);}
      return {reports,hasMore:rows.length>30,nextCursor:rows.length>30?reports.at(-1)!.id:null};
    });
  }
  async pdf(actor:Actor,reportId:string,paper:ReportPaper):Promise<PdfRepresentation>{
    await requireReportsSchema(this.db);
    if(paper!=='A4'&&paper!=='LETTER')throw new HttpError(400,'INVALID_REPORT_PAPER','Choose A4 or US Letter.');
    if(!this.renderer)throw new HttpError(503,'REPORT_RENDERER_UNAVAILABLE','The PDF renderer is unavailable. The saved report and full JSON remain readable.');
    const admitted=await this.read(actor,reportId);
    const renderer={...this.renderer,version:this.renderer.version==='glasshouse-static-v1.0.0'&&admitted.document.schemaVersion===2?'glasshouse-native-static-v2.0.0':this.renderer.version},identity=`${reportId}:${paper}:${renderer.version}`,lease=randomUUID();
    const claimed=await this.db.transaction(async tx=>{
      await this.member(tx,actor);const report=await this.edition(tx,actor,reportId);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`report-pdf:${actor.tenantId}:${identity}`]);
      const row=(await tx.query<PdfRow>('SELECT * FROM gh_report_pdf WHERE tenant_id=$1 AND report_id=$2 AND paper=$3 AND renderer_version=$4 FOR UPDATE',[actor.tenantId,reportId,paper,renderer.version]))[0];
      if(row?.state==='ready')return {report,row,render:false};
      if(row?.state==='rendering'&&row.lease_until&&new Date(row.lease_until).getTime()>Date.now())throw new HttpError(409,'REPORT_PDF_RENDERING','This exact PDF is being prepared. The saved report and JSON are available; retry this download shortly.');
      if(row&&row.attempts>=5)throw new HttpError(409,'REPORT_PDF_HELD','This representation is held after five local render attempts. The saved report and full JSON remain available.');
      await tx.query(`INSERT INTO gh_report_pdf(tenant_id,report_id,paper,renderer_version,state,lease_id,lease_until) VALUES($1,$2,$3,$4,'rendering',$5,now()+interval '90 seconds') ON CONFLICT(tenant_id,report_id,paper,renderer_version) DO UPDATE SET state='rendering',lease_id=$5,lease_until=now()+interval '90 seconds',attempts=gh_report_pdf.attempts+1,reason_code=null,updated_at=now()`,[actor.tenantId,reportId,paper,renderer.version,lease]);
      return {report,row:null,render:true};
    });
    let bytes:Buffer,pages:number,byteHash:string;
    if(!claimed.render){
      bytes=Buffer.from(this.secrets.open<string>(actor.tenantId,'pdf',identity,claimed.row!.private_bytes!),'base64');pages=claimed.row!.page_count!;byteHash=claimed.row!.byte_hash!;
      if(createHash('sha256').update(bytes).digest('hex')!==byteHash)throw new HttpError(409,'REPORT_PDF_UNVERIFIED','This saved PDF could not be verified. The original report and JSON remain available.');
    }else{
      try{
        const rendered=await renderer.render(claimed.report,paper);bytes=rendered.bytes;pages=rendered.pages;
        if(bytes.length>32_000_000||pages<1||pages>(claimed.report.document.schemaVersion===2?800:200)||!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new HttpError(413,'REPORT_PDF_LIMIT','This complete PDF exceeds the renderer bound. The static report and full JSON remain available.');
        byteHash=createHash('sha256').update(bytes).digest('hex');
        const saved=await this.db.query(`UPDATE gh_report_pdf SET state='ready',private_bytes=$6,byte_hash=$7,page_count=$8,lease_id=null,lease_until=null,updated_at=now() WHERE tenant_id=$1 AND report_id=$2 AND paper=$3 AND renderer_version=$4 AND lease_id=$5 AND state='rendering' RETURNING report_id`,[actor.tenantId,reportId,paper,renderer.version,lease,this.secrets.seal(actor.tenantId,'pdf',identity,bytes.toString('base64')),byteHash,pages]);
        if(!saved[0])throw new HttpError(409,'REPORT_PDF_LEASE_CHANGED','Another renderer retained the canonical result. Retry this exact download to read its saved bytes.');
      }catch(error){await this.db.query("UPDATE gh_report_pdf SET state='failed',reason_code=$6,lease_id=null,lease_until=null,updated_at=now() WHERE tenant_id=$1 AND report_id=$2 AND paper=$3 AND renderer_version=$4 AND lease_id=$5",[actor.tenantId,reportId,paper,renderer.version,lease,error instanceof HttpError?error.code:'LOCAL_RENDER_FAILED']);if(error instanceof HttpError)throw error;throw new HttpError(503,'REPORT_PDF_FAILED','The local PDF render could not finish. The saved report and full JSON remain available.');}
    }
    // A revoke/switch while CPU rendering keeps the pure saved representation,
    // but cannot disclose it to the now-stale requesting context.
    await this.read(actor,reportId);return {bytes,hash:byteHash,pages,rendererVersion:renderer.version,paper};
  }
}
