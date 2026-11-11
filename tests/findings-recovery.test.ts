import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {agentHarness} from './helpers/agents';
import {recoveryHarness} from './helpers/recovery';
import {FindingService,findingReference} from '../lib/server/findings/service';
import {FindingSecrets} from '../lib/server/findings/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {createPlan} from '../lib/server/plans';
import {snapshotFor} from '../lib/server/snapshots';
import {exactPlanHash} from '../lib/server/recovery/contracts';
import {failure} from './helpers/workspaces';
import type {FindingRevision} from '../packages/findings/types';
import type {Operation,RecoveryPlan} from '../packages/domain/types';

async function setup(t:import('node:test').TestContext,count=1){
  const base=await agentHarness(),h=await recoveryHarness(count,{db:base.db,close:base.dispose});t.after(()=>h.pg.close());
  const original=globalThis.glasshouseDatabase;globalThis.glasshouseDatabase=Promise.resolve(h.db);t.after(()=>{globalThis.glasshouseDatabase=original;});
  const findings=new FindingService(h.db,new FindingSecrets(process.env.GLASSHOUSE_FINDING_KEY!),new AgentSecrets(base.key));
  const snapshot=await snapshotFor(h.who),finding=await findings.create(h.who,{requestId:randomUUID(),snapshotHash:snapshot.hash,title:'Synthetic recovery source interpretation',interpretation:'These exact independently bound synthetic transport captures retain the observed shipping delay scope.',counterpoint:'Synthetic transport qualification establishes implementation behavior, not a real provider outcome.',evidenceIds:['evidence-finding-carrier-v1'],counterEvidenceIds:[],reason:'Create a bounded interpretation for final dispatch qualification.'});
  const decide=(revision:FindingRevision,action:'support'|'challenge'|'retract')=>findings.decide(h.who,revision.findingId,{requestId:randomUUID(),expectedRevisionId:revision.id,expectedHash:revision.hash,action,reason:'A separately attributed test decision against the exact current source scope.'});
  const supported=await decide(finding,'support');await findings.share(h.who,finding.findingId,{requestId:randomUUID(),revisionId:supported.id,hash:supported.hash});
  const plan=await createPlan(h.who,'targeted',30000,snapshot.hash,[findingReference(supported)]);
  return {...h,findings,finding:supported,plan,decide};
}

test('a committed finding challenge during the last provider reads prevents every unstarted refund dispatch',async t=>{
  const h=await setup(t);await h.approveAndQueue(h.plan);let challenged=false;
  h.fixture.onRead=async path=>{if(!challenged&&path.startsWith('/v2/checkout/orders/')){challenged=true;await h.decide(h.finding,'challenge');}};
  await h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,kind:'refund',limit:1});
  assert.equal(challenged,true);assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/refund')).length,0);
  const operation=(await h.db.query<{body:Operation}>("SELECT body FROM gh_operations WHERE tenant_id=$1 AND body->>'kind'='refund'",[h.who.tenantId]))[0].body;
  assert(['blocked','provider_failed'].includes(operation.status),JSON.stringify(operation));
  assert.equal((await h.db.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE id=$1',[h.plan.id]))[0].body.status,'stale');
});

test('original ambiguous refund reconciliation continues after finding challenge and membership revocation without another POST',async t=>{
  const h=await setup(t);await h.approveAndQueue(h.plan);h.fixture.refundLost=true;
  await h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,kind:'refund',limit:1});
  const original=(await h.db.query<{id:string;status:string}>("SELECT id,status FROM gh_recovery_intents WHERE tenant_id=$1 AND kind='refund'",[h.who.tenantId]))[0];assert.equal(original.status,'unknown_outcome');assert.equal(h.fixture.refunds.size,1);
  await h.decide(h.finding,'challenge');await h.db.query('UPDATE gh_memberships SET active=false,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[h.who.tenantId,h.who.id]);
  h.fixture.readsUnavailable=false;await h.due();await h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,kind:'refund',limit:1});
  const recovered=(await h.db.query<{id:string;status:string}>("SELECT id,status FROM gh_recovery_intents WHERE tenant_id=$1 AND kind='refund'",[h.who.tenantId]))[0];assert.equal(recovered.id,original.id);assert.equal(recovered.status,'provider_success');assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/refund')).length,1);
  assert.equal((await h.db.query<{status:string}>('SELECT status FROM gh_plans WHERE id=$1',[h.plan.id]))[0].status,'stale');
});

test('v3 dependency index tampering, stale queue and original v2 hash compatibility are checked independently',async t=>{
  const h=await setup(t),legacy=h.plan;
  const baseline:RecoveryPlan={...legacy,contractVersion:2};delete baseline.findingDependencies;delete baseline.findingDependencyPolicy;
  assert.equal(exactPlanHash(baseline),exactPlanHash({...baseline,findingDependencies:[findingReference(h.finding)],findingDependencyPolicy:'finding-dependencies-v1'}));
  assert.notEqual(exactPlanHash(legacy),exactPlanHash(baseline));
  await assert.rejects(h.db.query("UPDATE gh_plan_finding_dependencies SET revision_hash=$1 WHERE plan_id=$2",['0'.repeat(64),h.plan.id]),/immutable/);
  await h.recoveryService.approve(h.who,h.plan.id,h.plan.hash,true);await h.decide(h.finding,'retract');
  await assert.rejects(h.recoveryService.enqueue(h.who,h.plan.id,h.plan.hash),failure('FINDING_DEPENDENCY_STALE'));assert.equal((await h.db.query('SELECT id FROM gh_recovery_intents')).length,0);
});

test('two PostgreSQL workers finish one original recovery without treating their own verified receipts as a new causal finding',async t=>{
  const h=await setup(t,2);await h.approveAndQueue(h.plan);
  await Promise.all([h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,limit:4}),h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,limit:4})]);
  const operations=(await h.db.query<{body:Operation}>('SELECT body FROM gh_operations WHERE plan_id=$1',[h.plan.id])).map(row=>row.body);
  assert.equal(operations.length,4);assert(operations.every(row=>row.status==='provider_success'),JSON.stringify(operations.map(row=>({status:row.status,reason:row.reason}))));
  assert.equal((await h.findings.detail(h.who,h.finding.findingId)).revision.id,h.finding.id);
  assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/refund')).length,2);assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/track')).length,2);
});

async function admitApprovalSession(h:Awaited<ReturnType<typeof setup>>){
  const {randomBytes}=await import('node:crypto'),{WorkspaceService}=await import('../lib/server/workspaces/service'),{WorkspaceSecrets,tokenHash}=await import('../lib/server/workspaces/crypto'),{sessionWorkspaceContext}=await import('../lib/server/workspaces/authority');
  const token=randomBytes(32).toString('hex'),sessionHash=tokenHash(token),service=new WorkspaceService(h.db,new WorkspaceSecrets(process.env.GLASSHOUSE_FINDING_KEY!));
  await h.db.query("INSERT INTO gh_sessions(token_hash,actor,expires_at) VALUES($1,$2::jsonb,now()+interval '1 hour')",[sessionHash,JSON.stringify(h.who)]);const bootstrap=await service.admit(h.who,token),credential={sessionHash,contextId:bootstrap.identity.contextId};
  const actor=await h.db.transaction(tx=>sessionWorkspaceContext(tx,h.who,sessionHash,credential.contextId));return {service,bootstrap,credential,actor};
}

test('the original v3 approval session must remain current through queue and the last provider dispatch boundary',async t=>{
  const h=await setup(t),session=await admitApprovalSession(h);await h.recoveryService.approve(session.actor,h.plan.id,h.plan.hash,true);await h.recoveryService.enqueue(session.actor,h.plan.id,h.plan.hash);
  const sealed=(await h.db.query<{private_document:string}>('SELECT private_document FROM gh_plan_finding_authorities WHERE plan_id=$1',[h.plan.id]))[0].private_document;assert.equal(sealed.includes(session.credential.sessionHash),false);
  let expired=false;h.fixture.onRead=async path=>{if(!expired&&path.startsWith('/v2/checkout/orders/')){expired=true;await h.db.query("UPDATE gh_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",[session.credential.sessionHash]);}};
  await h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,kind:'refund',limit:1});assert.equal(expired,true);assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/refund')).length,0);
  assert.equal((await h.db.query<{status:string}>("SELECT status FROM gh_recovery_intents WHERE plan_id=$1 AND kind='refund'",[h.plan.id]))[0].status,'blocked');
  await assert.rejects(h.recoveryService.enqueue(h.who,h.plan.id,h.plan.hash),failure('WORKSPACE_CONTEXT_CHANGED'));
});

test('switching the original approval context holds new writes but still reconciles its ambiguous original refund',async t=>{
  const h=await setup(t),session=await admitApprovalSession(h);await h.recoveryService.approve(session.actor,h.plan.id,h.plan.hash,true);await h.recoveryService.enqueue(session.actor,h.plan.id,h.plan.hash);
  h.fixture.refundLost=true;await h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,kind:'refund',limit:1});
  const original=(await h.db.query<{id:string;status:string}>("SELECT id,status FROM gh_recovery_intents WHERE plan_id=$1 AND kind='refund'",[h.plan.id]))[0];assert.equal(original.status,'unknown_outcome');
  const second=await session.service.createWorkspace(session.credential,{requestId:randomUUID(),organizationId:session.bootstrap.workspace.organizationId!,name:'Separate synthetic merchant',merchantName:'Separate synthetic merchant',description:'Source and authority isolation fixture.'});
  await session.service.switchWorkspace(session.credential,{requestId:randomUUID(),workspaceId:second.id,expectedContextId:session.credential.contextId});
  h.fixture.readsUnavailable=false;await h.due();await h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,kind:'refund',limit:1});
  const recovered=(await h.db.query<{id:string;status:string}>("SELECT id,status FROM gh_recovery_intents WHERE plan_id=$1 AND kind='refund'",[h.plan.id]))[0];assert.equal(recovered.id,original.id);assert.equal(recovered.status,'provider_success');assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/refund')).length,1);
  await h.due();await h.worker().drain({tenantId:h.who.tenantId,planId:h.plan.id,kind:'tracking',limit:1});assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/track')).length,0);
});

test('independent refund inventory and dispute projections share the atomic finding invalidation boundary',async t=>{
  const h=await setup(t),{ensureObservationSchema}=await import('../lib/server/observations/schema'),{bindConnector}=await import('../lib/server/observations/connector'),{projectCapacity}=await import('../lib/server/observations/projection'),{ownedPayment}=await import('../lib/server/recovery/authority'),{digest}=await import('../packages/payments/security');
  await ensureObservationSchema(h.db);const connector={id:'connector-findings-synthetic',tenantId:h.who.tenantId,credentialHash:digest('synthetic-fixture-only'),webhookId:'SYNTHETIC_WEBHOOK_FIXTURE',merchantId:'SYNTHETIC_MERCHANT_FIXTURE',configHash:digest('synthetic-connector-binding')};await bindConnector(h.db,connector);
  const owned=await ownedPayment(h.db,h.who,h.ids[0]),capacity=await h.recoveryEvidence.capacity(owned);await projectCapacity(h.db,connector,owned,capacity);
  const revised=(await h.findings.detail(h.who,h.finding.findingId)).revision;assert.equal(revised.state,'revised');assert.equal(revised.event,'source_revised');assert.equal(revised.actorRole,'source');assert.equal(revised.interpretationReview,'required');assert.deepEqual(revised.delta?.changedOrderIds,[owned.orderId]);assert.deepEqual(revised.delta?.staleDependentPlanIds,[h.plan.id]);
  const count=(await h.db.query('SELECT id FROM gh_finding_revisions')).length;await projectCapacity(h.db,connector,owned,{...capacity,observedAt:new Date(Date.parse(capacity.observedAt)+1).toISOString()});assert.equal((await h.db.query('SELECT id FROM gh_finding_revisions')).length,count);
  const supported=await h.decide(revised,'support');await h.findings.share(h.who,supported.findingId,{requestId:randomUUID(),revisionId:supported.id,hash:supported.hash});const snapshot=await snapshotFor(h.who),next=await createPlan(h.who,'targeted',30000,snapshot.hash,[findingReference(supported)]);
  const {projectDispute}=await import('../lib/server/recovery/dispute-service');const now=new Date().toISOString();const observation:import('../lib/server/recovery/disputes').DisputeObservation={id:'SYNTHETIC_CASE_FINDING',captureId:owned.captureId,buyerTransactionId:'SYNTHETIC_BUYER_TRANSACTION',reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',status:'WAITING_FOR_SELLER_RESPONSE',stage:'INQUIRY',amountMinor:owned.entry.amountMinor,grossAmountMinor:owned.entry.amountMinor,currency:'USD',createdAt:now,updatedAt:now,sellerResponseDueAt:new Date(Date.now()+86400000).toISOString(),actions:['provide-evidence'],evidence:[{type:'PROOF_OF_FULFILLMENT',source:'REQUESTED_FROM_SELLER',date:now,itemId:null,notesHash:null,tracking:[]}],observedAt:now,bodyHash:digest('synthetic-source-case-proof'),debugId:null};
  const project=()=>h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.who.tenantId]);return projectDispute(tx,h.who,owned,observation);});await project();
  const dispute=(await h.findings.detail(h.who,h.finding.findingId)).revision;assert.equal(dispute.facts.openDisputes,1);assert.equal(dispute.state,'revised');assert.deepEqual(dispute.delta?.staleDependentPlanIds,[next.id]);assert(dispute.dependencies.resources.some(row=>row.kind==='dispute'&&row.id===observation.id));
  await project();assert.equal((await h.findings.detail(h.who,h.finding.findingId)).revision.id,dispute.id);assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/refund')).length,0);assert.equal(h.cases.posts.length,0);
});

test('a new independently verified payment capture invalidates an existing sourced interpretation and exact draft',async t=>{
  const h=await setup(t),{datasetFor,persistDataset}=await import('../lib/server/repository'),{recordFindingSourceChange}=await import('../lib/server/findings/sources');
  const before=await datasetFor(h.who,h.db),after=structuredClone(before);for(const [index,order] of after.orders.entries())order.incidentMember=index<63;after.revision++;
  await h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.who.tenantId]);await persistDataset(tx,after);await recordFindingSourceChange(tx,h.who,before,after,{kind:'synthetic_scope_setup',reason:'Explicit synthetic fixture scope setup before the capture observation.',sourceId:'full-incident-fixture'});});
  const current=(await h.findings.detail(h.who,h.finding.findingId)).revision,supported=await h.decide(current,'support');await h.findings.share(h.who,supported.findingId,{requestId:randomUUID(),revisionId:supported.id,hash:supported.hash});const snapshot=await snapshotFor(h.who),draft=await createPlan(h.who,'targeted',30000,snapshot.hash,[findingReference(supported)]);
  await h.db.query("UPDATE gh_seed_items SET next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1 AND order_id='fernwood-order-0015'",[h.who.tenantId]);await h.executor.drain({tenantId:h.who.tenantId,runId:h.run.id,limit:1});
  const revised=(await h.findings.detail(h.who,h.finding.findingId)).revision;assert.equal(revised.previousRevisionId,supported.id);assert.equal(revised.actorRole,'source');assert.equal(revised.facts.affectedCount,supported.facts.affectedCount);assert.deepEqual(revised.delta?.changedOrderIds,['fernwood-order-0015']);assert(revised.delta?.staleDependentPlanIds.includes(draft.id));assert(revised.dependencies.resources.some(row=>row.orderId==='fernwood-order-0015'&&row.kind==='capture'));
});

test('explicit scenario projections retain monetary receipts and revise the finding when four incident members change',async t=>{
  const h=await setup(t),{datasetFor,persistDataset}=await import('../lib/server/repository'),{applyDeliveryRevision}=await import('../packages/domain'),{ScenarioService}=await import('../lib/server/recovery/scenario-service');
  const pairs=[{originalOrderId:'fernwood-order-0010',targetOrderId:'fernwood-order-0600'},{originalOrderId:'fernwood-order-0011',targetOrderId:'fernwood-order-0596'},{originalOrderId:'fernwood-order-0012',targetOrderId:'fernwood-order-0592'},{originalOrderId:'fernwood-order-0013',targetOrderId:'fernwood-order-0593'}],ids=pairs.flatMap(row=>[row.originalOrderId,row.targetOrderId]);
  await h.db.query("UPDATE gh_seed_items SET next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1 AND order_id=ANY($2::text[])",[h.who.tenantId,ids]);await h.executor.drain({tenantId:h.who.tenantId,runId:h.run.id,limit:8,concurrency:1});
  const source=await datasetFor(h.who,h.db);for(const [index,order] of source.orders.entries())order.incidentMember=index<63;await persistDataset(h.db,applyDeliveryRevision(source));
  const snapshot=await snapshotFor(h.who),proposed=await h.findings.create(h.who,{requestId:randomUUID(),snapshotHash:snapshot.hash,title:'Synthetic intended-case interpretation',interpretation:'This reviewed scope names the currently intended synthetic case targets.',counterpoint:'An intended case is not an observed provider dispute.',evidenceIds:['evidence-finding-carrier-v2'],counterEvidenceIds:[],reason:'Capture the precise synthetic scenario scope before its explicit revision.'}),supported=await h.decide(proposed,'support');await h.findings.share(h.who,supported.findingId,{requestId:randomUUID(),revisionId:supported.id,hash:supported.hash});const draft=await createPlan(h.who,'targeted',30000,snapshot.hash,[findingReference(supported)]);
  const receipts=await h.db.query('SELECT order_id,provider_order_id,provider_capture_id,entry,receipt FROM gh_seed_items WHERE tenant_id=$1 ORDER BY order_id',[h.who.tenantId]);
  const request={revisionId:'finding-scenario-fixture',pairs:pairs.map((pair,index)=>{const original=h.run.manifest.entries.find(row=>row.orderId===pair.originalOrderId)!,target=h.run.manifest.entries.find(row=>row.orderId===pair.targetOrderId)!;return{originalReference:original.reference,targetReference:target.reference,amountMinor:original.amountMinor,buyerTransactionId:`BUYERFIXTURE000${index+1}A`};})};
  const service=new ScenarioService(h.db,h.cases,h.evidence);await service.revise(h.who,request);const current=(await h.findings.detail(h.who,supported.findingId)).revision;assert.equal(current.state,'revised');assert.equal(current.facts.affectedCount,54);assert.deepEqual(current.delta?.removedOrderIds,pairs.map(row=>row.originalOrderId).sort());assert.deepEqual(current.delta?.addedOrderIds,pairs.map(row=>row.targetOrderId).sort());assert(current.delta?.staleDependentPlanIds.includes(draft.id));
  assert.deepEqual(await h.db.query('SELECT order_id,provider_order_id,provider_capture_id,entry,receipt FROM gh_seed_items WHERE tenant_id=$1 ORDER BY order_id',[h.who.tenantId]),receipts);await service.revise(h.who,request);assert.equal((await h.findings.detail(h.who,supported.findingId)).revision.id,current.id);assert.equal((await h.findings.detail(h.who,supported.findingId)).correctionMoment,null);
});
