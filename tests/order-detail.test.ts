import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryHarness } from './helpers/recovery';
import { buildSnapshot } from '../packages/domain';
import type { Snapshot } from '../packages/domain';
import { datasetFor } from '../lib/server/repository';
import { orderDetailFor } from '../lib/server/order-detail';
import { buildOrderDetail,type StoredProviderObservation } from '../packages/domain/order-detail';

test('order drill-through stays on the exact saved T/K after later refund and tracking results',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());
  const save=async(snapshot:Snapshot)=>{await h.db.query('INSERT INTO gh_snapshots(tenant_id,id,hash,context,table_hashes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT DO NOTHING',
    [h.who.tenantId,snapshot.id,snapshot.hash,JSON.stringify(snapshot.context),JSON.stringify(snapshot.tableHashes)]);return snapshot;};
  const context={roleScope:h.who.role,rolePolicyVersion:`roles-v1:${h.who.membershipVersion}`,knownAt:new Date().toISOString()};
  const before=await save(buildSnapshot(await datasetFor(h.who,h.db),context));
  const original=await orderDetailFor(h.who,h.ids[0],before.hash,h.db);
  assert.equal(original.order.refundedMinor,0);assert.equal(original.providerReceipts.length,1);assert.equal(original.providerReceipts[0].kind,'capture');
  const plan=await h.plan();await h.approveAndQueue(plan);await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4});
  assert.deepEqual(await orderDetailFor(h.who,h.ids[0],before.hash,h.db),original);
  const dataset=await datasetFor(h.who,h.db),after=await save(buildSnapshot(dataset,{...context,knownAt:new Date().toISOString()}));
  const current=await orderDetailFor(h.who,h.ids[0],after.hash,h.db);
  assert.equal(current.order.refundedMinor,500);assert.equal(current.order.fulfillmentState,'delayed');assert.equal(current.order.trackingInPayPal,true);
  assert.deepEqual(current.providerReceipts.map(receipt=>receipt.kind).sort(),['capture','refund','tracking']);
  assert(current.events.every(event=>Date.parse(event.ingestedAt)<=Date.parse(after.context.knownAt)&&Date.parse(event.narrativeTime)<=Date.parse(after.context.asOf)));
  assert(current.providerReceipts.some(receipt=>receipt.kind==='tracking'&&receipt.fixtureShipping&&receipt.fieldVerification==='approved_request_and_returned_identity'));
  // Real provider occurrence is later than the narrative replay. The observed-clock
  // drawer cannot expose those receipts or source excerpts before that occurrence.
  const observed=await save(buildSnapshot(dataset,{...after.context,clockDomain:'observed',asOf:'2026-11-06T10:00:00.000Z'}));
  const historical=await orderDetailFor(h.who,h.ids[0],observed.hash,h.db);
  assert.equal(historical.providerReceipts.length,0);assert.equal(historical.order.captureId,null);
  assert(historical.events.every(event=>event.sourceClass!=='sandbox'));assert(historical.evidence.every(evidence=>evidence.sourceClass!=='sandbox'));
  const early=await save(buildSnapshot(dataset,{...context,asOf:'2026-11-02T00:00:00.000Z'}));
  await assert.rejects(()=>orderDetailFor(h.who,h.ids[0],early.hash,h.db),/outside the selected time/);
  await assert.rejects(()=>orderDetailFor(h.who,'foreign-order',after.hash,h.db),/outside the selected time/);
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);
  await assert.rejects(()=>orderDetailFor(h.who,h.ids[0],after.hash,h.db),/Current workspace membership/);
});

test('provider receipt drill-through requires admitted source hash and exact tenant, order, resource and cutoff; private fields stay server-side',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const dataset=await datasetFor(h.who,h.db),snapshot=buildSnapshot(dataset,{knownAt:new Date().toISOString()});
  const order=snapshot.orders.find(order=>order.id===h.ids[0])!;
  const row=(await h.db.query<{body:Record<string,unknown>;body_hash:string;observed_at:Date}>('SELECT body,body_hash,observed_at FROM gh_provider_observations WHERE order_id=$1',[order.id]))[0];
  const receipt:StoredProviderObservation={tenantId:h.who.tenantId,orderId:order.id,resourceId:order.captureId!,kind:'capture',bodyHash:row.body_hash,observedAt:new Date(row.observed_at).toISOString(),
    body:{...row.body,buyerTransactionId:'PRIVATE_BUYER_SENTINEL',payer:{email:'PRIVATE_EMAIL_SENTINEL'},accessToken:'PRIVATE_TOKEN_SENTINEL'}};
  const detail=buildOrderDetail(dataset,snapshot,order.id,[receipt])!;
  assert.equal(detail.providerReceipts.length,1);assert.equal(JSON.stringify(detail).includes('SENTINEL'),false);
  const variants:StoredProviderObservation[]=[{...receipt,tenantId:'other-tenant'},{...receipt,orderId:'other-order'},
    {...receipt,resourceId:'OTHER_CAPTURE'},{...receipt,bodyHash:'unadmitted-hash'},
    {...receipt,observedAt:new Date(Date.parse(snapshot.context.knownAt)+1).toISOString()},
    {...receipt,body:{...receipt.body,orderId:'OTHER_ORDER'}},{...receipt,body:{...receipt.body,id:'OTHER_CAPTURE'}}];
  for(const candidate of variants)assert.equal(buildOrderDetail(dataset,snapshot,order.id,[candidate])!.providerReceipts.length,0);
  assert.equal(buildOrderDetail(dataset,snapshot,'other-order',[receipt]),null);
  assert.throws(()=>buildOrderDetail({...dataset,tenantId:'other-tenant'},snapshot,order.id,[receipt]),/does not belong/);
});
