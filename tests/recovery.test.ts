import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryHarness } from './helpers/recovery';
import { buildSnapshot } from '../packages/domain';
import { datasetFor } from '../lib/server/repository';
import type { Operation, RecoveryPlan } from '../packages/domain/types';
import { ownedPayment } from '../lib/server/recovery/authority';
import { projectDispute } from '../lib/server/recovery/dispute-service';
import { exactPlanHash } from '../lib/server/recovery/contracts';
import { digest } from '../packages/payments/security';
import type { DisputeObservation } from '../lib/server/recovery/disputes';

test('two SQL recovery workers preserve one approved refund and tracker per order, including companion receipts',async t=>{
  const h=await recoveryHarness(2);t.after(()=>h.pg.close());const plan=await h.plan();assert.equal(plan.branch.actions.length,4);
  await h.approveAndQueue(plan);assert.equal((await h.recoveryService.enqueue(h.who,plan.id,plan.hash)).inserted,0);
  const before=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  await Promise.all([h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4}),h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4})]);
  const operations=(await h.db.query<{body:Operation}>('SELECT body FROM gh_operations WHERE plan_id=$1 ORDER BY action_id',[plan.id])).map(row=>row.body);
  assert.equal(operations.length,4);assert(operations.every(value=>value.status==='provider_success'),JSON.stringify(operations.map(({status,reason})=>({status,reason}))));
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,2);assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/track')).length,2);
  for(const write of h.fixture.writes.filter(value=>value.path.endsWith('/track'))){assert.equal(write.body.notify_payer,false);assert.equal(write.body.carrier,'OTHER');assert.match(String(write.body.tracking_number),/^SYNTHETIC-/);}
  const dataset=await datasetFor(h.who,h.db),current=buildSnapshot(dataset,{knownAt:new Date().toISOString()});
  assert.equal(buildSnapshot(dataset,before.context).hash,before.hash);assert.equal(current.totals.refundMinor,1000);
  for(const id of h.ids){const order=current.orders.find(value=>value.id===id)!;assert.equal(order.fulfillmentState,'delayed');assert.equal(order.disputeState,'none');assert.equal(order.trackingInPayPal,true);assert.equal(order.refundedMinor,500);}
  assert.equal((await h.db.query<{body:RecoveryPlan}>('SELECT body FROM gh_plans WHERE id=$1',[plan.id]))[0].body.status,'completed');
});

test('an exact original operation drain never claims a queued neighbour or repeats a completed action',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  const tracking=(await h.db.query<{id:string}>("SELECT id FROM gh_recovery_intents WHERE kind='tracking'"))[0];
  const first=await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,operationId:tracking.id,limit:4});
  assert.equal(first.claimed,1);assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/track')).length,1);
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,0);
  assert.equal((await h.db.query<{status:string}>("SELECT status FROM gh_recovery_intents WHERE kind='refund'"))[0].status,'queued');
  assert.equal((await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,operationId:tracking.id,limit:4})).claimed,0);
  assert.equal((await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,operationId:'foreign-operation',limit:4})).claimed,0);
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/track')).length,1);
});

test('different approved branches share one semantic goodwill and tracking intent',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const first=await h.plan('targeted'),second=await h.plan('comprehensive');
  await h.recoveryService.approve(h.who,first.id,first.hash,true);await h.recoveryService.approve(h.who,second.id,second.hash,true);
  await h.recoveryService.enqueue(h.who,first.id,first.hash);const duplicate=await h.recoveryService.enqueue(h.who,second.id,second.hash);
  assert.equal(duplicate.status,'blocked');assert.equal((await h.db.query('SELECT id FROM gh_recovery_intents')).length,2);
  await h.worker().drain({tenantId:h.who.tenantId,limit:4});
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,1);assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/track')).length,1);
  const blocked=await h.db.query<{body:Operation}>('SELECT body FROM gh_operations WHERE plan_id=$1',[second.id]);
  assert.equal(blocked.length,2);assert(blocked.every(({body})=>body.status==='blocked'&&body.reason?.includes('same business intent')));
});

test('a lost refund response reconciles its original operation after revocation and never sends another refund',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  h.fixture.refundLost=true;await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
  assert.equal(h.fixture.refunds.size,1);assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,1);
  const before=await h.db.query<{id:string;status:string;provider_id:string|null}>("SELECT id,status,provider_id FROM gh_recovery_intents WHERE kind='refund'");
  assert.equal(before[0].status,'unknown_outcome');assert.equal(before[0].provider_id,null);
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);
  h.fixture.readsUnavailable=false;await h.due();await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4});
  const after=await h.db.query<{id:string;status:string}>("SELECT id,status FROM gh_recovery_intents WHERE kind='refund'");
  assert.equal(after[0].id,before[0].id);assert.equal(after[0].status,'provider_success');
  assert.equal((await h.db.query<{status:string}>("SELECT status FROM gh_recovery_intents WHERE kind='tracking'"))[0].status,'blocked');
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,1);assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/track')).length,0);
  const current=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});assert.equal(current.totals.refundMinor,500);
});

test('a tracking write with a lost identity remains unknown and cannot be duplicated by another plan',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
  h.fixture.trackingLost=true;await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'tracking',limit:1});
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/track')).length,1);
  h.fixture.readsUnavailable=false;await h.due();await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4});
  const tracking=(await h.db.query<{status:string;provider_id:string|null}>("SELECT status,provider_id FROM gh_recovery_intents WHERE kind='tracking'"))[0];
  assert.equal(tracking.status,'unknown_outcome');assert.equal(tracking.provider_id,null);
  const later=await h.plan();assert.equal(later.branch.refundTotalMinor,0);assert.equal((await h.approveAndQueue(later)).status,'blocked');
  await h.worker().drain({tenantId:h.who.tenantId,limit:4});
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/track')).length,1);assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,1);
});

test('revocation after provider preflight is caught at the final data POST boundary',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  let reads=0;
  h.fixture.onRead=async path=>{if(/^\/v2\/payments\/captures\/[^/]+$/.test(path)&&++reads===3)await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);};
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
  assert.equal(reads,3);assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,0);
  assert.equal((await h.db.query<{status:string}>("SELECT status FROM gh_recovery_intents WHERE kind='refund'"))[0].status,'blocked');
  await h.db.query('UPDATE gh_memberships SET active=true WHERE tenant_id=$1',[h.who.tenantId]);await h.due();
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,0);
});

test('pending external refunds consume provider headroom and prevent ordinary goodwill',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  const owned=await ownedPayment(h.db,h.who,h.ids[0]);
  const refund={id:'REFUND_EXTERNAL',status:'PENDING',amount:{currency_code:'USD',value:'5.00'},create_time:new Date().toISOString(),custom_id:'external-operation',links:[{rel:'up',method:'GET',href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${owned.captureId}`}]};
  h.fixture.refunds.set(refund.id,refund);(h.fixture.orders.get(owned.providerOrderId)!.purchase_units[0].payments as {refunds:unknown[]}).refunds=[refund];
  const capacity=await h.recoveryEvidence.capacity(owned);assert.equal(capacity.consumedMinor,500);assert.deepEqual(capacity.refundIds,['REFUND_EXTERNAL']);
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,0);
  assert.equal((await h.db.query<{status:string}>("SELECT status FROM gh_recovery_intents WHERE kind='refund'"))[0].status,'blocked');
  refund.links[0].href='https://api-m.sandbox.paypal.com/v2/payments/captures/FOREIGN-CAPTURE';await assert.rejects(()=>h.recoveryEvidence.capacity(owned),/different owning capture/);
});

test('refund parent metadata admits both exact sandbox hosts while rejecting foreign, credentialed and changed capture links',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  h.fixture.refundLinkOrigin='https://api.sandbox.paypal.com';
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
  const row=(await h.db.query<{id:string;status:string;provider_id:string}>("SELECT id,status,provider_id FROM gh_recovery_intents WHERE kind='refund'"))[0];
  assert.equal(row.status,'provider_success');
  const owned=await ownedPayment(h.db,h.who,h.ids[0]),refund=h.fixture.refunds.get(row.provider_id)!;
  const link=(refund.links as Array<{href:string;method:string}>)[0];
  for(const origin of ['https://api.sandbox.paypal.com','https://api-m.sandbox.paypal.com']){
    link.href=`${origin}/v2/payments/captures/${owned.captureId}`;
    assert.equal((await h.recoveryEvidence.refund(row.provider_id,owned,row.id,500)).status,'COMPLETED');
  }
  for(const href of [
    `https://api.paypal.com/v2/payments/captures/${owned.captureId}`,
    `https://api.sandbox.paypal.com.example.test/v2/payments/captures/${owned.captureId}`,
    `https://user@api.sandbox.paypal.com/v2/payments/captures/${owned.captureId}`,
    `https://api.sandbox.paypal.com:8443/v2/payments/captures/${owned.captureId}`,
    `https://api.sandbox.paypal.com/v2/payments/captures/FOREIGN`,
    `https://api.sandbox.paypal.com/v2/payments/captures/${owned.captureId}?other=1`,
    `https://api.sandbox.paypal.com/v2/payments/captures/${owned.captureId}#other`,
  ]){link.href=href;await assert.rejects(()=>h.recoveryEvidence.refund(row.provider_id,owned,row.id,500),/different owning capture/);}
  link.href=`https://api.sandbox.paypal.com/v2/payments/captures/${owned.captureId}`;link.method='POST';
  await assert.rejects(()=>h.recoveryEvidence.refund(row.provider_id,owned,row.id,500),/different owning capture/);
  assert.equal(h.fixture.writes.filter(value=>value.path.endsWith('/refund')).length,1);
});

test('exact approvals reject changed payloads, missing fixture acknowledgement, revoked authority and stale evidence',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const plan=await h.plan();
  await assert.rejects(()=>h.recoveryService.approve(h.who,plan.id,plan.hash,false),/acknowledge/);
  await assert.rejects(()=>h.recoveryService.approve({...h.who,tenantId:'foreign'},plan.id,plan.hash,true));
  const changed=structuredClone(plan);changed.branch.actions[0].payload.captureId='FOREIGN-CAPTURE';changed.hash=exactPlanHash(changed);
  await h.db.query('UPDATE gh_plans SET body=$2::jsonb WHERE id=$1',[changed.id,JSON.stringify(changed)]);
  await assert.rejects(()=>h.recoveryService.approve(h.who,changed.id,changed.hash,true),/deterministic recovery policy/);
  await h.db.query('UPDATE gh_plans SET body=$2::jsonb WHERE id=$1',[plan.id,JSON.stringify(plan)]);
  await h.db.query("UPDATE gh_datasets SET revision=revision+1,body=jsonb_set(body,'{revision}',to_jsonb(revision+1)) WHERE tenant_id=$1",[h.who.tenantId]);
  await assert.rejects(()=>h.recoveryService.approve(h.who,plan.id,plan.hash,true),/evidence changed/);
  assert.equal((await h.db.query('SELECT id FROM gh_recovery_intents')).length,0);
});

test('lost evidence submission is verified by the original marker after revocation without claiming case resolution',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());const owned=await ownedPayment(h.db,h.who,h.ids[0]),now=new Date().toISOString();
  const observation:DisputeObservation={id:'PP-R-RECOVERY-1',captureId:owned.captureId,buyerTransactionId:'BUYER_RECOVERY_1',reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',status:'WAITING_FOR_SELLER_RESPONSE',stage:'INQUIRY',amountMinor:owned.entry.amountMinor,grossAmountMinor:owned.entry.amountMinor,currency:'USD',createdAt:now,updatedAt:now,sellerResponseDueAt:new Date(Date.now()+86_400_000).toISOString(),actions:['provide-evidence'],evidence:[{type:'PROOF_OF_FULFILLMENT',source:'REQUESTED_FROM_SELLER',date:now,itemId:null,notesHash:null,tracking:[]}],observedAt:now,bodyHash:'',debugId:null};
  observation.bodyHash=digest(observation);h.cases.observations.set(observation.id,observation);
  await h.db.transaction(async tx=>{await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[h.who.tenantId]);await projectDispute(tx,h.who,owned,observation);});
  const plan=await h.plan();assert.equal(plan.branch.refundTotalMinor,0);assert.equal(plan.branch.disputeCount,1);await h.approveAndQueue(plan);
  h.cases.loseResponse=true;await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'dispute_response',limit:1});assert.equal(h.cases.posts.length,1);
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);await h.due();
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'dispute_response',limit:1});
  const result=(await h.db.query<{body:Operation}>("SELECT body FROM gh_operations WHERE body->>'kind'='dispute_response'"))[0].body;
  assert.equal(result.status,'provider_success');assert.equal(result.result?.evidenceSubmitted,true);assert.equal(result.result?.caseResolved,false);assert.equal(h.cases.posts.length,1);
  assert.equal(buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()}).orders.find(order=>order.id===h.ids[0])!.disputeOpen,true);
});
