import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findingHarness} from './helpers/findings';
import {functionCall,request,tool} from './helpers/agents';
import {failure} from './helpers/workspaces';
import {findingReference} from '../lib/server/findings/service';
import {buildSnapshot} from '../packages/domain';
import {snapshotContext} from '../lib/server/snapshots';
import {hash} from '../lib/server/repository';
import type {FindingRevision} from '../packages/findings/types';
import type {RecoveryPlan} from '../packages/domain/types';

const claim=(h:Awaited<ReturnType<typeof findingHarness>>,runId:string,call:ReturnType<typeof functionCall>)=>h.tools.claim(h.who,{runId,callId:call.call_id,name:call.name,args:JSON.parse(call.arguments),clientId:h.clientId,snapshotHash:h.snapshot.hash});

test('Investigator, Planner and Writer read exact permitted lifecycle versions and cannot grant human support or sharing',async t=>{
  const h=await findingHarness(t),supported=await h.supported(),peer=await h.joinedActor('investigator');
  const privateSnapshot=await h.saveSnapshot(buildSnapshot(h.dataset,snapshotContext(peer.actor,h.dataset))),privateMarker='PEER_PRIVATE_INTERPRETATION_d260';
  const privateFinding=await h.findings.create(peer.actor,h.input({snapshotHash:privateSnapshot.hash,interpretation:privateMarker+' remains creator-only until its exact version is explicitly shared.'}));
  const root=await h.begin(),investigator=await h.handoff(root,'investigator');
  const list=functionCall('read_findings',{});await h.issue(investigator.run.id,[tool('read_findings')],[list]);const listed=await claim(h,investigator.run.id,list);assert.ok(listed.result?.success);assert.equal(JSON.stringify(listed.result).includes(privateFinding.findingId),false);assert.equal(JSON.stringify(listed.result).includes(privateMarker),false);
  const exact=functionCall('read_finding',{findingId:supported.findingId,revisionId:supported.id});await h.issue(investigator.run.id,[tool('read_finding')],[exact]);const read=await claim(h,investigator.run.id,exact);assert.ok(read.result?.success);assert.equal((read.result.data as {revision:FindingRevision}).revision.hash,supported.hash);
  const denied=functionCall('read_finding',{findingId:privateFinding.findingId});await h.issue(investigator.run.id,[tool('read_finding')],[denied]);const inaccessible=await claim(h,investigator.run.id,denied);assert.equal(inaccessible.result?.success,false);assert.equal(JSON.stringify(inaccessible.result).includes(privateMarker),false);
  const beforeCreates=h.fixture.creates.length;
  for(const name of ['support_finding','share_finding','retract_finding','approve_plan'])await assert.rejects(h.models.submit(h.who,{runId:investigator.run.id,index:77,request:request([tool(name)]),clientId:h.clientId,snapshotHash:h.snapshot.hash}),failure('AGENT_TOOL_DENIED'));
  assert.equal(h.fixture.creates.length,beforeCreates);
  const planner=await h.handoff(await h.begin('Prepare from the explicitly selected shared finding.'),'planner'),prepare=functionCall('prepare_recovery',{branchId:'targeted',budgetMinor:30000,findingDependencies:[findingReference(supported)]});await h.issue(planner.run.id,[tool('prepare_recovery')],[prepare]);const proposed=await claim(h,planner.run.id,prepare);assert.ok(proposed.result?.success);
  const plan=(await h.db.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans'))[0].body;assert.equal(plan.contractVersion,3);assert.deepEqual(plan.findingDependencies,[findingReference(supported)]);assert.equal(plan.approvedBy,null);
  const challenged=await h.decide(supported,'challenge');const inspect=functionCall('read_recovery_proposal',{planId:plan.id});await h.issue(planner.run.id,[tool('read_recovery_proposal')],[inspect]);const review=await claim(h,planner.run.id,inspect);assert.ok(review.result?.success);assert.equal((review.result.data as {dependencyReview:{valid:boolean}}).dependencyReview.valid,false);
  const again=functionCall('prepare_recovery',{branchId:'targeted',budgetMinor:30000,findingDependencies:[findingReference(supported)]});await h.issue(planner.run.id,[tool('prepare_recovery')],[again]);assert.equal((await claim(h,planner.run.id,again)).result?.success,false);assert.equal((await h.db.query('SELECT id FROM gh_plans')).length,1);
  const writer=await h.handoff(await h.begin('Write the current permitted lifecycle evidence.'),'writer'),brief=functionCall('write_incident_brief',{});await h.issue(writer.run.id,[tool('write_incident_brief')],[brief]);const written=await claim(h,writer.run.id,brief);assert.ok(written.result?.success);
  const value=written.result.data as {findingVersions:{versions:{revision:FindingRevision}[];humanReviewGranted:boolean}};assert.equal(value.findingVersions.humanReviewGranted,false);assert.equal(value.findingVersions.versions.find(row=>row.revision.findingId===supported.findingId)?.revision.id,challenged.id);assert.equal(JSON.stringify(value).includes(privateMarker),false);
  const encrypted=await h.db.query('SELECT private_document FROM gh_agent_documents');assert.equal(JSON.stringify(encrypted).includes(challenged.interpretation),false);assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);
});

test('agent-created proposals retain the original encrypted document while tool reads remain explicitly bounded',async t=>{
  const h=await findingHarness(t),root=await h.begin(),investigator=await h.handoff(root,'investigator');
  const read=functionCall('read_evidence',{});await h.issue(investigator.run.id,[tool('read_evidence')],[read]);const sources=await claim(h,investigator.run.id,read);assert.ok(sources.result?.success);const evidence=(sources.result.data as {evidence:{id:string}[]}).evidence[0];
  const record=functionCall('record_finding',{hypothesis:'carrier_delay',evidenceIds:[evidence.id],interpretation:'An agent may propose this exact sourced interpretation; it cannot support itself.',counterpoint:'This synthetic transport establishes implementation behavior only.'});await h.issue(investigator.run.id,[tool('record_finding')],[record]);const saved=await claim(h,investigator.run.id,record);assert.ok(saved.result?.success);const proposal=saved.result.data as {id:string;lifecycle:{findingId:string;revisionId:string;hash:string;state:string}};
  assert.equal(proposal.lifecycle.state,'proposed');const current=await h.findings.detail(h.scoped,proposal.lifecycle.findingId);assert.equal(current.summary.shared,false);assert.equal(current.revision.origin.documentId,proposal.id);
  const row=(await h.db.query<{private_document:string}>('SELECT private_document FROM gh_agent_documents WHERE id=$1',[proposal.id]))[0];const original=h.secrets.open<Record<string,unknown>>(h.scoped.tenantId,'document',proposal.id,row.private_document);assert.equal('lifecycle'in original,false);assert.equal(hash(original),current.revision.origin.documentHash);
  await h.decide(current.revision,'support');assert.equal((await h.db.query<{private_document:string}>('SELECT private_document FROM gh_agent_documents WHERE id=$1',[proposal.id]))[0].private_document,row.private_document);
  for(let index=0;index<20;index++)await h.findings.create(h.scoped,h.input({title:'Bounded source interpretation '+index}));
  const list=functionCall('read_findings',{});await h.issue(investigator.run.id,[tool('read_findings')],[list]);const listed=await claim(h,investigator.run.id,list);assert.ok(listed.result?.success);const values=listed.result.data as {findings:unknown[];hasMore:boolean;financialAuthority:boolean};assert.equal(values.findings.length,20);assert.equal(values.hasMore,true);assert.equal(values.financialAuthority,false);
  const peer=await h.joinedActor();assert.equal((await h.findings.list(peer.actor)).findings.length,0);assert.equal((await h.db.query('SELECT * FROM gh_finding_shares')).length,0);
});
