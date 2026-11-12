import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceHarness,routeHarness,failure} from './helpers/workspaces';
import {ensureInstrumentSchema} from '../lib/server/instruments/schema';
import {appendSampleCommerce,saveSourceSelection,sourceSelection} from '../lib/server/instruments/service';
import {datasetFor,persistDataset} from '../lib/server/repository';
import {buildSnapshot} from '../packages/domain';
import {snapshotContext} from '../lib/server/snapshots';
import type {CommerceFact,RecoveryPlan,Snapshot} from '../packages/domain/types';
import {GET,POST} from '../app/api/[...path]/route';

test('persisted resource observations have immutable identities, authoritative K, same-order parents and no monetary fanout',async t=>{
 const h=await workspaceHarness();t.after(h.dispose);routeHarness(t,h);await ensureInstrumentSchema(h.db);
 const before=buildSnapshot(h.dataset,snapshotContext(h.scoped,h.dataset)),order=h.dataset.orders[0],half=Math.floor(order.amountMinor/2),at=order.narrativeCreatedAt;
 const fact=(suffix:string,kind:CommerceFact['kind'],resourceId:string,state:string,amountMinor:number|null,parentResourceId:string|null=null):CommerceFact=>({id:'sample:'+suffix,tenantId:h.saved.tenantId,orderId:order.id,kind,resourceId:'sample:'+resourceId,parentResourceId,state,amountMinor,currency:'USD',quantity:kind==='line'?1:null,occurredAt:order.createdAt,narrativeTime:at,ingestedAt:'2000-01-01T00:00:00.000Z',revision:0,sourceClass:'sample',sourceRef:'fixture://persistent-resource-qualification'});
 const observations=[fact('line-one','line','line-one','ordered',half),fact('line-two','line','line-two','ordered',order.amountMinor-half),fact('capture-one','capture','capture-one','completed',half),fact('capture-two','capture','capture-two','completed',order.amountMinor-half),fact('refund-one','refund','refund-one','completed',100,'sample:capture-one'),fact('refund-pending','refund','refund-pending','pending',200,'sample:capture-two'),fact('ship-one','shipment','ship-one','delivered',null,'sample:line-one'),fact('ship-two','shipment','ship-two','in_transit',null,'sample:line-two')];
 const started=Date.now(),saved=await appendSampleCommerce(h.scoped,observations);assert.equal(saved.alreadyPresent,false);assert.ok(saved.observations.every(row=>Date.parse(row.ingestedAt)>=started&&row.revision===h.dataset.revision+1));
 const current=await datasetFor(h.scoped,h.db),after=buildSnapshot(current,snapshotContext(h.scoped,current)),projected=after.orders.find(row=>row.id===order.id)!;
 assert.equal(projected.lineCount,2);assert.equal(projected.captureCount,2);assert.equal(projected.capturedMinor,order.amountMinor);assert.equal(projected.refundedMinor,100);assert.equal(projected.refundableMinor,order.amountMinor-300);assert.equal(projected.shipmentCount,2);assert.equal(projected.fulfillmentState,'in_transit');assert.equal(after.totals.capturedMinor,before.totals.capturedMinor);assert.equal(after.totals.captures,before.totals.captures+1);
 assert.equal(buildSnapshot(current,before.context).hash,before.hash,'New knowledge cannot rewrite the old immutable source view.');
 const retry=await appendSampleCommerce(h.scoped,observations);assert.equal(retry.alreadyPresent,true);assert.deepEqual(retry.observations,saved.observations);assert.equal((await h.db.query('SELECT id FROM gh_commerce_observations')).length,8);
 await assert.rejects(appendSampleCommerce(h.scoped,[{...observations[0],amountMinor:1}]),failure('COMMERCE_OBSERVATION_IMMUTABLE'));
 await assert.rejects(appendSampleCommerce(h.scoped,[fact('refund-too-large','refund','refund-too-large','completed',order.amountMinor,'sample:capture-one')]),failure('INVALID_COMMERCE_OBSERVATIONS'));
 await assert.rejects(appendSampleCommerce(h.scoped,[{...fact('foreign-parent','refund','foreign-parent','completed',1,'sample:capture-one'),orderId:h.dataset.orders[1].id}]),failure('INVALID_COMMERCE_OBSERVATIONS'));
 await assert.rejects(appendSampleCommerce(h.scoped,[{...fact('provider-claim','capture','provider-claim','completed',1),sourceClass:'sandbox'}]),failure('SAMPLE_SOURCE_REQUIRED'));
 await assert.rejects(h.db.query('UPDATE gh_commerce_observations SET kind=$1 WHERE tenant_id=$2 AND id=$3',['refund',h.saved.tenantId,'sample:line-one']),/append-only/);
 await assert.rejects(h.db.query('DELETE FROM gh_commerce_observations WHERE tenant_id=$1',[h.saved.tenantId]),/append-only/);
 await assert.rejects(persistDataset(h.db,{...current,commerceFacts:[]}),/cannot be removed|immutable|append/i);
 assert.equal((await h.db.query('SELECT id FROM gh_commerce_observations')).length,8);
 assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);assert.equal((await h.db.query('SELECT provider_id FROM gh_provider_resources')).length,0);
});

test('source preferences restore exact pinned T/K and denomination without extending original access or authority',async t=>{
 const h=await workspaceHarness();t.after(h.dispose);const request=routeHarness(t,h);await ensureInstrumentSchema(h.db);
 const source=await h.saveSnapshot(buildSnapshot(h.dataset,snapshotContext(h.scoped,h.dataset,new URLSearchParams({asOf:'2026-11-04T10:00:00Z',knownAt:'2026-11-06T10:00:00Z',currency:'EUR'}))));
 const expiry=await h.db.query('SELECT expires_at FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]),history=await h.db.query('SELECT body FROM gh_layouts WHERE tenant_id=$1',[h.saved.tenantId]);
 await saveSourceSelection(h.scoped,{snapshotHash:source.hash,followLatest:false});const selection=await sourceSelection(h.scoped,h.db);
 assert.equal(selection?.search.get('asOf'),source.context.asOf);assert.equal(selection?.search.get('knownAt'),source.context.knownAt);assert.equal(selection?.search.get('currency'),'EUR');
 const resumed=await POST(request('session',{body:{}}),{params:Promise.resolve({path:['session']})});assert.equal(resumed.status,200);const body=await resumed.json();assert.equal(body.snapshot.hash,source.hash);assert.equal(body.sourceSelection.followLatest,false);
 await saveSourceSelection(h.scoped,{snapshotHash:source.hash,followLatest:true});assert.equal((await sourceSelection(h.scoped,h.db))?.search.has('knownAt'),false);
 assert.deepEqual(await h.db.query('SELECT expires_at FROM gh_sessions WHERE token_hash=$1',[h.sessionHash]),expiry);assert.deepEqual(await h.db.query('SELECT body FROM gh_layouts WHERE tenant_id=$1',[h.saved.tenantId]),history);
 await assert.rejects(saveSourceSelection(h.scoped,{snapshotHash:'f'.repeat(64),followLatest:false}),failure('SOURCE_SELECTION_CHANGED'));
 const wrong=await h.saveSnapshot(buildSnapshot(h.dataset,{...source.context,rolePolicyVersion:'roles-v1:2'}));await assert.rejects(saveSourceSelection(h.scoped,{snapshotHash:wrong.hash,followLatest:false}),failure('SOURCE_SELECTION_CHANGED'));
 await h.db.query('UPDATE gh_memberships SET version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]);await assert.rejects(sourceSelection(h.scoped,h.db));
});

test('actual route contracts freeze the exact selected branch and reject bad clocks and empty or foreign scopes',async t=>{
 const h=await workspaceHarness();t.after(h.dispose);const request=routeHarness(t,h);await ensureInstrumentSchema(h.db);
 const snapshot=await h.saveSnapshot(buildSnapshot(h.dataset,snapshotContext(h.scoped,h.dataset))),eligible=snapshot.branches[0].rows.find(row=>row.eligible)!;
 const post=async(path:string,body:unknown)=>POST(request(path,{body}),{params:Promise.resolve({path:path.split('/')})});
 const created=await post('plans',{branchId:'targeted',budgetMinor:500,snapshotHash:snapshot.hash,orderIds:[eligible.orderId]}),plan=await created.json() as RecoveryPlan;
 assert.equal(created.status,200,JSON.stringify(plan));assert.deepEqual(plan.branch.scopeOrderIds,[eligible.orderId]);assert.equal(plan.branch.eligibleCount,1);assert.equal(plan.branch.refundTotalMinor,500);assert.ok(plan.branch.actions.every(action=>action.orderId===eligible.orderId));
 const reviewed=await GET(request('plans/'+plan.id+'/review'),{params:Promise.resolve({path:['plans',plan.id,'review']})});assert.equal(reviewed.status,200);
 const approved=await post('plans/'+plan.id+'/approve',{hash:plan.hash});assert.equal(approved.status,200,JSON.stringify(await approved.clone().json()));assert.equal((await approved.json()).hash,plan.hash);
 for(const scope of [[],['foreign-order'],[eligible.orderId,eligible.orderId]]){const response=await post('plans',{branchId:'targeted',budgetMinor:500,snapshotHash:snapshot.hash,orderIds:scope});assert.equal(response.status,scope.length?400:409);assert.equal((await response.json()).code,scope.length?'INVALID_SCOPE':'NO_ACTIONS');}
 for(const search of ['asOf=not-a-clock','knownAt=2026-11-06','currency=JPY','clock=imagined','generationId=1.5','generationId=-1','generationId=1e100'])assert.equal((await GET(request('snapshots?'+search),{params:Promise.resolve({path:['snapshots']})})).status,400,search);
 assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);assert.equal((await h.db.query('SELECT provider_id FROM gh_provider_resources')).length,0);
});

test('viewer and expired sessions cannot save source choices or append resource observations',async t=>{
 const h=await workspaceHarness('viewer');t.after(h.dispose);const request=routeHarness(t,h);await ensureInstrumentSchema(h.db);
 for(const path of ['snapshot-selection','commerce/observations']){
  const input=path==='snapshot-selection'?{snapshotHash:h.snapshot.hash,followLatest:false}:{observations:[{id:'sample:attempt'}]};
  const response=await POST(request(path,{body:input}),{params:Promise.resolve({path:path.split('/')})});assert.equal(response.status,403);
 }
 await h.db.query('UPDATE gh_sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1',[h.sessionHash]);
 const response=await POST(request('snapshot-selection',{body:{snapshotHash:h.snapshot.hash,followLatest:false}}),{params:Promise.resolve({path:['snapshot-selection']})});assert.equal(response.status,401);assert.equal((await h.db.query('SELECT * FROM gh_instrument_source_selections')).length,0);
});
