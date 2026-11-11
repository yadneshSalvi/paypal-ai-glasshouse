import {randomUUID,randomBytes} from 'node:crypto';
import type {TestContext} from 'node:test';
import type {Actor,RecoveryPlan,Role} from '../../packages/domain/types';
import type {ReportRequest} from '../../packages/reports/types';
import type {ReportHistory} from '../../packages/studio/history-saves';
import {workspaceHarness} from './workspaces';
// The workspace harness refuses inherited providers before application imports.
const {ensureReportsSchema}=await import('../../lib/server/reports/schema');
const {ReportService}=await import('../../lib/server/reports/service');
const {ReportSecrets}=await import('../../lib/server/reports/crypto');
const {AgentSecrets}=await import('../../lib/server/agents/security');
const {buildSnapshot}=await import('../../packages/domain');
const {snapshotContext}=await import('../../lib/server/snapshots');
const {hash,persistDataset,storePlan}=await import('../../lib/server/repository');
const {saveLayout}=await import('../../lib/server/layouts');
const {freezeAction,exactPlanHash}=await import('../../lib/server/recovery/contracts');
const {seedManifest}=await import('../../packages/payments/manifest');
export const fixtureHistory=():ReportHistory=>({type:'AgReportHistory',current:{pages:[{id:'report-fixture',widgets:Object.fromEntries(['commerce-river','time-dial','evidence-lens','recovery-branches','impact-map','deadline-strip'].map(type=>[type,{type,dataMapping:{}}]))}],selectedPageId:'report-fixture'},undo:[],redo:[]} as unknown as ReportHistory);
export async function reportHarness(t:TestContext,role:Role='judge'){
  const h=await workspaceHarness(role);t.after(h.dispose);await ensureReportsSchema(h.db);
  const snapshot=await h.saveSnapshot(buildSnapshot(h.dataset,snapshotContext(h.scoped,h.dataset))),history=fixtureHistory();
  if(role!=='viewer')await saveLayout(h.db,h.scoped,{history,expectedVersion:0});
  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key));
  const input=(change:Partial<ReportRequest>={}):ReportRequest=>({requestId:randomUUID(),title:'Fixture-only Fernwood postmortem',description:'Synthetic qualification evidence. No external provider transport.',snapshotHash:snapshot.hash,expectedLayoutVersion:1,expectedLayoutHash:hash(history),planIds:[],...change});
  const plan=async(branchId:'targeted'|'comprehensive'='targeted')=>{
    const id=`report-fixture-plan-${randomUUID()}`,branch=snapshot.branches.find(row=>row.id===branchId)!;
    const value:RecoveryPlan={id,tenantId:h.saved.tenantId,version:1,createdBy:h.saved.id,createdAt:new Date().toISOString(),status:'ready_for_review',branch:{...branch,actions:branch.actions.map(row=>freezeAction(h.saved.tenantId,id,row))},snapshotId:snapshot.id,snapshotHash:snapshot.hash,cohortVersion:snapshot.context.cohortVersion,hash:'',expiresAt:new Date(Date.now()+1_800_000).toISOString(),staleReason:null,approvedBy:null,approvedAt:null,executionMode:'sample',contractVersion:2,context:snapshot.context};
    value.hash=exactPlanHash(value);await storePlan(h.db,value);return value;
  };
  const boundCapture=async()=>{
    const manifest=seedManifest(h.dataset),entry=manifest.entries[0],suffix=randomBytes(6).toString('hex');
    const owned={orderId:entry.orderId,runId:'report-synthetic-'+suffix,providerOrderId:'SYNTHETIC_ORDER_'+suffix,captureId:'SYNTHETIC_CAPTURE_'+suffix};
    await h.db.query("INSERT INTO gh_seed_runs(tenant_id,id,seed_version,manifest_hash,manifest,status,created_by,membership_version) VALUES($1,$2,$3,$4,$5::jsonb,'complete',$6,$7)",[h.saved.tenantId,owned.runId,manifest.seedVersion,manifest.hash,JSON.stringify(manifest),h.saved.id,h.saved.membershipVersion]);
    await h.db.query("INSERT INTO gh_seed_items(tenant_id,run_id,order_id,entry,status,provider_order_id,provider_capture_id) VALUES($1,$2,$3,$4::jsonb,'captured',$5,$6)",[h.saved.tenantId,owned.runId,owned.orderId,JSON.stringify(entry),owned.providerOrderId,owned.captureId]);
    for(const [kind,id] of [['order',owned.providerOrderId],['capture',owned.captureId]])await h.db.query('INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body) VALUES($1,$2,$3,$4,$5,now(),$6::jsonb)',[h.saved.tenantId,kind,id,owned.orderId,owned.runId,JSON.stringify({syntheticTransport:true,notAProviderObservation:true})]);
    const source=h.dataset.events.find(row=>row.orderId===owned.orderId&&row.type==='payment.captured')!;
    source.sourceClass='sandbox';source.sourceLabel='Synthetic report ownership fixture';source.sourceRef='fixture://report-owned-capture';source.payload={...source.payload,paypalOrderId:owned.providerOrderId,captureId:owned.captureId,providerResourceId:owned.captureId,syntheticTransport:true};
    for(const interval of h.dataset.intervals)if(interval.sourceEventId===source.id)interval.sourceClass='sandbox';
    await persistDataset(h.db,h.dataset);const current=await h.saveSnapshot(buildSnapshot(h.dataset,snapshotContext(h.scoped,h.dataset)));
    return {...owned,snapshot:current};
  };
  const scopedActor=async(credential:{sessionHash:string;contextId:string},actor:Actor)=>{const {sessionWorkspaceContext}=await import('../../lib/server/workspaces/authority');return h.db.transaction(tx=>sessionWorkspaceContext(tx,actor,credential.sessionHash,credential.contextId));};
  return {...h,snapshot,history,workspaceService:h.service,service,input,plan,boundCapture,scopedActor};
}
