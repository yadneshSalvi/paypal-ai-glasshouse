import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryHarness } from './helpers/recovery';
import { buildSnapshot } from '../packages/domain';
import { digest } from '../packages/payments/security';
import type { Operation } from '../packages/domain/types';
import type { Database } from '../packages/db/client';
import { datasetFor } from '../lib/server/repository';
import { ownedPayment } from '../lib/server/recovery/authority';
import { projectDispute } from '../lib/server/recovery/dispute-service';
import type { DisputeObservation } from '../lib/server/recovery/disputes';
import { disputeCapabilities } from '../lib/server/recovery/disputes';
import { ensureObservationSchema } from '../lib/server/observations/schema';
import { bindConnector, type ObservationConnector } from '../lib/server/observations/connector';
import { ObservationService } from '../lib/server/observations/service';
import { ObservationWorker } from '../lib/server/observations/worker';
import { projectCapacity } from '../lib/server/observations/projection';
import { BoundedWebhookVerifier, boundedBody, rawWebhook, parseWebhook, validSignatureHeaders } from '../lib/server/observations/webhook';

const headers = () => new Headers({'content-type':'application/json','paypal-transmission-id':'transmission-fixture-1',
  'paypal-transmission-time':new Date().toISOString(),'paypal-auth-algo':'SHA256withRSA','paypal-transmission-sig':'c2lnbmF0dXJl',
  'paypal-cert-url':'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fixture'});
const verified = {verify:async () => ({verified:true,transmissionId:'transmission-fixture-1'})};
const event = (id:string,resource:Record<string,unknown>,type='PAYMENT.CAPTURE.COMPLETED') =>
  JSON.stringify({id,event_type:type,create_time:'2026-11-01T10:00:00.000Z',resource});

async function harness() {
  const h = await recoveryHarness();
  await ensureObservationSchema(h.db);
  const connector:ObservationConnector = {id:'connector-test',tenantId:h.who.tenantId,credentialHash:digest('fixture-client'),webhookId:'WEBHOOK-REAL-REGISTRATION-FIXTURE',merchantId:'MERCHANT_FIXTURE',configHash:digest('bound-connector-fixture')};
  await bindConnector(h.db,connector);
  const service = new ObservationService(h.db,h.secrets,connector);
  const worker = () => new ObservationWorker({db:h.db,secrets:h.secrets,connector,recovery:h.worker(),evidence:h.recoveryEvidence,disputes:h.cases});
  const due = () => h.db.query("UPDATE gh_observation_jobs SET next_attempt_at=now()-interval '1 second',lease_until=NULL,lease_owner=NULL WHERE tenant_id=$1",[h.who.tenantId]);
  return {...h,connector,observations:service,observer:worker,observationsDue:due};
}

test('webhook verification preserves original JSON bytes and only posts to fixed sandbox verification paths',async () => {
  const requests:Request[] = [], bodies:string[] = [];
  const transport:typeof fetch = async (input,init) => {
    const request = new Request(input,init);requests.push(request);bodies.push(await request.text());
    assert.equal(request.redirect,'error');
    assert.equal(new URL(request.url).origin,'https://api-m.sandbox.paypal.com');
    return Response.json(request.url.endsWith('/token') ? {access_token:'fixture-access-token',expires_in:3600} : {verification_status:'SUCCESS'});
  };
  const verifier = new BoundedWebhookVerifier({environment:'sandbox',baseUrl:'https://api-m.sandbox.paypal.com',isolatedProject:'glasshouse',clientId:'fixture-client',clientSecret:'fixture-secret'},'REGISTERED-WEBHOOK-1',transport);
  const raw = '{ "id":"WH-1", "event_type":"PAYMENT.CAPTURE.COMPLETED", "create_time":"2026-11-01T00:00:00Z", "resource": { "id":"CAPTURE-1", "untrusted":1.00 } }';
  assert.equal((await verifier.verify(raw,headers())).verified,true);
  assert.equal(requests.length,2);
  assert.deepEqual(requests.map(request=>new URL(request.url).pathname),['/v1/oauth2/token','/v1/notifications/verify-webhook-signature']);
  assert(bodies[1].endsWith(`"webhook_event":${raw}}`));
  assert.equal(JSON.parse(bodies[1]).webhook_id,'REGISTERED-WEBHOOK-1');
  const bad = headers();bad.set('paypal-cert-url','https://api.paypal.com/v1/notifications/certs/LIVE-CERT');
  assert.equal((await verifier.verify(raw,bad)).verified,false);assert.equal(requests.length,2);
  for (const url of ['https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/CERT-x','https://user@api.sandbox.paypal.com/v1/notifications/certs/CERT-x',
    'https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-x','https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x?redirect=1']) {
    bad.set('paypal-cert-url',url);assert.equal(validSignatureHeaders(bad),false);
  }
  await assert.rejects(rawWebhook(new Request('https://glasshouse.test/api/webhooks/paypal',{method:'POST',headers:{'content-type':'application/json','content-length':'1048577'},body:'{}'})),/bounded/);
  await assert.rejects(boundedBody(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(11));}}),10,AbortSignal.timeout(1000)),/bounded/);
  const stalled = new AbortController(), deadline = setTimeout(() => stalled.abort(), 5);
  try { await assert.rejects(boundedBody(new ReadableStream({}),10,stalled.signal)); }
  finally { clearTimeout(deadline); }
  const refund = parseWebhook(event('WH-REFUND',{id:'REFUND-1',supplementary_data:{related_ids:{capture_id:'CAPTURE-1'}}},'PAYMENT.CAPTURE.REFUNDED'));
  assert.deepEqual(refund.primary,{kind:'refund',id:'REFUND-1'});assert(refund.resources.some(value=>value.kind==='capture'&&value.id==='CAPTURE-1'));
  assert.deepEqual(parseWebhook(event('WH-DECLINED',{id:'CAPTURE-1'},'PAYMENT.CAPTURE.DECLINED')).primary,{kind:'capture',id:'CAPTURE-1'});
});

test('verified inbox and outbox commit once; invalid deliveries cannot poison an identity and conflicts retain the canonical event',async t => {
  const h = await harness();t.after(()=>h.pg.close());
  const owned = await ownedPayment(h.db,h.who,h.ids[0]), raw = event('WH-DURABLE',{id:owned.captureId});
  await assert.rejects(h.observations.receive(h.connector,{verify:async()=>({verified:false,transmissionId:'bad'})},raw,headers()),/did not verify/);
  await assert.rejects(h.observations.receive(h.connector,{verify:async()=>{throw new Error('private-provider-body');}},raw,headers()),/temporarily unavailable/);
  assert.equal((await h.db.query('SELECT event_id FROM gh_webhook_events')).length,0);
  await Promise.all([h.observations.receive(h.connector,verified,raw,headers()),h.observations.receive(h.connector,verified,raw,headers())]);
  assert.equal((await h.db.query('SELECT event_id FROM gh_webhook_events')).length,1);
  assert.equal((await h.db.query('SELECT id FROM gh_observation_jobs')).length,1);
  const conflict = await h.observations.receive(h.connector,verified,raw+' ',headers());assert.equal(conflict.outcome,'identity_conflict');
  const stored = (await h.db.query<{private_document:string;raw_hash:string}>('SELECT private_document,raw_hash FROM gh_webhook_events'))[0];
  assert.equal(stored.raw_hash,digest(raw));assert(!stored.private_document.includes(owned.captureId));assert(!stored.private_document.includes('signature'));
  assert.equal(h.secrets.open<{rawBody:string}>(stored.private_document,`webhook-event:${h.connector.id}:WH-DURABLE`).rawBody,raw);
  assert.throws(()=>h.secrets.open(stored.private_document,`webhook-event:${h.connector.id}:WH-FOREIGN`));
  const overview = await h.observations.overview(h.who);assert.equal(overview.notifications.duplicates,1);assert.equal(overview.notifications.conflicts,1);assert.equal(overview.notifications.rejected,2);
  assert.equal(JSON.stringify(overview).includes('private-provider-body'),false);
});

test('foreign merchant or resource notifications cannot read a provider resource; before-ack delivery waits durably',async t => {
  const h = await harness();t.after(()=>h.pg.close());const owned = await ownedPayment(h.db,h.who,h.ids[0]);
  const before = h.fixture.requests.length;
  await h.observations.receive(h.connector,verified,event('WH-MERCHANT',{id:owned.captureId,payee:{merchant_id:'FOREIGN_MERCHANT'}}),headers());
  assert.equal((await h.db.query('SELECT id FROM gh_observation_jobs')).length,0);
  await h.db.query("INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body) VALUES('foreign-tenant','capture','FOREIGN-CAPTURE','foreign-order','foreign-run',now(),'{}'::jsonb)");
  await h.observations.receive(h.connector,verified,event('WH-FOREIGN',{id:'FOREIGN-CAPTURE'}),headers());
  assert.equal((await h.observer().drain()).attention,1);assert.equal(h.fixture.requests.length,before);
  await h.db.query("UPDATE gh_provider_resources SET active=false WHERE tenant_id=$1 AND kind='capture' AND provider_id=$2",[h.who.tenantId,owned.captureId]);
  await h.observations.receive(h.connector,verified,event('WH-BEFORE-ACK',{id:owned.captureId}),headers());
  assert.equal((await h.observer().drain()).retry,1);assert.equal(h.fixture.requests.length,before);
  await h.db.query("UPDATE gh_provider_resources SET active=true WHERE tenant_id=$1 AND kind='capture' AND provider_id=$2",[h.who.tenantId,owned.captureId]);
  await h.observationsDue();assert.equal((await h.observer().drain()).complete,1);
  assert(h.fixture.requests.slice(before).every(request=>request.method==='GET'));
  const summary = await h.observations.overview(h.who);assert.equal(summary.notifications.applied,1);assert.equal(summary.jobs.attention,1);
});

test('status recovery resolves a lost original refund after revocation without dispatching its queued neighbour',async t => {
  const h = await harness();t.after(()=>h.pg.close());const plan = await h.plan();await h.approveAndQueue(plan);
  h.fixture.refundLost = true;await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
  const original = (await h.db.query<{id:string;status:string;attempt:number}>("SELECT id,status,attempt FROM gh_recovery_intents WHERE kind='refund'"))[0];
  assert.equal(original.status,'unknown_outcome');
  await h.observations.enqueueStatus(h.who,plan.id);h.fixture.readsUnavailable = false;
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);
  const writes = h.fixture.writes.length, requestOffset = h.fixture.requests.length;
  const result = await h.observer().drain();assert.equal(result.complete,2);
  assert.equal(h.fixture.writes.length,writes);assert(h.fixture.requests.slice(requestOffset).every(request=>request.method==='GET'));
  const after = (await h.db.query<{id:string;status:string;attempt:number}>("SELECT id,status,attempt FROM gh_recovery_intents WHERE kind='refund'"))[0];
  assert.equal(after.id,original.id);assert.equal(after.status,'provider_success');assert.equal(after.attempt,original.attempt);
  assert.equal((await h.db.query<{status:string}>("SELECT status FROM gh_recovery_intents WHERE kind='tracking'"))[0].status,'queued');
  await assert.rejects(h.observations.enqueueStatus(h.who,plan.id),/membership/);
  const checks = await h.db.query<{body:{outcome:string}}>('SELECT body FROM gh_status_checks');assert.deepEqual(checks.map(row=>row.body.outcome).sort(),['not_dispatched','verified']);
});

test('rechecking completed actions preserves their receipt bytes and historic hashes while new proposals omit verified assignments',async t => {
  const h = await harness();t.after(()=>h.pg.close());const plan = await h.plan();await h.approveAndQueue(plan);
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4});
  const operations = (await h.db.query<{body:Operation}>('SELECT body FROM gh_operations ORDER BY id')).map(row=>row.body);
  assert(operations.every(operation=>operation.status==='provider_success'));
  const before = buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  await h.observations.enqueueStatus(h.who,plan.id);
  assert.equal((await h.observations.enqueueStatus(h.who,plan.id)).queued,0);
  const writes = h.fixture.writes.length;
  await Promise.all([h.observer().drain(),h.observer().drain()]);
  assert.equal(h.fixture.writes.length,writes);
  assert.deepEqual((await h.db.query<{body:Operation}>('SELECT body FROM gh_operations ORDER BY id')).map(row=>row.body),operations);
  const dataset = await datasetFor(h.who,h.db);assert.equal(buildSnapshot(dataset,before.context).hash,before.hash);
  const current = buildSnapshot(dataset,{knownAt:new Date().toISOString()});assert.equal(current.branches[0].trackingCount,0);assert.equal(current.branches[0].refundTotalMinor,0);
  assert.equal(current.totals.refundMinor,500);assert.equal(current.totals.affected,before.totals.affected);
  assert.equal((await h.db.query<{body:{hash:string}}>('SELECT body FROM gh_plans WHERE id=$1',[plan.id]))[0].body.hash,plan.hash);
});

test('an active financial lease holds a status check and an expired observation lease is reclaimed without another write',async t => {
  const h = await harness();t.after(()=>h.pg.close());const plan = await h.plan();await h.approveAndQueue(plan);
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
  const operation = (await h.db.query<{id:string}>("SELECT id FROM gh_recovery_intents WHERE kind='refund'"))[0];
  await h.observations.enqueueStatus(h.who,plan.id,operation.id);
  await h.db.query("UPDATE gh_recovery_intents SET lease_owner='original-worker',lease_until=now()+interval '1 hour' WHERE id=$1",[operation.id]);
  const writes = h.fixture.writes.length;assert.equal((await h.observer().drain()).retry,1);assert.equal(h.fixture.writes.length,writes);
  await h.db.query("UPDATE gh_recovery_intents SET lease_until=now()-interval '1 second' WHERE id=$1",[operation.id]);
  await h.db.query("UPDATE gh_observation_jobs SET state='running',lease_owner='crashed-reader',lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second'");
  assert.equal((await h.observer().drain()).complete,1);assert.equal(h.fixture.writes.length,writes);
  const latest = await h.observations.overview(h.who);assert.equal(latest.checks[0].outcome,'verified');
  assert.equal((await h.db.query<{attempt:number}>('SELECT attempt FROM gh_recovery_intents WHERE id=$1',[operation.id]))[0].attempt,1);
});

test('fresh case capabilities remove an already submitted response without rewriting the approved evidence receipt',async t => {
  const h = await harness();t.after(()=>h.pg.close());const owned = await ownedPayment(h.db,h.who,h.ids[0]), now = new Date().toISOString();
  const observation:DisputeObservation = {id:'PP-R-OBSERVATION-1',captureId:owned.captureId,buyerTransactionId:'BUYER_OBSERVATION_1',reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',status:'WAITING_FOR_SELLER_RESPONSE',stage:'INQUIRY',
    amountMinor:owned.entry.amountMinor,grossAmountMinor:owned.entry.amountMinor,currency:'USD',createdAt:now,updatedAt:now,sellerResponseDueAt:new Date(Date.now()+86_400_000).toISOString(),actions:['provide-evidence'],
    evidence:[{type:'PROOF_OF_FULFILLMENT',source:'REQUESTED_FROM_SELLER',date:now,itemId:null,notesHash:null,tracking:[]}],observedAt:now,bodyHash:'',debugId:null};
  observation.bodyHash = digest(observation);h.cases.observations.set(observation.id,observation);
  await h.db.transaction(tx=>projectDispute(tx,h.who,owned,observation));
  const plan = await h.plan();assert.equal(plan.branch.disputeCount,1);await h.approveAndQueue(plan);
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'dispute_response',limit:1});
  const operation = (await h.db.query<{body:Operation}>("SELECT body FROM gh_operations WHERE body->>'kind'='dispute_response'"))[0].body;
  const before = buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  const value = h.cases.observations.get(observation.id)!;value.status='WAITING_FOR_BUYER_RESPONSE';value.actions=['escalate'];value.sellerResponseDueAt=null;value.updatedAt=new Date().toISOString();value.observedAt=value.updatedAt;value.bodyHash=digest({...value,bodyHash:undefined,observedAt:undefined});
  await h.observations.enqueueStatus(h.who,plan.id,operation.id);
  assert.equal((await h.observer().drain()).complete,1);assert.equal(h.cases.posts.length,1);
  const dataset = await datasetFor(h.who,h.db), current = buildSnapshot(dataset,{knownAt:new Date().toISOString()});
  assert.equal(buildSnapshot(dataset,before.context).hash,before.hash);assert.equal(current.branches[0].disputeCount,0);assert.equal(current.orders.find(order=>order.id===h.ids[0])!.disputeOpen,true);
  assert.deepEqual((await h.db.query<{body:Operation}>('SELECT body FROM gh_operations WHERE id=$1',[operation.id]))[0].body,operation);
  const check = (await h.observations.overview(h.who)).checks[0];assert.equal(check.evidenceSubmitted,true);assert.equal(check.caseResolved,false);assert.equal(check.providerStatus,'WAITING_FOR_BUYER_RESPONSE');
});

test('refund notification amounts are ignored; complete provider reads reserve pending money and book only completed refunds',async t => {
  const h = await harness();t.after(()=>h.pg.close());const owned = await ownedPayment(h.db,h.who,h.ids[0]);
  const before = buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  const refund = {id:'REFUND_EXTERNAL_OBSERVATION',status:'PENDING',amount:{currency_code:'USD',value:'5.00'},create_time:new Date().toISOString(),custom_id:'external-merchant-operation',
    links:[{rel:'up',method:'GET',href:`https://api.sandbox.paypal.com/v2/payments/captures/${owned.captureId}`}]};
  h.fixture.refunds.set(refund.id,refund);(h.fixture.orders.get(owned.providerOrderId)!.purchase_units[0].payments as {refunds:unknown[]}).refunds=[refund];
  const resource = {id:refund.id,amount:{currency_code:'USD',value:'999999.00'},supplementary_data:{related_ids:{capture_id:owned.captureId}}};
  const writes = h.fixture.writes.length;
  await h.observations.receive(h.connector,verified,event('WH-EXTERNAL-PENDING',resource,'PAYMENT.CAPTURE.REFUNDED'),headers());
  assert.equal((await h.observer().drain()).complete,1);
  let dataset = await datasetFor(h.who,h.db);assert.equal(buildSnapshot(dataset,before.context).hash,before.hash);
  const pending = buildSnapshot(dataset,{knownAt:new Date().toISOString()});assert.equal(pending.totals.refundMinor,0);assert.equal(pending.branches[0].refundTotalMinor,0);
  assert.equal(pending.orders.find(order=>order.id===h.ids[0])!.providerRefundConsumedMinor,500);
  refund.status='COMPLETED';
  await h.observations.receive(h.connector,verified,event('WH-EXTERNAL-COMPLETE',resource,'PAYMENT.CAPTURE.REFUNDED'),headers());
  assert.equal((await h.observer().drain()).complete,1);
  dataset = await datasetFor(h.who,h.db);assert.equal(buildSnapshot(dataset,pending.context).hash,pending.hash);
  assert.equal(buildSnapshot(dataset,{knownAt:new Date().toISOString()}).totals.refundMinor,500);
  await h.observations.receive(h.connector,verified,event('WH-LATE-OLD-DELIVERY',resource,'PAYMENT.CAPTURE.REFUNDED'),headers());await h.observer().drain();
  assert.equal(buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()}).totals.refundMinor,500);assert.equal(h.fixture.writes.length,writes);
});

test('queue corruption and connector revocation fail closed before any read and status jobs remain tenant scoped',async t => {
  const h = await harness();t.after(()=>h.pg.close());const owned = await ownedPayment(h.db,h.who,h.ids[0]);
  await h.observations.receive(h.connector,verified,event('WH-TAMPER',{id:owned.captureId}),headers());
  await h.db.query("UPDATE gh_observation_jobs SET subject=jsonb_set(subject,'{hint,primary,id}','\"FOREIGN-CAPTURE\"'::jsonb)");
  const offset=h.fixture.requests.length;assert.equal((await h.observer().drain()).attention,1);assert.equal(h.fixture.requests.length,offset);
  await h.observations.receive(h.connector,verified,event('WH-REVOKED',{id:owned.captureId}),headers());
  await h.db.query('UPDATE gh_paypal_connectors SET active=false WHERE id=$1',[h.connector.id]);
  assert.equal((await h.observer().drain()).attention,1);assert.equal(h.fixture.requests.length,offset);
  const plan = await h.plan();await h.approveAndQueue(plan);
  await assert.rejects(h.observations.enqueueStatus({...h.who,tenantId:'foreign-tenant'},plan.id),/membership/);
  await assert.rejects(h.observations.enqueueStatus(h.who,plan.id,'foreign-operation'),/original provider operations/);
  await assert.rejects(h.observations.overview({...h.who,tenantId:'foreign-tenant'}),/membership/);
});

test('a failed outbox commit leaves no accepted event and the same signed delivery can be retried safely',async t => {
  const h = await harness();t.after(()=>h.pg.close());const owned=await ownedPayment(h.db,h.who,h.ids[0]);
  let fail = true;
  const db: Database = {query:(sql,values)=>h.db.query(sql,values),transaction:work=>h.db.transaction(tx=>work({
    ...tx,query:async (sql,values)=>{if (fail && sql.includes('INSERT INTO gh_observation_jobs')) {fail=false;throw new Error('fixture storage interruption');}return tx.query(sql,values);},
  }))};
  const service = new ObservationService(db,h.secrets,h.connector), raw=event('WH-ATOMIC',{id:owned.captureId});
  await assert.rejects(service.receive(h.connector,verified,raw,headers()),/storage interruption/);
  assert.equal((await h.db.query('SELECT event_id FROM gh_webhook_events')).length,0);
  assert.equal((await h.db.query('SELECT id FROM gh_webhook_deliveries')).length,0);
  assert.equal((await h.db.query('SELECT id FROM gh_observation_jobs')).length,0);
  assert.equal((await service.receive(h.connector,verified,raw,headers())).outcome,'queued');
  assert.equal((await h.db.query('SELECT event_id FROM gh_webhook_events')).length,1);
  assert.equal((await h.db.query('SELECT id FROM gh_observation_jobs')).length,1);
});

test('failed status reads retain completed receipts, exhaust into visible attention and resume only as reads',async t => {
  const h=await harness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4});
  const operation=(await h.db.query<{body:Operation}>("SELECT body FROM gh_operations WHERE body->>'kind'='refund'"))[0].body;
  await h.observations.enqueueStatus(h.who,plan.id,operation.id);
  h.fixture.readsUnavailable=true;const writes=h.fixture.writes.length;
  await h.db.query("UPDATE gh_observation_jobs SET attempts=11 WHERE id=$1",[`status-${operation.id}`]);
  await h.observer().drain();
  const overview=await h.observations.overview(h.who);assert.equal(overview.jobs.attention,1);assert.equal(overview.heldOperations[0].operationId,operation.id);
  assert.match(overview.heldOperations[0].reason,/Automatic read attempts stopped/);
  assert.deepEqual((await h.db.query<{body:Operation}>('SELECT body FROM gh_operations WHERE id=$1',[operation.id]))[0].body,operation);
  assert.equal((await h.observations.retryHeld(h.who)).queued,1);
  h.fixture.readsUnavailable=false;assert.equal((await h.observer().drain()).complete,1);
  assert.equal(h.fixture.writes.length,writes);assert.equal((await h.observations.overview(h.who)).heldOperations.length,0);
  assert.deepEqual((await h.db.query<{body:Operation}>('SELECT body FROM gh_operations WHERE id=$1',[operation.id]))[0].body,operation);
});

test('read-only status cannot create a replacement for an unidentified tracking write or resume an expired unsent claim',async t => {
  const h=await harness();t.after(()=>h.pg.close());const plan=await h.plan();await h.approveAndQueue(plan);
  h.fixture.trackingLost=true;await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'tracking',limit:1});
  h.fixture.readsUnavailable=false;
  const tracking=(await h.db.query<{id:string}>("SELECT id FROM gh_recovery_intents WHERE kind='tracking'"))[0];
  const writes=h.fixture.writes.length;
  const result=await h.worker().reconcileOnly(h.who.tenantId,tracking.id);assert.equal(result.outcome,'unresolved');assert.equal(result.providerId,null);
  const refund=(await h.db.query<{id:string}>("UPDATE gh_recovery_intents SET status='claimed',lease_until=now()-interval '1 second' WHERE kind='refund' RETURNING id"))[0];
  assert.equal((await h.worker().reconcileOnly(h.who.tenantId,refund.id)).outcome,'not_dispatched');
  assert.equal(h.fixture.writes.length,writes);assert.equal(h.fixture.writes.filter(write=>write.path.endsWith('/track')).length,1);assert.equal(h.fixture.writes.filter(write=>write.path.endsWith('/refund')).length,0);
});

test('proposal capability facts require current allowed links and unfulfilled seller requests at the observation time',() => {
  const base:DisputeObservation={id:'PP-R-CAPABILITIES',captureId:'CAPTURE-1',buyerTransactionId:'BUYER-1',reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',status:'WAITING_FOR_SELLER_RESPONSE',stage:'INQUIRY',amountMinor:1000,grossAmountMinor:1000,currency:'USD',
    createdAt:'2026-11-10T00:00:00Z',updatedAt:'2026-11-10T00:00:00Z',observedAt:'2026-11-11T00:00:00Z',sellerResponseDueAt:'2026-11-12T00:00:00Z',actions:['provide-evidence'],
    evidence:[{type:'PROOF_OF_FULFILLMENT',source:'REQUESTED_FROM_SELLER',date:'2026-11-10T00:00:00Z',itemId:null,notesHash:null,tracking:[]}],bodyHash:'fixture',debugId:null};
  assert.equal(disputeCapabilities(base).mayProvideFulfillment,true);
  assert.equal(disputeCapabilities({...base,sellerResponseDueAt:null}).mayProvideFulfillment,true);
  for (const status of ['WAITING_FOR_BUYER_RESPONSE','UNDER_REVIEW','RESOLVED','OTHER','NEW_PROVIDER_STATE']) assert.equal(disputeCapabilities({...base,status}).mayProvideFulfillment,false);
  assert.equal(disputeCapabilities({...base,actions:[]}).mayProvideFulfillment,false);
  assert.equal(disputeCapabilities({...base,evidence:[]}).mayProvideFulfillment,false);
  assert.equal(disputeCapabilities({...base,evidence:[{...base.evidence[0],itemId:'UNREVIEWED-ITEM'}]}).mayProvideFulfillment,false);
  assert.equal(disputeCapabilities({...base,evidence:[...base.evidence,{...base.evidence[0],source:'SUBMITTED_BY_SELLER'}]}).mayProvideFulfillment,false);
  assert.equal(disputeCapabilities({...base,observedAt:base.sellerResponseDueAt!}).mayProvideFulfillment,false);
});

test('refund inventories and later original receipts are joined by identity without lost amounts or duplicate reservations',async t => {
  for (const alreadyPending of [false,true]) await t.test(alreadyPending?'the inventory already reserves the pending original refund':'the original refund arrives after the inventory',async t => {
    const h=await harness();t.after(()=>h.pg.close());
    const plan=await h.plan();await h.approveAndQueue(plan);
    h.fixture.refundLost=true;await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,kind:'refund',limit:1});
    h.fixture.readsUnavailable=false;
    const owned=await ownedPayment(h.db,h.who,h.ids[0]);
    const original=(await h.db.query<{id:string}>("SELECT id FROM gh_recovery_intents WHERE kind='refund'"))[0];
    const originalRefund=[...h.fixture.refunds.values()][0];
    const external={...originalRefund,id:'REFUND-EXTERNAL-UNION',custom_id:'external-operation',status:'COMPLETED'};
    h.fixture.refunds.set(external.id,external);
    const payments=h.fixture.orders.get(owned.providerOrderId)!.purchase_units[0].payments as {refunds:unknown[]};
    if(alreadyPending) originalRefund.status='PENDING';
    payments.refunds=alreadyPending?[external,originalRefund]:[external];
    const writes=h.fixture.writes.length;
    await h.observations.receive(h.connector,verified,event('WH-REFUND-UNION',{id:external.id,supplementary_data:{related_ids:{capture_id:owned.captureId}}},'PAYMENT.CAPTURE.REFUNDED'),headers());
    await h.observer().drain();
    const inventory=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
    assert.equal(inventory.totals.refundMinor,500);
    assert.equal(inventory.orders.find(order=>order.id===owned.orderId)!.providerRefundConsumedMinor,alreadyPending?1000:500);
    originalRefund.status='COMPLETED';payments.refunds=[external,originalRefund];
    assert.equal((await h.worker().reconcileOnly(h.who.tenantId,original.id)).outcome,'verified');
    let dataset=await datasetFor(h.who,h.db),current=buildSnapshot(dataset,{knownAt:new Date().toISOString()});
    assert.equal(buildSnapshot(dataset,inventory.context).hash,inventory.hash);
    assert.equal(current.totals.refundMinor,1000);
    assert.equal(current.orders.find(order=>order.id===owned.orderId)!.providerRefundConsumedMinor,1000);
    assert.equal(current.orders.find(order=>order.id===owned.orderId)!.refundableMinor,owned.entry.amountMinor-1000);
    await h.observationsDue();await h.observer().drain();
    dataset=await datasetFor(h.who,h.db);current=buildSnapshot(dataset,{knownAt:new Date().toISOString()});
    assert.equal(current.totals.refundMinor,1000);assert.equal(h.fixture.writes.length,writes);
    assert.equal(current.orders.find(order=>order.id===owned.orderId)!.providerRefundConsumedMinor,1000);
  });
});

test('unchanged independent reads advance the freshness fence before an older different balance arrives',async t => {
  const h=await harness();t.after(()=>h.pg.close());const owned=await ownedPayment(h.db,h.who,h.ids[0]);
  const first=await h.recoveryEvidence.capacity(owned),base=Date.now()-60_000;
  first.observedAt=new Date(base).toISOString();await projectCapacity(h.db,h.connector,owned,first);
  const snapshot=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  const fresh={...first,observedAt:new Date(base+40_000).toISOString()};await projectCapacity(h.db,h.connector,owned,fresh);
  const stale={...first,observedAt:new Date(base+20_000).toISOString(),consumedMinor:500,refundIds:['PENDING-OLD'],refunds:[{
    id:'PENDING-OLD',captureId:owned.captureId,orderId:owned.providerOrderId,customId:null,status:'PENDING',amountMinor:500,currency:'USD' as const,
    occurredAt:new Date(base-1000).toISOString(),observedAt:new Date(base+20_000).toISOString(),bodyHash:digest('old-pending-refund'),debugId:null,
  }],bodyHash:digest('old-pending-capacity')};
  await projectCapacity(h.db,h.connector,owned,stale);
  const resource=(await h.db.query<{body:{observedAt:string;bodyHash:string}}>("SELECT body FROM gh_provider_resources WHERE kind='capture_capacity'"))[0].body;
  assert.equal(resource.observedAt,fresh.observedAt);assert.equal(resource.bodyHash,fresh.bodyHash);
  const dataset=await datasetFor(h.who,h.db);assert.equal(buildSnapshot(dataset,snapshot.context).hash,snapshot.hash);
  assert.equal(buildSnapshot(dataset,{knownAt:new Date().toISOString()}).orders.find(order=>order.id===owned.orderId)!.providerRefundConsumedMinor,0);
});

test('case reads with the same provider update time cannot regress after an unchanged fresher read',async t => {
  const h=await harness();t.after(()=>h.pg.close());const owned=await ownedPayment(h.db,h.who,h.ids[0]),base=Date.now()-60_000;
  const value:DisputeObservation={id:'PP-R-ORDERING',captureId:owned.captureId,buyerTransactionId:'BUYER-ORDERING',reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',status:'WAITING_FOR_BUYER_RESPONSE',stage:'INQUIRY',
    amountMinor:owned.entry.amountMinor,grossAmountMinor:owned.entry.amountMinor,currency:'USD',createdAt:new Date(base-1000).toISOString(),updatedAt:new Date(base).toISOString(),
    sellerResponseDueAt:null,actions:['escalate'],evidence:[],observedAt:new Date(base+10_000).toISOString(),bodyHash:digest('case-awaiting-buyer'),debugId:null};
  await h.db.transaction(tx=>projectDispute(tx,h.who,owned,value));
  const snapshot=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  const fresh={...value,observedAt:new Date(base+40_000).toISOString()};
  await h.db.transaction(tx=>projectDispute(tx,h.who,owned,fresh));
  const stale:DisputeObservation={...value,status:'WAITING_FOR_SELLER_RESPONSE',actions:['provide-evidence'],observedAt:new Date(base+20_000).toISOString(),bodyHash:digest('stale-seller-case'),
    evidence:[{type:'PROOF_OF_FULFILLMENT',source:'REQUESTED_FROM_SELLER',date:value.updatedAt,itemId:null,notesHash:null,tracking:[]}]};
  await h.db.transaction(tx=>projectDispute(tx,h.who,owned,stale));
  const resource=(await h.db.query<{body:DisputeObservation}>("SELECT body FROM gh_provider_resources WHERE kind='dispute'"))[0].body;
  assert.equal(resource.observedAt,fresh.observedAt);assert.equal(resource.status,'WAITING_FOR_BUYER_RESPONSE');
  const dataset=await datasetFor(h.who,h.db);assert.equal(buildSnapshot(dataset,snapshot.context).hash,snapshot.hash);
  assert.equal(buildSnapshot(dataset,{knownAt:new Date().toISOString()}).branches[0].disputeCount,0);
});

test('a balance returning to previously observed content appends knowledge instead of retaining a stale reservation',async t => {
  const h=await harness();t.after(()=>h.pg.close());const owned=await ownedPayment(h.db,h.who,h.ids[0]),base=Date.now()-60_000;
  const empty={...await h.recoveryEvidence.capacity(owned),observedAt:new Date(base).toISOString()};
  await projectCapacity(h.db,h.connector,owned,empty);
  const pending={...empty,observedAt:new Date(base+10_000).toISOString(),consumedMinor:500,refundIds:['PENDING-REMOVED'],refunds:[{
    id:'PENDING-REMOVED',captureId:owned.captureId,orderId:owned.providerOrderId,customId:null,status:'PENDING',amountMinor:500,currency:'USD' as const,
    occurredAt:new Date(base-1000).toISOString(),observedAt:new Date(base+10_000).toISOString(),bodyHash:digest('removed-pending-refund'),debugId:null,
  }],bodyHash:digest('pending-capacity-that-clears')};
  await projectCapacity(h.db,h.connector,owned,pending);
  const before=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  assert.equal(before.orders.find(order=>order.id===owned.orderId)!.providerRefundConsumedMinor,500);
  await projectCapacity(h.db,h.connector,owned,{...empty,observedAt:new Date(base+20_000).toISOString()});
  const dataset=await datasetFor(h.who,h.db);
  assert.equal(buildSnapshot(dataset,before.context).hash,before.hash);
  assert.equal(buildSnapshot(dataset,{knownAt:new Date().toISOString()}).orders.find(order=>order.id===owned.orderId)!.providerRefundConsumedMinor,0);
  assert.equal(dataset.events.filter(event=>event.type==='payment.refund_balance_observed').length,3);
  const stored=(await h.db.query<{body:{consumedMinor:number;bodyHash:string}}>("SELECT body FROM gh_provider_resources WHERE kind='capture_capacity'"))[0].body;
  assert.equal(stored.consumedMinor,0);assert.equal(stored.bodyHash,empty.bodyHash);
});
