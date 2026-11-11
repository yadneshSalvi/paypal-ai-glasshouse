import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeliveryRevision, buildSnapshot, createSeedDataset, stableHash } from '../packages/domain';
import { reviseDisputeScenario } from '../packages/domain/scenario';
import { ScenarioService, type ScenarioRequest } from '../lib/server/recovery/scenario-service';
import { paymentHarness, approvedRun } from './helpers/payments';
import { ensureRecoverySchema } from '../lib/server/recovery/schema';
import { datasetFor, persistDataset } from '../lib/server/repository';
import type { DisputeInventory } from '../lib/server/recovery/disputes';
import type { DisputeObservation } from '../lib/server/recovery/disputes';
import { ownedPayment } from '../lib/server/recovery/authority';
import { projectDispute } from '../lib/server/recovery/dispute-service';

const pairs=[{originalOrderId:'fernwood-order-0010',targetOrderId:'fernwood-order-0600'},
  {originalOrderId:'fernwood-order-0011',targetOrderId:'fernwood-order-0596'},
  {originalOrderId:'fernwood-order-0012',targetOrderId:'fernwood-order-0592'},
  {originalOrderId:'fernwood-order-0013',targetOrderId:'fernwood-order-0593'}];
test('explicit fixture case revision preserves original payments and earlier snapshots while retaining all cohort counts',()=>{
  const original=applyDeliveryRevision(createSeedDataset('scenario-tenant'));
  const before=buildSnapshot(original,{knownAt:'2026-11-10T23:30:00.000Z'});
  const revised=reviseDisputeScenario(original,pairs,'controlled-cases-v2','2026-11-11T00:00:00.000Z');
  assert.equal(buildSnapshot(revised,before.context).hash,before.hash);
  assert.deepEqual(revised.orders.map(({resourceVersion,...order})=>order),original.orders.map(({resourceVersion,...order})=>order));
  assert.deepEqual(revised.events.slice(0,original.events.length),original.events);
  const current=buildSnapshot(revised,{knownAt:'2026-11-11T00:00:00.000Z'});
  assert.equal(current.totals.affected,54);assert.equal(current.totals.capturedMinor,before.totals.capturedMinor);
  assert.equal(current.branches[0].actions.length,105);assert.equal(current.branches[0].refundTotalMinor,19000);assert.equal(current.branches[1].refundTotalMinor,25000);
  for(const pair of pairs){
    const moved=current.orders.find(order=>order.id===pair.targetOrderId)!;
    assert.equal(moved.incidentMember,true);assert.equal(moved.disputeSource,'sample');assert.equal(moved.disputeId,null);assert.equal(moved.disputeDueAt,null);assert.equal(moved.disputeOpen,true);
    assert.equal(moved.trackingNumber,original.orders.find(order=>order.id===pair.targetOrderId)!.trackingNumber);
    assert.equal(current.orders.find(order=>order.id===pair.originalOrderId)!.incidentMember,false);
    const action=current.branches[0].actions.find(action=>action.orderId===moved.id&&action.kind==='dispute_response')!;
    assert(action.evidenceIds.every(id=>current.evidence.some(evidence=>evidence.id===id&&evidence.supports.some(ref=>ref.startsWith('fixture:scenario:')))));
  }
  assert.throws(()=>reviseDisputeScenario(revised,pairs,'controlled-cases-v2','2026-11-11T00:01:00.000Z'),/already exists/);
  assert.throws(()=>reviseDisputeScenario(original,[...pairs.slice(0,3),{...pairs[3],targetOrderId:pairs[0].targetOrderId}],'invalid','2026-11-11T00:00:00.000Z'),/distinct/);
  const paid=structuredClone(original);paid.orders[9].disputeSource='sandbox';
  // A provider case cannot be replaced by changing a raw field: the temporal provider source is authoritative.
  paid.events.find(event=>event.orderId===paid.orders[9].id&&event.type==='dispute.open')!.sourceClass='sandbox';
  paid.intervals.filter(row=>row.orderId===paid.orders[9].id&&row.dimension==='dispute'&&row.state==='open').forEach(row=>{row.sourceClass='sandbox';});
  assert.throws(()=>reviseDisputeScenario(paid,pairs,'invalid','2026-11-11T00:00:00.000Z'),/unused fixture/);
});

test('SQL scenario revision proves all eight owned captures, preserves the immutable seed, and is idempotent',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());await ensureRecoverySchema(h.db);
  const run=await approvedRun(h);await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  const ids=pairs.flatMap(pair=>[pair.originalOrderId,pair.targetOrderId]);
  await h.db.query("UPDATE gh_seed_items SET next_attempt_at=now()+interval '1 day' WHERE tenant_id=$1 AND NOT(order_id=ANY($2::text[]))",[h.who.tenantId,ids]);
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:8,concurrency:1});
  await persistDataset(h.db,applyDeliveryRevision(await datasetFor(h.who,h.db)));
  const request:ScenarioRequest={revisionId:'controlled-cases-v2',pairs:pairs.map((pair,index)=>{
    const original=run.manifest.entries.find(entry=>entry.orderId===pair.originalOrderId)!,target=run.manifest.entries.find(entry=>entry.orderId===pair.targetOrderId)!;
    return{originalReference:original.reference,targetReference:target.reference,amountMinor:original.amountMinor,buyerTransactionId:`BUYERFIXTURE000${index+1}A`};
  })};
  let hasCase=false;const reads:string[]=[];
  const list=async(owner:{captureId:string}):Promise<DisputeInventory>=>{reads.push(owner.captureId);return{captureId:owner.captureId,ids:hasCase?['PP-R-existing']:[],complete:true,observedAt:new Date().toISOString(),bodyHash:stableHash(owner),pages:[{status:200,debugId:null,bodyHash:stableHash(owner)}]};};
  const service=new ScenarioService(h.db,{list},h.evidence);
  const before=await h.db.query('SELECT order_id,provider_order_id,provider_capture_id,entry,receipt FROM gh_seed_items WHERE tenant_id=$1 ORDER BY order_id',[h.who.tenantId]);
  hasCase=true;await assert.rejects(()=>service.revise(h.who,request),/real provider case/);
  assert.equal((await h.db.query('SELECT id FROM gh_scenario_revisions')).length,0);
  hasCase=false;const report=await service.revise(h.who,request);assert.equal((report.counts as {actions:number}).actions,105);
  assert.equal((await h.db.query('SELECT target_order_id FROM gh_dispute_scenario_bindings')).length,4);
  const target=await ownedPayment(h.db,h.who,pairs[0].targetOrderId),now=new Date().toISOString();
  const wrongBuyer:DisputeObservation={id:'PP-R-WRONG-BUYER',captureId:target.captureId,buyerTransactionId:'FOREIGN-BUYER',reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',status:'OPEN',stage:'INQUIRY',amountMinor:target.entry.amountMinor,grossAmountMinor:target.entry.amountMinor,currency:'USD',createdAt:now,updatedAt:now,sellerResponseDueAt:null,actions:[],evidence:[],observedAt:now,bodyHash:'wrong-buyer-proof',debugId:null};
  await assert.rejects(()=>h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.who.tenantId]);await projectDispute(tx,h.who,target,wrongBuyer);}),/buyer transaction/);
  assert.equal((await h.db.query("SELECT provider_id FROM gh_provider_resources WHERE kind='dispute'")).length,0);
  assert.deepEqual(await h.db.query('SELECT order_id,provider_order_id,provider_capture_id,entry,receipt FROM gh_seed_items WHERE tenant_id=$1 ORDER BY order_id',[h.who.tenantId]),before);
  const calls=reads.length;assert.deepEqual(await service.revise(h.who,request),report);assert.equal(reads.length,calls);
  await assert.rejects(()=>service.revise(h.who,{...request,pairs:request.pairs.map((pair,index)=>index?pair:{...pair,buyerTransactionId:'BUYERFIXTURE9999A'})}),/different immutable mapping/);
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);
  await assert.rejects(()=>service.revise(h.who,request),/Current workspace/);
});
