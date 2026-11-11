import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createSeedDataset,buildSnapshot,applyDeliveryRevision} from '../packages/domain';
import {seedManifest} from '../packages/payments/manifest';
import {PaymentSecrets} from '../packages/payments/security';
import {paymentHarness,approvedRun} from './helpers/payments';
import {consentIdentity} from '../lib/server/payments/records';
import {SeedExecutor} from '../lib/server/payments/execution';
import {OrderEvidenceGateway} from '../lib/server/payments/evidence';
import {datasetFor} from '../lib/server/repository';

test('the complete manifest fixes all 600 exact amounts and preserves the $27,600 cap',()=>{
  const dataset=createSeedDataset('manifest-tenant');
  const manifest=seedManifest(dataset);
  assert.equal(manifest.entryCount,600);assert.equal(manifest.totalMinor,2_760_000);assert.equal(manifest.maximumOrderMinor,8900);
  assert.equal(new Set(manifest.entries.map(entry=>entry.orderId)).size,600);
  const copy=structuredClone(dataset);copy.orders.reverse();assert.equal(seedManifest(copy).hash,manifest.hash);
  copy.orders[0].amountMinor++;assert.notEqual(seedManifest(copy).hash,manifest.hash);
});

test('private documents reject tenant substitution, ciphertext alteration and a different storage key',()=>{
  const secrets=new PaymentSecrets(randomBytes(32).toString('base64'));
  const encrypted=secrets.seal({token:'private-test-wallet'},'tenant-a/operation-1');
  assert(!encrypted.includes('private-test-wallet'));
  assert.deepEqual(secrets.open(encrypted,'tenant-a/operation-1'),{token:'private-test-wallet'});
  assert.throws(()=>secrets.open(encrypted,'tenant-b/operation-1'));
  const parts=encrypted.split('.');parts[2]=Buffer.alloc(16).toString('base64url');
  assert.throws(()=>secrets.open(parts.join('.'),'tenant-a/operation-1'));
  assert.throws(()=>new PaymentSecrets(randomBytes(32).toString('base64')).open(encrypted,'tenant-a/operation-1'));
});

test('SQL consent is single-write, callback-bound, provider-read verified, and absent from public DTOs',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const status=await h.service.status(h.who);
  const [a,b]=await Promise.all([h.service.createRun(h.who,status.suggestedManifest.hash),h.service.createRun(h.who,status.suggestedManifest.hash)]);
  assert.equal(a.id,b.id);
  await Promise.all([h.service.connect(h.who,a.id,a.manifest.hash,'http://localhost:4103'),h.service.connect(h.who,a.id,a.manifest.hash,'http://localhost:4103')]);
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v3/vault/setup-tokens').length,1);
  let run=await h.service.viewRun(h.who,a.id);assert.equal(run.consent?.status,'awaiting_buyer');
  await assert.rejects(()=>h.service.approve(h.who,a.id,a.manifest.hash),/Verify the PayPal/);
  await assert.rejects(()=>h.service.completeConsent(h.who,a.id,'forged-state'),/original PayPal/);
  const row=(await h.db.query<{private_document:string}>('SELECT private_document FROM gh_payment_consents WHERE tenant_id=$1 AND id=$2',[h.who.tenantId,run.consent!.id]))[0];
  const value=h.secrets.open<{nonce:string}>(row.private_document,consentIdentity(h.who.tenantId,run.consent!.id));
  h.fixture.setupApproved=true;
  run=await h.service.completeConsent(h.who,a.id,value.nonce);
  assert.equal(run.consent?.status,'verified');
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v3/vault/payment-tokens').length,1);
  assert(h.fixture.requests.some(row=>row.method==='GET'&&row.path===`/v3/vault/payment-tokens/${h.fixture.tokenId}`));
  assert(!JSON.stringify(run).includes(h.fixture.tokenId));assert(!JSON.stringify(run).includes(h.fixture.payerId));
  const create=h.fixture.writes.find(row=>row.path==='/v3/vault/setup-tokens')!;
  assert(create.requestId);assert.equal((create.body.payment_source as {paypal:{usage_type:string}}).paypal.usage_type,'MERCHANT');
  assert.equal(h.fixture.requests.filter(row=>row.path==='/v3/vault/payment-tokens'&&row.method==='GET')[0].query,'?customer_id=customer_GLASS_FIXTURE&page_size=10&page=1&total_required=true');
  await h.service.completeConsent(h.who,a.id,value.nonce);
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v3/vault/payment-tokens').length,1);
});

test('two SQL workers produce one first capture, persist encrypted commands, and preserve earlier knowledge',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const before=buildSnapshot(await datasetFor(h.who,h.db));
  const run=await approvedRun(h);
  const second=new SeedExecutor({service:h.service,store:h.store,provider:h.transport.provider(new (await import('@fracture/paypal-core')).SandboxPayPalProvider({environment:'sandbox',baseUrl:'https://api-m.sandbox.paypal.com',clientId:'fixture-client',clientSecret:'fixture-secret',isolatedProject:'glasshouse'},h.transport.fetch)),evidence:new OrderEvidenceGateway(h.sdk.client)});
  const results=await Promise.all([h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1}),second.drain({tenantId:h.who.tenantId,runId:run.id,limit:1})]);
  assert.equal(results.reduce((sum,result)=>sum+result.claimed,0),1);
  const current=await h.service.viewRun(h.who,run.id);
  assert.equal(current.progress.captured,1);
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v2/checkout/orders').length,1);
  assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/capture')).length,1);
  const documents=await h.db.query<{document:string}>('SELECT document FROM paycore_operations');
  assert(documents.every(row=>!row.document.includes(h.fixture.tokenId)&&row.document.includes('operation-v1')));
  const dataset=await datasetFor(h.who,h.db);
  const historical=buildSnapshot(dataset,before.context);
  assert.equal(historical.sourceCoverage.sandboxPayments,0);
  assert.equal(historical.hash,before.hash);
  const now=buildSnapshot(dataset,{knownAt:new Date(Date.now()+10).toISOString()});
  assert.equal(now.sourceCoverage.sandboxPayments,1);
  assert.equal(now.tables.transition_snapshot.reduce((sum,row)=>sum+Number(row.captureCount),0),600);
  assert.equal(now.orders.find(order=>order.id===run.manifest.entries[0].orderId)?.fulfillmentState,before.orders.find(order=>order.id===run.manifest.entries[0].orderId)?.fulfillmentState);
  const revised=applyDeliveryRevision(dataset);
  assert.equal(revised.events.filter(event=>event.id.endsWith(':fulfillment.delivered:v2')).length,9);
  assert.equal(revised.orders.find(order=>order.id===run.manifest.entries[0].orderId)?.captureId,current.items.find(item=>item.status==='captured')?.providerCaptureId);
});

test('revoked SQL membership wins over an owner-shaped caller and a previously approved command',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const run=await approvedRun(h);
  const claim=h.store.claim.bind(h.store);
  h.store.claim=async(...args)=>{const result=await claim(...args);await h.db.query('UPDATE gh_memberships SET active=false,version=version+1 WHERE tenant_id=$1',[h.who.tenantId]);return result;};
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v2/checkout/orders').length,0);
  const operations=await h.store.list({tenantId:h.who.tenantId,projectId:'glasshouse'});
  assert.equal(operations[0].status,'not_sent');
  await assert.rejects(()=>h.service.approve({...h.who,role:'owner'},run.id,run.manifest.hash),/Current workspace authority/);
});

test('a lost create response retains its claim and never creates another order on restart',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const run=await approvedRun(h);h.fixture.createLost=true;
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  assert.equal((await h.service.viewRun(h.who,run.id)).progress.unknown,1);
  await h.db.query('UPDATE gh_seed_items SET next_attempt_at=now() WHERE tenant_id=$1',[h.who.tenantId]);
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v2/checkout/orders').length,1);
  assert.equal((await h.service.viewRun(h.who,run.id)).progress.captured,0);
});

test('a committed capture with a lost response reconciles by reads after worker restart',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const run=await approvedRun(h);h.fixture.captureLost=true;
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  assert.equal((await h.service.viewRun(h.who,run.id)).progress.unknown,1);
  h.fixture.readsUnavailable=false;
  await h.db.query('UPDATE gh_seed_items SET next_attempt_at=now() WHERE tenant_id=$1',[h.who.tenantId]);
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/capture')).length,1);
  assert.equal((await h.service.viewRun(h.who,run.id)).progress.captured,1);
  assert.equal((await h.store.list({tenantId:h.who.tenantId,projectId:'glasshouse'})).find(operation=>operation.command.action.kind==='capture_order')?.status,'succeeded');
});

test('a lost exchange reconciles a tokenized setup without issuing a second Vault write',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const status=await h.service.status(h.who);
  let run=await h.service.createRun(h.who,status.suggestedManifest.hash);
  run=await h.service.connect(h.who,run.id,run.manifest.hash,'http://localhost:4103');
  const row=(await h.db.query<{private_document:string}>('SELECT private_document FROM gh_payment_consents WHERE tenant_id=$1 AND id=$2',[h.who.tenantId,run.consent!.id]))[0];
  const value=h.secrets.open<{nonce:string}>(row.private_document,consentIdentity(h.who.tenantId,run.consent!.id));
  h.fixture.setupApproved=true;h.fixture.exchangeLost=true;
  run=await h.service.completeConsent(h.who,run.id,value.nonce);
  assert.equal(run.consent?.status,'unknown');
  run=await h.service.completeConsent(h.who,run.id);
  assert.equal(run.consent?.status,'verified');
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v3/vault/payment-tokens').length,1);
  assert.equal((await h.db.query<{status:string}>("SELECT status FROM gh_vault_operations WHERE kind='exchange'"))[0].status,'confirmed');
});

test('approval expiry stops new writes while a previously dispatched capture still reconciles',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const run=await approvedRun(h);h.fixture.captureLost=true;
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  h.fixture.readsUnavailable=false;
  await h.db.query("UPDATE gh_seed_runs SET approval_expires_at=now()-interval '1 second' WHERE tenant_id=$1",[h.who.tenantId]);
  await h.db.query('UPDATE gh_seed_items SET next_attempt_at=now() WHERE tenant_id=$1',[h.who.tenantId]);
  await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:2});
  const current=await h.service.viewRun(h.who,run.id);
  assert.equal(current.progress.captured,1);assert.equal(current.status,'held');
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v2/checkout/orders').length,1);
  assert.equal(h.fixture.writes.filter(row=>row.path.endsWith('/capture')).length,1);
});

test('unverified, foreign and changed manifests cannot turn a consent into payment authority',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  const status=await h.service.status(h.who);
  const run=await h.service.createRun(h.who,status.suggestedManifest.hash);
  await assert.rejects(()=>h.service.createRun(h.who,'0'.repeat(64)),/Reload the existing exact batch/);
  await assert.rejects(()=>h.service.approve(h.who,run.id,run.manifest.hash),/Verify the PayPal/);
  await h.db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,1)',['another-tenant',h.who.id,'owner']);
  await assert.rejects(()=>h.service.approve({...h.who,tenantId:'another-tenant',role:'owner'},run.id,run.manifest.hash),/outside your workspace/);
  await h.db.query("UPDATE gh_memberships SET role='viewer' WHERE tenant_id=$1",[h.who.tenantId]);
  await assert.rejects(()=>h.service.connect({...h.who,role:'owner'},run.id,run.manifest.hash,'http://localhost:4103'),/Current workspace authority/);
  assert.equal(h.fixture.writes.length,0);
});

test('token paging refuses repeated identities instead of returning a complete-looking partial set',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  h.fixture.tokenCreated=true;h.fixture.repeatTokenPage=true;
  await assert.rejects(()=>h.vault.listTokens(h.fixture.customerId),/incomplete saved-payment evidence/);
  assert.equal(h.fixture.requests.filter(row=>row.path==='/v3/vault/payment-tokens').length,2);
});

test('only exact first-customer absence permits the first exchange of the original approved setup',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  h.fixture.missingNewCustomer=true;
  const run=await approvedRun(h);
  assert.equal(run.consent?.status,'verified');
  const exchange=h.fixture.writes.filter(row=>row.path==='/v3/vault/payment-tokens');
  assert.equal(exchange.length,1);assert.equal(exchange[0].body.customer,undefined);
  const row=(await h.db.query<{private_document:string}>('SELECT private_document FROM gh_payment_consents WHERE tenant_id=$1 AND id=$2',[h.who.tenantId,run.consent!.id]))[0];
  const stored=h.secrets.open<{baselineAbsence:{status:number};baselineTokenIds:string[]}>(row.private_document,consentIdentity(h.who.tenantId,run.consent!.id));
  assert.equal(stored.baselineAbsence.status,404);assert.deepEqual(stored.baselineTokenIds,[]);
});

test('generic404 and stale setup evidence never become an empty token inventory',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());
  h.fixture.genericMissingCustomer=true;
  const status=await h.service.status(h.who);
  let run=await h.service.createRun(h.who,status.suggestedManifest.hash);
  run=await h.service.connect(h.who,run.id,run.manifest.hash,'http://localhost:4103');
  const row=(await h.db.query<{private_document:string}>('SELECT private_document FROM gh_payment_consents WHERE tenant_id=$1 AND id=$2',[h.who.tenantId,run.consent!.id]))[0];
  const value=h.secrets.open<{nonce:string;setup:{id:string};merchantCustomerId:string}>(row.private_document,consentIdentity(h.who.tenantId,run.consent!.id));
  h.fixture.setupApproved=true;
  run=await h.service.completeConsent(h.who,run.id,value.nonce);
  assert.equal(run.consent?.status,'unknown');
  assert.equal(h.fixture.writes.filter(row=>row.path==='/v3/vault/payment-tokens').length,0);
  const setup=await h.vault.getSetup(value.setup.id);
  h.fixture.genericMissingCustomer=false;h.fixture.missingNewCustomer=true;
  await assert.rejects(()=>h.vault.baselineTokens({...setup,receipt:{...setup.receipt,observedAt:'2020-01-01T00:00:00.000Z'}},value.merchantCustomerId));
  await assert.rejects(()=>h.vault.baselineTokens(setup,'another-merchant-customer'));
  await assert.rejects(()=>h.vault.listTokens(h.fixture.customerId));
});
