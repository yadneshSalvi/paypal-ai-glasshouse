import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {findingHarness} from './helpers/findings';
import {failure} from './helpers/workspaces';
import {findingReference} from '../lib/server/findings/service';
import {buildSnapshot} from '../packages/domain';
import {datasetFor} from '../lib/server/repository';
import {snapshotContext} from '../lib/server/snapshots';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {REPORT_RENDERER_VERSION,renderReportPdf} from '../lib/server/reports/pdf';

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

test('saved-edition comparisons span later reviews, identify only included held manifests, preserve exports and suppress private current versions',async t=>{
  // New synthetic schema/tenant only. The completed native review is never a fixture.
  const h=await findingHarness(t),original=await h.supported(),bound=await h.prepare(original),sourceOnly=await h.prepare(),unsaved=await h.prepare(original);
  const report=await h.service.create(h.scoped,h.reportInput({findingDependencies:[findingReference(original)],planIds:[bound.id,sourceOnly.id]}));
  const reports=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:renderReportPdf});
  const jsonBefore=digest(JSON.stringify(await reports.read(h.scoped,report.summary.id)));
  const a4=await reports.pdf(h.scoped,report.summary.id,'A4'),letter=await reports.pdf(h.scoped,report.summary.id,'LETTER');
  const savedCiphertext=await h.db.query('SELECT private_document,private_summary,document_hash FROM gh_report_editions WHERE id=$1',[report.summary.id]);
  const viewer=await h.joinedActor('viewer');
  const sourceChange=await h.revise(),source=(await h.findings.detail(h.scoped,original.findingId)).revision;
  const staleSourceOnly=await h.review(sourceOnly.id);
  assert.equal(staleSourceOnly.plan.status,'stale');assert.equal(staleSourceOnly.dependencies.valid,true);assert.deepEqual(staleSourceOnly.dependencies.dependencies,[]);
  await assert.rejects(h.approve(sourceOnly.id,sourceOnly.hash),failure('PLAN_STALE'));
  await assert.rejects(h.queue(sourceOnly.id,sourceOnly.hash),failure('FINDING_APPROVAL_AUTHORITY_REQUIRED'));
  const challenge=await h.decide(source,'challenge',{reason:'PRIVATE_INTERMEDIATE_CHALLENGE: the delivery correction needs a separate interpretation.'});
  const dataset=await datasetFor(h.scoped,h.db),snapshot=await h.saveSnapshot(buildSnapshot(dataset,snapshotContext(h.scoped,dataset)));
  const revised=await h.decide(challenge,'revise',{snapshotHash:snapshot.hash,interpretation:'The remaining fifty-four source records support a narrower regional handoff interpretation.',counterpoint:'The excluded nine orders are delivered. A pattern does not prove a physical cause.',evidenceIds:['evidence-finding-carrier-v2'],counterEvidenceIds:['evidence-finding-carrier-v1'],reason:'PRIVATE_INTERMEDIATE_RESOLUTION: retain the source correction and explicitly resolve the challenge.'});
  const current=await h.decide(revised,'support');await h.share(current);
  assert.equal(current.sequence,6);assert.equal(current.delta?.beforeCount,54);assert.equal(current.delta?.afterCount,54);assert.deepEqual(current.delta?.removedOrderIds,[]);
  for(const actor of [h.scoped,viewer.actor]){
    const result=await reports.corrections(actor,report.summary.id),notice=result.notices[0];
    assert.equal(result.documentHash,report.summary.documentHash);assert.equal(result.notices.length,1);
    assert.equal(notice.comparison?.basis,'referenced_revision_to_current_permitted_revision');
    assert.deepEqual(notice.comparison?.from,{...findingReference(original),sequence:2,cohortVersion:1,snapshotHash:original.sourceSnapshotHash});
    assert.deepEqual(notice.comparison?.to,{...findingReference(current),sequence:6,cohortVersion:2,snapshotHash:current.sourceSnapshotHash});
    assert.equal(notice.comparison?.beforeCount,63);assert.equal(notice.comparison?.afterCount,54);
    assert.deepEqual(notice.comparison?.removedOrderIds,sourceChange.removed);assert.deepEqual(notice.comparison?.addedOrderIds,[]);
    assert.deepEqual(notice.savedManifests?.map(plan=>plan.id).sort(),[bound.id,sourceOnly.id].sort());
    assert.equal(JSON.stringify(result).includes(unsaved.id),false);
    assert.equal(JSON.stringify(result).includes(challenge.id),false);assert.equal(JSON.stringify(result).includes(revised.id),false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_INTERMEDIATE'),false);
  }
  const laterReport=await reports.create(h.scoped,h.reportInput({snapshotHash:snapshot.hash,parentId:report.summary.id,findingDependencies:[findingReference(current)]}));
  const laterBefore=digest(JSON.stringify(laterReport));
  const retraction=await h.decide(current,'retract',{reason:'PRIVATE_CURRENT_RETRACTION: the creator withdraws the explanation without erasing evidence.'});
  for(const id of [report.summary.id,laterReport.summary.id]){
    const result=await reports.corrections(viewer.actor,id),notice=result.notices[0];
    assert.equal(notice.currentRevisionId,null);assert.equal(notice.delta,null);assert.equal(notice.comparison,null);assert.equal(notice.savedManifests,null);
    assert.equal(notice.state,'superseded');assert.equal(JSON.stringify(result).includes(retraction.id),false);assert.equal(JSON.stringify(result).includes(retraction.hash),false);assert.equal(JSON.stringify(result).includes('PRIVATE_CURRENT'),false);
  }
  const ownerNotice=(await reports.corrections(h.scoped,report.summary.id)).notices[0];
  assert.equal(ownerNotice.comparison?.afterCount,54);assert.equal(ownerNotice.comparison?.to.revisionId,retraction.id);
  await assert.rejects(h.findings.detail(viewer.actor,original.findingId,retraction.id),failure('FINDING_NOT_FOUND'));
  assert.equal(digest(JSON.stringify(await reports.read(h.scoped,report.summary.id))),jsonBefore);
  assert.equal(digest(JSON.stringify(await reports.read(h.scoped,laterReport.summary.id))),laterBefore);
  assert.equal(digest((await reports.pdf(h.scoped,report.summary.id,'A4')).bytes),digest(a4.bytes));
  assert.equal(digest((await reports.pdf(h.scoped,report.summary.id,'LETTER')).bytes),digest(letter.bytes));
  assert.deepEqual(await h.db.query('SELECT private_document,private_summary,document_hash FROM gh_report_editions WHERE id=$1',[report.summary.id]),savedCiphertext);
  const activity=(await h.db.query<{operations:string;providers:string;models:string}>(`SELECT
    (SELECT count(*)::text FROM gh_operations WHERE tenant_id=$1) AS operations,
    (SELECT count(*)::text FROM gh_provider_resources WHERE tenant_id=$1) AS providers,
    (SELECT count(*)::text FROM gh_agent_model_turns WHERE tenant_id=$1) AS models`,[h.scoped.tenantId]))[0];
  assert.deepEqual(activity,{operations:'0',providers:'0',models:'0'});
  t.diagnostic(JSON.stringify({kind:'isolated synthetic PostgreSQL regression',reviews:7,removed:9,savedHeldManifests:2,unsavedManifestExcluded:true,privateCurrentComparisonSuppressed:true,exportsUnchanged:{json:jsonBefore,a4:a4.hash,letter:letter.hash},pdfPages:{a4:a4.pages,letter:letter.pages},financialOperations:0,providerCalls:0,modelCalls:0}));
});
