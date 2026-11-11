import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reportHarness} from './helpers/reports';
import {commandId,failure} from './helpers/workspaces';
import {nativeStudio} from './helpers/studio-native';
import {reportInstruments,snapshotFacts} from '../packages/reports/semantics';
import {reportCanonical} from '../packages/reports/canonical';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {hash,persistDataset,storePlan} from '../lib/server/repository';
import {saveLayout} from '../lib/server/layouts';
import {buildSnapshot,applyDeliveryRevision} from '../packages/domain';
import {snapshotContext} from '../lib/server/snapshots';
import {tokenHash} from '../lib/server/workspaces/crypto';
import type {AgentFinding} from '../packages/agents/contracts';
const fixtureBytes=Buffer.from('%PDF-1.7\nExplicitly synthetic renderer fixture; not a delivered PDF.\n%%EOF');

test('immutable encrypted editions preserve exact snapshot, frozen manifest, identities and original authority on replay',async t=>{
  const h=await reportHarness(t),plan=await h.plan(),request=h.input({planIds:[plan.id]});
  const before={session:h.before.session,member:h.before.member,financial:await h.db.query('SELECT * FROM gh_operations')};
  const first=await h.service.create(h.scoped,request),again=await h.service.create(h.scoped,request);
  assert.deepEqual(again,first);assert.equal(hash(first.document),first.summary.documentHash);assert.equal(first.document.snapshot.hash,h.snapshot.hash);
  assert.deepEqual(first.document.plans,[plan]);assert.equal(first.document.plans[0].branch.actions.length,114);assert.equal(new Set(plan.branch.actions.map(row=>row.payload.operationId)).size,114);
  assert.equal(first.document.plans[0].approvedBy,null);assert.deepEqual(first.document.layout.history,h.history);
  assert.deepEqual(await h.service.read(h.scoped,first.summary.id),first);
  const rows=await h.db.query('SELECT * FROM gh_report_editions');assert.equal(rows.length,1);assert.equal(JSON.stringify(rows).includes(request.title),false);assert.equal(JSON.stringify(rows).includes(plan.id),false);
  assert.deepEqual((await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]))[0],before.session);
  assert.deepEqual((await h.db.query('SELECT * FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]))[0],before.member);assert.deepEqual(await h.db.query('SELECT * FROM gh_operations'),before.financial);
  await assert.rejects(h.service.create(h.scoped,{...request,title:'A different request body'}),failure('REPORT_REQUEST_CONFLICT'));
  await assert.rejects(h.db.query("UPDATE gh_report_editions SET layout_version=77 WHERE id=$1",[first.summary.id]),/immutable/);
  await assert.rejects(h.db.query('DELETE FROM gh_report_editions WHERE id=$1',[first.summary.id]),/immutable/);
  assert.equal(createHash('sha256').update(reportCanonical(first.document)).digest('hex'),first.summary.documentHash);
});

test('current layout and snapshot CAS reject mismatches; source corrections create new editions and never rewrite old ones',async t=>{
  const h=await reportHarness(t),request=h.input(),first=await h.service.create(h.scoped,request);
  await assert.rejects(h.service.create(h.scoped,h.input({expectedLayoutVersion:2})),failure('REPORT_LAYOUT_CHANGED'));
  await assert.rejects(h.service.create(h.scoped,h.input({expectedLayoutHash:'f'.repeat(64)})),failure('REPORT_LAYOUT_CHANGED'));
  await assert.rejects(h.service.create(h.scoped,h.input({snapshotHash:'f'.repeat(64)})),failure('REPORT_SCOPE_CHANGED'));
  const revised=applyDeliveryRevision(h.dataset);await persistDataset(h.db,revised);
  const snapshot=await h.saveSnapshot(buildSnapshot(revised,snapshotContext(h.scoped,revised)));
  assert.equal(snapshot.totals.affected,54);assert.equal(first.document.snapshot.totals.affected,63);
  const second=await h.service.create(h.scoped,h.input({snapshotHash:snapshot.hash,parentId:first.summary.id,title:'After nine source corrections'}));
  assert.equal(second.document.parentId,first.summary.id);assert.notEqual(second.summary.documentHash,first.summary.documentHash);
  assert.deepEqual(await h.service.read(h.scoped,first.summary.id),first);assert.deepEqual(await h.service.create(h.scoped,request),first);
  assert.equal((await h.service.list(h.scoped)).reports.length,2);
});

test('stored snapshot corruption and forged manifests fail before any immutable edition is created',async t=>{
  const h=await reportHarness(t),plan=await h.plan();
  await assert.rejects(h.service.create(h.scoped,h.input({planIds:['foreign-plan']})),failure('REPORT_MANIFEST_NOT_FOUND'));
  await storePlan(h.db,{...plan,branch:{...plan.branch,refundTotalMinor:1}});
  await assert.rejects(h.service.create(h.scoped,h.input({planIds:[plan.id]})),failure('AGENT_PROPOSAL_UNVERIFIED'));
  const changed=structuredClone(h.dataset);changed.orders[0].product='Changed source fact before freezing';await persistDataset(h.db,changed);
  await assert.rejects(h.service.create(h.scoped,h.input()),failure('REPORT_SNAPSHOT_CHANGED'));
  assert.equal((await h.db.query('SELECT * FROM gh_report_editions')).length,0);
});

test('creator-owned findings are hash-checked against sources and private conversations never enter the report',async t=>{
  const h=await reportHarness(t),started=await h.begin(),source=h.snapshot.evidence[0];
  const finding:AgentFinding={id:'fixture-finding',runId:started.run.id,snapshotHash:h.snapshot.hash,revision:h.snapshot.context.cohortVersion,title:'Fixture supported pattern',interpretation:'This interpretation is a source-bound hypothesis.',counterpoint:'This record does not establish a cause.',status:'hypothesis',evidence:[{id:source.id,sourceClass:source.sourceClass,sourceLabel:source.sourceLabel,title:source.title,occurredAt:source.occurredAt,ingestedAt:source.ingestedAt,hash:hash(source)}],facts:snapshotFacts(h.snapshot),sourceCoverage:h.snapshot.sourceCoverage,tools:[],createdAt:new Date().toISOString()};
  await h.db.query("INSERT INTO gh_agent_documents(tenant_id,id,run_id,kind,snapshot_hash,private_document) VALUES($1,$2,$3,'finding',$4,$5)",[h.saved.tenantId,finding.id,started.run.id,h.snapshot.hash,h.secrets.seal(h.saved.tenantId,'document',finding.id,finding)]);
  await h.db.query("INSERT INTO gh_agent_documents(tenant_id,id,run_id,kind,snapshot_hash,private_document) VALUES($1,'secret-brief',$2,'brief',$3,$4)",[h.saved.tenantId,started.run.id,h.snapshot.hash,h.secrets.seal(h.saved.tenantId,'document','secret-brief',{hiddenReasoning:'NEVER_EXPORT_PRIVATE_REASONING'})]);
  const report=await h.service.create(h.scoped,h.input());assert.deepEqual(report.document.findings,[finding]);assert.equal(JSON.stringify(report).includes('NEVER_EXPORT_PRIVATE_REASONING'),false);
  await h.db.query('UPDATE gh_agent_documents SET private_document=$3 WHERE tenant_id=$1 AND id=$2',[h.saved.tenantId,finding.id,h.secrets.seal(h.saved.tenantId,'document',finding.id,{...finding,facts:{...finding.facts,affected:999}})]);
  await assert.rejects(h.service.create(h.scoped,h.input()),failure('REPORT_SOURCE_UNVERIFIED'));
  assert.deepEqual(await h.service.read(h.scoped,report.summary.id),report);
});

test('viewer reads, revocation, archive and cross-workspace denial preserve saved editions',async t=>{
  const h=await reportHarness(t,'owner'),report=await h.service.create(h.scoped,h.input()),joined=await h.join('viewer');
  const viewer=await h.scopedActor(joined.credential,{id:joined.directory.identity.personId,tenantId:h.saved.tenantId,role:'viewer',membershipVersion:1});
  assert.deepEqual(await h.service.read(viewer,report.summary.id),report);
  await assert.rejects(h.service.create(viewer,h.input()),failure('WORKSPACE_READ_ONLY'));
  await assert.rejects(h.service.read({...viewer,tenantId:'other-tenant'},report.summary.id),failure('WORKSPACE_CONTEXT_CHANGED'));
  await h.db.query("UPDATE gh_workspaces SET status='archived' WHERE tenant_id=$1",[h.saved.tenantId]);
  assert.deepEqual(await h.service.read(viewer,report.summary.id),report);
  await assert.rejects(h.service.create(h.scoped,h.input()),failure('WORKSPACE_ARCHIVED'));
  await h.db.query('UPDATE gh_memberships SET active=false,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[viewer.tenantId,viewer.id]);
  await assert.rejects(h.service.read(viewer,report.summary.id),failure('CURRENT_AUTHORITY_REQUIRED'));
  assert.equal((await h.db.query('SELECT * FROM gh_report_editions')).length,1);
});

test('active owned resource grants are required at creation and at every later disclosure',async t=>{
  const h=await reportHarness(t),owned=await h.boundCapture(),input=h.input({snapshotHash:owned.snapshot.hash});
  const report=await h.service.create(h.scoped,input);assert.equal(report.document.grants.length,2);assert.equal(report.document.snapshot.sourceCoverage.sandboxPayments,1);
  await h.db.query("UPDATE gh_provider_resources SET active=false WHERE tenant_id=$1 AND kind='capture'",[h.saved.tenantId]);
  await assert.rejects(h.service.read(h.scoped,report.summary.id),failure('REPORT_RESOURCE_ACCESS_CHANGED'));
  await assert.rejects(h.service.list(h.scoped),failure('REPORT_RESOURCE_ACCESS_CHANGED'));
  await assert.rejects(h.service.create(h.scoped,h.input({snapshotHash:owned.snapshot.hash})),failure('REPORT_SOURCE_UNVERIFIED'));
  await h.db.query("UPDATE gh_provider_resources SET active=true WHERE tenant_id=$1 AND kind='capture'",[h.saved.tenantId]);
  assert.deepEqual(await h.service.read(h.scoped,report.summary.id),report);
  await h.db.query("UPDATE gh_provider_resources SET order_id='wrong-order' WHERE tenant_id=$1 AND kind='capture'",[h.saved.tenantId]);
  await assert.rejects(h.service.read(h.scoped,report.summary.id),failure('REPORT_RESOURCE_ACCESS_CHANGED'));
});

test('a switch during PDF rendering retains exact encrypted bytes and denies the late response',async t=>{
  const h=await reportHarness(t),report=await h.service.create(h.scoped,h.input()),second=await h.createWorkspace();let renders=0,selected!:Awaited<ReturnType<typeof h.workspaceService.switchWorkspace>>;
  const renderer={version:'synthetic-switch-test',render:async()=>{renders++;selected=await h.workspaceService.switchWorkspace(h.credential,{requestId:commandId(),workspaceId:second.id,expectedContextId:h.credential.contextId});return {bytes:fixtureBytes,pages:1};}};
  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),renderer);
  await assert.rejects(service.pdf(h.scoped,report.summary.id,'A4'),failure('WORKSPACE_CONTEXT_CHANGED'));assert.equal(renders,1);
  assert.equal((await h.db.query<{state:string}>('SELECT state FROM gh_report_pdf'))[0].state,'ready');
  const credential={sessionHash:tokenHash(selected.token),contextId:selected.selection.contextId},returned=await h.workspaceService.switchWorkspace(credential,{requestId:commandId(),workspaceId:h.saved.tenantId,expectedContextId:credential.contextId});
  const current=await h.scopedActor({sessionHash:h.sessionHash,contextId:returned.selection.contextId},h.saved);
  assert.deepEqual((await service.pdf(current,report.summary.id,'A4')).bytes,fixtureBytes);assert.equal(renders,1);
});

test('same-report PDF leases prevent concurrent duplicate renders and retain readable JSON after a local failure',async t=>{
  const h=await reportHarness(t),report=await h.service.create(h.scoped,h.input());let calls=0,release!:(value:void)=>void,started!:(value:void)=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  const renderer={version:'synthetic-lease-test',render:async()=>{calls++;started();await wait;return {bytes:fixtureBytes,pages:1};}};
  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),renderer),first=service.pdf(h.scoped,report.summary.id,'A4');
  await entered;await assert.rejects(service.pdf(h.scoped,report.summary.id,'A4'),failure('REPORT_PDF_RENDERING'));release();const pdf=await first;
  assert.equal(calls,1);assert.equal(pdf.hash,createHash('sha256').update(fixtureBytes).digest('hex'));assert.deepEqual((await service.pdf(h.scoped,report.summary.id,'A4')).bytes,pdf.bytes);assert.equal(calls,1);
  const failing=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:'synthetic-failure-test',render:async()=>{throw new Error('Synthetic local renderer failure');}});
  await assert.rejects(failing.pdf(h.scoped,report.summary.id,'A4'),failure('REPORT_PDF_FAILED'));assert.deepEqual(await failing.read(h.scoped,report.summary.id),report);
  assert.equal((await h.db.query<{state:string}>("SELECT state FROM gh_report_pdf WHERE renderer_version='synthetic-failure-test'"))[0].state,'failed');
  assert.equal(JSON.stringify(await h.db.query('SELECT * FROM gh_report_pdf')).includes(fixtureBytes.toString('base64')),false);
});

test('concurrent identical edition creation converges on one immutable request identity',async t=>{
  const h=await reportHarness(t),input=h.input();
  const results=await Promise.allSettled([h.service.create(h.scoped,input),h.service.create(h.scoped,input)]);
  assert(results.some(row=>row.status==='fulfilled'));for(const result of results)if(result.status==='rejected')assert.equal(result.reason.code,'REPORT_SOURCE_CHANGED');
  const recovered=await h.service.create(h.scoped,input);assert.equal((await h.db.query('SELECT * FROM gh_report_editions')).length,1);
  for(const result of results)if(result.status==='fulfilled')assert.equal(result.value.summary.id,recovered.summary.id);
});

test('actual installed native history is preserved exactly in an edition with distinct layout and financial records',async t=>{
  const h=await reportHarness(t),native=await nativeStudio(t),id='report-native-chart';
  const add=await native.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId:id,type:'column-chart-grouped',xTrack:0,yTrack:200,xSpan:24,ySpan:20});assert.equal(add.success,true);
  const config=await native.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'column-chart-grouped'}}).apply({widgetId:id,op:'patch',value:{dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.supportContacts',aggregation:'sum'}]}}});assert.equal(config.success,true);
  const history=JSON.parse(JSON.stringify(native.api.getHistory()));native.destroy();
  await saveLayout(h.db,h.scoped,{history,expectedVersion:1});
  const report=await h.service.create(h.scoped,h.input({expectedLayoutVersion:2,expectedLayoutHash:hash(history)}));
  assert.deepEqual(report.document.layout.history,history);assert.equal(report.document.coverage.nativeWidgets,8);assert.equal(report.document.coverage.undoEntries,2);assert.equal(report.document.coverage.redoEntries,0);
  assert.equal(report.document.observed.operations.length,0);assert.equal((await h.db.query('SELECT * FROM gh_payment_commands')).length,0);
});

test('six static instruments reconcile inventory, transition grains, sources, denominators and unknown deadlines',async t=>{
  const h=await reportHarness(t),report=await h.service.create(h.scoped,h.input()),view=reportInstruments(report.document);
  assert.equal(view.inventory.reduce((sum,row)=>sum+row.value,0),600);assert.equal(view.transitions.reduce((sum,row)=>sum+row.value,0),report.document.snapshot.tables.transition_snapshot.length);
  assert(view.transitions.reduce((sum,row)=>sum+row.value,0)>600);assert.equal(view.deadlines.length,4);assert(view.deadlines.every(row=>!row.verified&&row.remainingMs===null));
  for(const row of view.regions){assert.equal(row.lateShare,Number(row.eligibleShipmentCount)?Number(row.lateCount)/Number(row.eligibleShipmentCount):null);}
  assert.equal(report.document.snapshot.branches[0].refundTotalMinor,23500);assert.equal(report.document.snapshot.branches[1].refundTotalMinor,29500);assert.equal(report.document.plans.length,0);
});
