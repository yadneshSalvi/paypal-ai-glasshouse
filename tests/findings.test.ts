import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {findingHarness} from './helpers/findings';
import {failure} from './helpers/workspaces';
import {findingReference} from '../lib/server/findings/service';
import {hash,datasetFor,persistDataset,storePlan} from '../lib/server/repository';
import {buildSnapshot} from '../packages/domain';
import {snapshotContext} from '../lib/server/snapshots';
import {recordFindingSourceChange} from '../lib/server/findings/sources';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {REPORT_RENDERER_VERSION,renderReportPdf} from '../lib/server/reports/pdf';
import type {RecoveryPlan} from '../packages/domain/types';
import type {AgentFinding} from '../packages/agents/contracts';
import {snapshotFacts} from '../packages/reports/semantics';

test('private immutable findings use exact request identity, CAS, source facts and explicit version sharing',async t=>{
  const h=await findingHarness(t),input=h.input(),first=await h.findings.create(h.scoped,input),other=await h.joinedActor();
  assert.equal(first.state,'proposed');assert.equal(first.sequence,1);assert.equal(first.facts.affectedCount,63);
  assert.deepEqual(await h.findings.create(h.scoped,input),first);
  await assert.rejects(h.findings.create(h.scoped,{...input,reason:'Different exact content under the old identity.'}),failure('FINDING_REQUEST_CONFLICT'));
  await assert.rejects(h.findings.detail(other.actor,first.findingId),failure('FINDING_NOT_FOUND'));
  assert.equal((await h.findings.list(other.actor)).findings.length,0);
  const ciphertext=await h.db.query('SELECT * FROM gh_finding_revisions');assert.equal(JSON.stringify(ciphertext).includes(first.interpretation),false);assert.equal(JSON.stringify(ciphertext).includes(first.reason),false);
  await assert.rejects(h.db.query("UPDATE gh_finding_revisions SET state='retracted' WHERE id=$1",[first.id]),/immutable/);
  await assert.rejects(h.db.query('DELETE FROM gh_finding_revisions WHERE id=$1',[first.id]),/immutable/);
  const supported=await h.decide(first,'support');assert.equal(supported.previousHash,first.hash);assert.equal(supported.sequence,2);
  await assert.rejects(h.decide(first,'challenge'),failure('FINDING_REVISION_CONFLICT'));
  const retry={requestId:randomUUID(),expectedRevisionId:supported.id,expectedHash:supported.hash,action:'challenge',reason:'Independent source interpretation needs an attributable second review.'};
  const challenged=await h.findings.decide(h.scoped,first.findingId,retry);assert.deepEqual(await h.findings.decide(h.scoped,first.findingId,retry),challenged);
  await h.share(supported);const visible=await h.findings.detail(other.actor,first.findingId);
  assert.equal(visible.revision.id,supported.id);assert.equal(visible.summary.isCurrent,false);assert.equal(visible.revisions.length,1);assert.equal(visible.corrections[0].currentRevisionId,null);assert.equal(visible.corrections[0].delta,null);
  assert.equal(JSON.stringify(visible).includes(challenged.reason),false);
  await assert.rejects(h.findings.share(other.actor,first.findingId,{requestId:randomUUID(),revisionId:supported.id,hash:supported.hash}),failure('WORKSPACE_READ_ONLY'));
  await assert.rejects(h.findings.create(h.scoped,h.input({evidenceIds:['cross-workspace-source']})),failure('FINDING_EVIDENCE_SCOPE'));
});

test('source-driven 63 to 54 revision identifies all nine actual removals, stale drafts and immutable earlier interpretations',async t=>{
  const h=await findingHarness(t),supported=await h.supported(),dependent=await h.prepare(supported),sourceOnly=await h.prepare();
  const completed:RecoveryPlan={...await h.prepare(supported),status:'completed'};await storePlan(h.db,completed);
  const old=JSON.stringify((await h.findings.detail(h.scoped,supported.findingId,supported.id)).revision);
  const result=await h.revise();assert.equal(result.beforeCount,63);assert.equal(result.afterCount,54);assert.equal(new Set(result.removed).size,9);
  assert.deepEqual([...result.stalePlanIds].sort(),[dependent.id,sourceOnly.id].sort());
  const detail=await h.findings.detail(h.scoped,supported.findingId),current=detail.revision;
  assert.equal(current.state,'revised');assert.equal(current.interpretationReview,'required');assert.equal(current.interpretation,supported.interpretation);assert.equal(current.actorRole,'source');assert.equal(current.delta?.sourceChangeId,result.sourceChangeId);
  assert.deepEqual(current.delta?.removedOrderIds,result.removed);assert.equal(current.delta?.beforeCount,63);assert.equal(current.delta?.afterCount,54);
  assert(current.citations.some(row=>row.relation==='contradicts'&&row.contradicts.length));
  assert.equal(JSON.stringify((await h.findings.detail(h.scoped,supported.findingId,supported.id)).revision),old);
  assert.equal((await h.db.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE id=$1',[completed.id]))[0].body.status,'completed');
  await assert.rejects(h.approve(dependent.id,dependent.hash),failure('FINDING_DEPENDENCY_STALE'));
  assert.equal((await h.review(dependent.id)).dependencies.valid,false);
  const before=await h.db.query('SELECT id FROM gh_finding_revisions');const again=await h.revise();assert.equal(again.alreadyApplied,true);assert.deepEqual(await h.db.query('SELECT id FROM gh_finding_revisions'),before);
  const source=await datasetFor(h.scoped,h.db);await h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.scoped.tenantId]);assert.equal(await recordFindingSourceChange(tx,h.scoped,source,structuredClone(source),{kind:'same_read',reason:'An identical provider read.',sourceId:'same-body'}),null);});
  assert.deepEqual(await h.db.query('SELECT id FROM gh_finding_revisions'),before);
  const newer=buildSnapshot(source,snapshotContext(h.scoped,source));await h.saveSnapshot(newer);
  const reviewed=await h.decide(current,'revise',{snapshotHash:newer.hash,interpretation:'After the nine actual delivery corrections, the remaining fifty-four records still support a narrower delay interpretation.',counterpoint:'The nine removed orders are delivered; the new factual count does not prove a cause.',evidenceIds:['evidence-finding-carrier-v2'],counterEvidenceIds:['evidence-finding-carrier-v1']});
  const final=await h.decide(reviewed,'support');await h.share(final);const fresh=await h.prepare(final,newer);assert.equal(fresh.contractVersion,3);assert.deepEqual(fresh.findingDependencies,[findingReference(final)]);
});

test('challenges invalidate only exact dependent unstarted work, require resolution, and retractions block new financial preparation',async t=>{
  const h=await findingHarness(t),supported=await h.supported(),dependent=await h.prepare(supported),sourceOnly=await h.prepare();await h.approve(dependent.id,dependent.hash);
  const request={requestId:randomUUID(),expectedRevisionId:supported.id,expectedHash:supported.hash,action:'challenge',reason:'Alternative shipment records warrant a new human interpretation before further actions.'};
  const results=await Promise.allSettled([h.findings.decide(h.scoped,supported.findingId,request),h.findings.decide(h.scoped,supported.findingId,{...request,requestId:randomUUID(),reason:'A competing concurrent review cannot silently overwrite its predecessor.'})]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);
  const challenged=(await h.findings.detail(h.scoped,supported.findingId)).revision;assert.equal(challenged.state,'challenged');assert.deepEqual(challenged.delta?.staleDependentPlanIds,[dependent.id]);
  assert.equal((await h.review(sourceOnly.id)).plan.status,'ready_for_review');
  await assert.rejects(h.queue(dependent.id,dependent.hash),failure('FINDING_DEPENDENCY_STALE'));
  await assert.rejects(h.prepare(supported),failure('FINDING_DEPENDENCY_STALE'));
  const resolved=await h.decide(challenged,'support',{reason:'The cited original records resolve the challenge for this unchanged factual scope.'});assert.equal(resolved.resolvedChallengeRevisionId,challenged.id);
  await h.share(resolved);const fresh=await h.prepare(resolved);await h.decide(resolved,'retract',{reason:'The creator withdraws this explanation; historical records and outcomes are retained.'});
  await assert.rejects(h.approve(fresh.id,fresh.hash),failure('FINDING_DEPENDENCY_STALE'));assert.equal((await h.findings.detail(h.scoped,supported.findingId)).revision.state,'retracted');
});

test('legacy adoption preserves the original encrypted document and distinguishes cohort revision from review sequence',async t=>{
  const h=await findingHarness(t),run=await h.begin(),source=h.snapshot.evidence[0];
  const old:AgentFinding={id:'legacy-source-finding',runId:run.run.id,snapshotHash:h.snapshot.hash,revision:h.snapshot.context.cohortVersion,title:'Legacy carrier interpretation',interpretation:'A private sourced hypothesis from the earlier agent contract.',counterpoint:'Correlation does not establish causation.',status:'hypothesis',evidence:[{id:source.id,title:source.title,sourceClass:source.sourceClass,sourceLabel:source.sourceLabel,occurredAt:source.occurredAt,ingestedAt:source.ingestedAt,hash:hash(source)}],facts:snapshotFacts(h.snapshot),sourceCoverage:h.snapshot.sourceCoverage,tools:[],createdAt:new Date().toISOString()};
  const encrypted=h.secrets.seal(h.scoped.tenantId,'document',old.id,old);await h.db.query("INSERT INTO gh_agent_documents(tenant_id,id,run_id,kind,snapshot_hash,private_document) VALUES($1,$2,$3,'finding',$4,$5)",[h.scoped.tenantId,old.id,run.run.id,old.snapshotHash,encrypted]);
  const listed=await h.findings.list(h.scoped);assert.equal(listed.legacy[0].cohortRevision,old.revision);assert.match(listed.legacy[0].explanation,/cohort version/);
  const request={requestId:randomUUID(),documentId:old.id,documentHash:hash(old),reason:'Begin a separate attributable human review of the preserved hypothesis.'};
  const adopted=await h.findings.adopt(h.scoped,request);assert.equal(adopted.state,'proposed');assert.equal(adopted.sequence,1);assert.equal(adopted.origin.legacyCohortRevision,old.revision);assert.deepEqual(await h.findings.adopt(h.scoped,request),adopted);
  assert.equal((await h.db.query<{private_document:string}>('SELECT private_document FROM gh_agent_documents WHERE id=$1',[old.id]))[0].private_document,encrypted);
  assert.deepEqual(h.secrets.open(h.scoped.tenantId,'document',old.id,encrypted),old);
  const report=await h.service.create(h.scoped,h.reportInput());assert.deepEqual(report.document.findings,[]);assert.deepEqual(report.document.findingRevisions,[]);assert.equal(JSON.stringify(report).includes(old.interpretation),false);
});

test('saved report JSON and actual PDF bytes remain identical while separate correction notices reflect permitted current findings',async t=>{
  const h=await findingHarness(t),finding=await h.supported();
  const report=await h.service.create(h.scoped,h.reportInput({findingDependencies:[findingReference(finding)]})),json=JSON.stringify(report,null,2)+'\n';
  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:renderReportPdf});
  const pdf=await service.pdf(h.scoped,report.summary.id,'A4');assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');assert(pdf.pages>1);
  await h.revise();const after=await h.service.read(h.scoped,report.summary.id);assert.equal(JSON.stringify(after,null,2)+'\n',json);assert.deepEqual((await service.pdf(h.scoped,report.summary.id,'A4')).bytes,pdf.bytes);
  assert.equal(createHash('sha256').update(pdf.bytes).digest('hex'),pdf.hash);
  const corrections=await h.service.corrections(h.scoped,report.summary.id);assert.equal(corrections.documentHash,report.summary.documentHash);assert.equal(corrections.notices[0].delta?.removedOrderIds.length,9);assert.equal(corrections.notices[0].state,'revised');
  const other=await h.joinedActor(),visible=await h.service.corrections(other.actor,report.summary.id);assert.equal(visible.notices[0].currentRevisionId,null);assert.equal(visible.notices[0].delta,null);
  assert.equal(JSON.stringify(await h.service.read(other.actor,report.summary.id)),JSON.stringify(report));
});

test('unrelated source changes make no fabricated finding revision or dependency invalidation',async t=>{
  const h=await findingHarness(t),finding=await h.supported(),plan=await h.prepare(finding),before=await datasetFor(h.scoped,h.db),after=structuredClone(before);
  const context=after.orders.find(row=>!row.incidentMember)!;context.supportContacts++;
  after.revision++;await h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.scoped.tenantId]);await persistDataset(tx,after);assert.equal(await recordFindingSourceChange(tx,h.scoped,before,after,{kind:'unrelated_support',reason:'A context-only support statistic changed.',sourceId:'context-support'}),null);});
  assert.equal((await h.findings.detail(h.scoped,finding.findingId)).revision.id,finding.id);assert.equal((await h.review(plan.id)).plan.status,'ready_for_review');
});

test('a peer can recover their exact attributed challenge without acquiring export access to later private versions',async t=>{
  const h=await findingHarness(t),first=await h.findings.create(h.scoped,h.input());await h.share(first);
  const peer=await h.joinedActor('investigator'),request={requestId:randomUUID(),expectedRevisionId:first.id,expectedHash:first.hash,action:'challenge',reason:'A teammate challenges the shared interpretation and retains the exact submitted decision receipt.',counterEvidenceIds:[first.citations[0].id]};
  const challenge=await h.findings.decide(peer.actor,first.findingId,request);assert.equal(challenge.actorId,peer.actor.id);assert.equal(challenge.actorRole,'investigator');assert.equal(challenge.creatorId,h.scoped.id);assert.equal(challenge.citations[0].relation,'contradicts');
  assert.deepEqual(await h.findings.decide(peer.actor,first.findingId,request),challenge);
  await assert.rejects(h.findings.detail(peer.actor,first.findingId,challenge.id),failure('FINDING_NOT_FOUND'));
  await assert.rejects(h.findings.share(peer.actor,first.findingId,{requestId:randomUUID(),revisionId:first.id,hash:first.hash}),failure('FINDING_CREATOR_REQUIRED'));
  const privateReason='CREATOR_PRIVATE_RESOLUTION_7f62';const resolved=await h.decide(challenge,'support',{reason:privateReason});
  const peerView=await h.findings.detail(peer.actor,first.findingId);assert.equal(peerView.revision.id,first.id);assert.equal(peerView.summary.isCurrent,false);assert.equal(peerView.corrections[0].currentRevisionId,null);assert.equal(JSON.stringify(peerView).includes(privateReason),false);
  assert.deepEqual(await h.findings.decide(peer.actor,first.findingId,request),challenge);
  assert.equal(resolved.resolvedChallengeRevisionId,challenge.id);await h.share(resolved);assert.equal((await h.findings.detail(peer.actor,first.findingId)).revision.id,resolved.id);
});

test('concurrent source correction and human challenge serialize into one truthful immutable history',async t=>{
  const h=await findingHarness(t),supported=await h.supported(),plan=await h.prepare(supported);
  const results=await Promise.allSettled([h.decide(supported,'challenge',{reason:'Challenge the interpretation while independently ingested sources may change.'}),h.revise()]);
  assert.equal(results[1].status,'fulfilled');
  const history=await h.findings.detail(h.scoped,supported.findingId);assert.equal(history.revision.state,'revised');assert.equal(history.revision.facts.affectedCount,54);assert.equal(history.revision.actorRole,'source');assert.equal(history.revision.interpretationReview,'required');
  const revisions=await h.db.query<{sequence:number;previous_id:string|null;id:string}>('SELECT sequence,previous_id,id FROM gh_finding_revisions WHERE finding_id=$1 ORDER BY sequence',[supported.findingId]);
  assert.equal(new Set(revisions.map(row=>row.sequence)).size,revisions.length);for(let index=1;index<revisions.length;index++){assert.equal(revisions[index].sequence,revisions[index-1].sequence+1);assert.equal(revisions[index].previous_id,revisions[index-1].id);}
  assert.equal(history.revision.resolvedChallengeRevisionId,null);if(results[0].status==='rejected')assert(failure('FINDING_REVISION_CONFLICT')(results[0].reason));else {assert.equal(history.revision.openChallengeRevisionId,results[0].value.id);const resolved=await h.decide(history.revision,'support');assert.equal(resolved.resolvedChallengeRevisionId,results[0].value.id);assert.equal(resolved.openChallengeRevisionId,null);}
  assert.equal((await h.review(plan.id)).plan.status,'stale');assert.equal((await h.db.query('SELECT id FROM gh_finding_source_changes')).length,1);
  assert.equal((await h.db.query<{count:string}>('SELECT count(*)::text AS count FROM gh_plan_dependency_invalidations WHERE plan_id=$1',[plan.id]))[0].count,'1');
});

test('resource revocation and forged exact references deny finding disclosure, mutations and new reports',async t=>{
  const h=await findingHarness(t),bound=await h.boundCapture(),first=await h.findings.create(h.scoped,h.input({snapshotHash:bound.snapshot.hash,evidenceIds:[bound.snapshot.evidence[0].id]})),supported=await h.decide(first,'support');await h.share(supported);
  assert(supported.dependencies.resources.some(row=>row.id===bound.captureId));
  const {createPlan}=await import('../lib/server/plans');await assert.rejects(createPlan(h.scoped,'targeted',30000,bound.snapshot.hash,[{...findingReference(supported),hash:'0'.repeat(64)}]),failure('FINDING_DEPENDENCY_CHANGED'));
  const {FindingService}=await import('../lib/server/findings/service'),{FindingSecrets}=await import('../lib/server/findings/crypto'),{randomBytes}=await import('node:crypto');
  const wrong=new FindingService(h.db,new FindingSecrets(randomBytes(32).toString('base64')),h.secrets);await assert.rejects(wrong.detail(h.scoped,first.findingId),failure('FINDING_UNVERIFIED'));
  const before=await h.db.query('SELECT private_document FROM gh_finding_revisions ORDER BY sequence');await h.db.query("UPDATE gh_provider_resources SET active=false,version=version+1 WHERE tenant_id=$1 AND kind='capture' AND provider_id=$2",[h.scoped.tenantId,bound.captureId]);
  await assert.rejects(h.findings.detail(h.scoped,first.findingId),failure('FINDING_RESOURCE_ACCESS_CHANGED'));
  await assert.rejects(h.decide(supported,'retract'),failure('FINDING_RESOURCE_ACCESS_CHANGED'));
  await assert.rejects(h.service.create(h.scoped,h.reportInput({snapshotHash:bound.snapshot.hash,findingDependencies:[findingReference(supported)]})),/grant is missing or inactive/);
  assert.deepEqual(await h.db.query('SELECT private_document FROM gh_finding_revisions ORDER BY sequence'),before);
});

test('new scope members and newly ingested counterevidence invalidate the old interpretation without fabricated count deltas',async t=>{
  const h=await findingHarness(t),supported=await h.supported(),plan=await h.prepare(supported),before=await datasetFor(h.scoped,h.db),after=structuredClone(before);
  const added=after.orders.find(row=>!row.incidentMember)!;added.incidentMember=true;after.revision++;
  const change=await h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.scoped.tenantId]);await persistDataset(tx,after);return recordFindingSourceChange(tx,h.scoped,before,after,{kind:'incident_scope',reason:'An explicitly sourced incident membership changed.',sourceId:'scope-addition-fixture'});});
  assert(change);const changed=(await h.findings.detail(h.scoped,supported.findingId)).revision;assert.equal(changed.facts.scopeCount,supported.facts.scopeCount+1);assert(changed.facts.scopeOrderIds.includes(added.id));assert.equal((await h.review(plan.id)).plan.status,'stale');
  const counter=structuredClone(after);counter.evidence.push({...before.evidence.find(row=>row.id==='evidence-finding-carrier-v1')!,id:'new-independent-counter-source',title:'An independently ingested contrary explanation',excerpt:'The changed evidence needs a separate review even when no order count changes.',kind:'contradiction',contradicts:['evidence-finding-carrier-v1'],supports:[]});counter.revision++;
  const second=await h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.scoped.tenantId]);await persistDataset(tx,counter);return recordFindingSourceChange(tx,h.scoped,after,counter,{kind:'counterevidence',reason:'An independent contradictory source was ingested.',sourceId:'counter-source-fixture'});});
  assert(second);const current=(await h.findings.detail(h.scoped,supported.findingId)).revision;assert.equal(current.facts.affectedCount,changed.facts.affectedCount);assert.deepEqual(current.delta?.removedOrderIds,[]);assert(current.citations.some(row=>row.id==='new-independent-counter-source'&&row.relation==='contradicts'));
  assert.equal((await h.findings.detail(h.scoped,supported.findingId)).correctionMoment,null);
  await assert.rejects(h.db.transaction(tx=>recordFindingSourceChange(tx,{...h.scoped,tenantId:'unrelated-merchant'},after,counter,{kind:'forged',reason:'A cross-merchant source cannot enter this journal.',sourceId:'foreign'})),/cannot cross/);
});

test('a genuinely legacy report shape and its saved PDF survive adoption and source corrections byte for byte',async t=>{
  const h=await findingHarness(t),run=await h.begin(),source=h.snapshot.evidence[0];
  const legacy:AgentFinding={id:'legacy-finding-in-preserved-edition',runId:run.run.id,snapshotHash:h.snapshot.hash,revision:h.snapshot.context.cohortVersion,title:'Preserved earlier hypothesis',interpretation:'The earlier saved edition contained this originally shared source interpretation.',counterpoint:'Its frozen source does not prove a physical cause.',status:'hypothesis',evidence:[{id:source.id,title:source.title,sourceClass:source.sourceClass,sourceLabel:source.sourceLabel,occurredAt:source.occurredAt,ingestedAt:source.ingestedAt,hash:hash(source)}],facts:snapshotFacts(h.snapshot),sourceCoverage:h.snapshot.sourceCoverage,tools:[],createdAt:new Date().toISOString()};
  const encrypted=h.secrets.seal(h.scoped.tenantId,'document',legacy.id,legacy);await h.db.query("INSERT INTO gh_agent_documents(tenant_id,id,run_id,kind,snapshot_hash,private_document) VALUES($1,$2,$3,'finding',$4,$5)",[h.scoped.tenantId,legacy.id,run.run.id,legacy.snapshotHash,encrypted]);
  const base=await h.service.create(h.scoped,h.reportInput()),document=structuredClone(base.document);document.id='report-legacy-fixture-'+randomUUID();document.findings=[legacy];delete document.findingRevisions;
  const summary={...base.summary,id:document.id,findingCount:1,documentHash:hash(document)},secrets=new ReportSecrets(h.key);
  await h.db.query(`INSERT INTO gh_report_editions(tenant_id,id,created_by,membership_version,request_id,request_hash,document_hash,snapshot_hash,layout_version,layout_hash,parent_id,private_document,private_summary,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[h.scoped.tenantId,document.id,h.scoped.id,h.scoped.membershipVersion,randomUUID(),hash({legacyFixture:true}),summary.documentHash,document.snapshot.hash,document.layout.version,document.layout.hash,null,secrets.seal(h.scoped.tenantId,'edition',document.id,document),secrets.seal(h.scoped.tenantId,'summary',document.id,{summary,grants:document.grants}),document.createdAt]);
  const service=new ReportService(h.db,secrets,new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:renderReportPdf});const json=JSON.stringify(await service.read(h.scoped,document.id),null,2)+'\n',pdf=await service.pdf(h.scoped,document.id,'LETTER');
  const stored=await h.db.query('SELECT private_document,private_summary,document_hash FROM gh_report_editions WHERE id=$1',[document.id]);
  const adopted=await h.findings.adopt(h.scoped,{requestId:randomUUID(),documentId:legacy.id,documentHash:hash(legacy),reason:'Start a new lifecycle beside the original shared report edition.'});await h.revise();
  assert.equal(JSON.stringify(await service.read(h.scoped,document.id),null,2)+'\n',json);assert.deepEqual((await service.pdf(h.scoped,document.id,'LETTER')).bytes,pdf.bytes);assert.deepEqual(await h.db.query('SELECT private_document,private_summary,document_hash FROM gh_report_editions WHERE id=$1',[document.id]),stored);
  assert.equal((await h.db.query<{private_document:string}>('SELECT private_document FROM gh_agent_documents WHERE id=$1',[legacy.id]))[0].private_document,encrypted);
  const notice=await service.corrections(h.scoped,document.id);assert.equal(notice.notices[0].findingId,adopted.findingId);assert.equal(notice.notices[0].delta?.removedOrderIds.length,9);
  const current=(await h.findings.detail(h.scoped,adopted.findingId)).revision,reviewed=await h.decide(current,'support');await h.share(reviewed);
  const dataset=await datasetFor(h.scoped,h.db),snapshot=await h.saveSnapshot(buildSnapshot(dataset,snapshotContext(h.scoped,dataset)));
  const later=await service.create(h.scoped,h.reportInput({snapshotHash:snapshot.hash,parentId:document.id,findingDependencies:[findingReference(reviewed)]}));assert.equal(later.document.parentId,document.id);assert.equal(later.document.findingRevisions?.[0].id,reviewed.id);assert.deepEqual(later.document.findings,[]);
});
