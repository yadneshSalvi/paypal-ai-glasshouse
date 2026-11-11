import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@fracture/paypal-core';
import { DisputesGateway, evidenceObserved, normalizeDispute, type DisputeOwner, type FulfillmentEvidence } from '../lib/server/recovery/disputes';
import { OneWriteTransport } from '../lib/server/payments/transport';
import { DisputeService } from '../lib/server/recovery/dispute-service';
import { ensureRecoverySchema } from '../lib/server/recovery/schema';
import { ownedPayment } from '../lib/server/recovery/authority';
import { paymentHarness, approvedRun } from './helpers/payments';
import { datasetFor } from '../lib/server/repository';
import { buildSnapshot } from '../packages/domain';

const origin='https://api-m.sandbox.paypal.com';
const owner:DisputeOwner={captureId:'CAPTURE-OWNED-1',amountMinor:4500,currency:'USD'};
function caseBody(current:DisputeOwner=owner):Record<string,unknown> {
  const now=new Date(Date.now()-500).toISOString();
  return {dispute_id:'PP-R-TEST-1',create_time:now,update_time:now,reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',status:'WAITING_FOR_SELLER_RESPONSE',dispute_life_cycle_stage:'CHARGEBACK',
    dispute_amount:{currency_code:'USD',value:(current.amountMinor/100).toFixed(2)},seller_response_due_date:new Date(Date.now()+86_400_000).toISOString(),
    disputed_transactions:[{seller_transaction_id:current.captureId,buyer_transaction_id:'BUYER-DISTINCT-1',gross_amount:{currency_code:'USD',value:(current.amountMinor/100).toFixed(2)},buyer:{name:'Private buyer'},seller:{email:'private@example.test'}}],
    evidences:[{evidence_type:'PROOF_OF_FULFILLMENT',source:'REQUESTED_FROM_SELLER'}],messages:[{content:'Private provider message'}],
    links:[{href:`${origin}/v1/customer/disputes/PP-R-TEST-1/provide-evidence`,rel:'provide_evidence',method:'POST'}]};
}
function response(value:unknown,status=200) {return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Paypal-Debug-Id':'fixture-case-debug'}});}
class Cases {
  body=caseBody();
  pages:Array<Record<string,unknown>>=[{items:[{dispute_id:'PP-R-TEST-1'}],links:[]}];
  requests:Array<{method:string;path:string;query:string}>=[];
  posts:Array<unknown>=[];
  lost=false;
  denyRead=false;
  missingSubmitted=false;
  readonly fetch:typeof fetch=async(input,init)=>{
    const request=new Request(input,init);const url=new URL(request.url);
    assert.equal(url.origin,origin);
    this.requests.push({method:request.method,path:url.pathname,query:url.search});
    if(url.pathname==='/v1/oauth2/token')return response({access_token:'fixture-rest-credential',token_type:'Bearer',expires_in:3600});
    if(this.denyRead&&request.method==='GET')return response({name:'INTERNAL_ERROR'},500);
    if(url.pathname==='/v1/customer/disputes')return response(this.pages[Number(url.searchParams.get('page')??1)-1]);
    if(url.pathname==='/v1/customer/disputes/PP-R-TEST-1'&&request.method==='GET')return response(this.body);
    if(url.pathname==='/v1/customer/disputes/PP-R-TEST-1/provide-evidence'&&request.method==='POST'){
      assert.match(request.headers.get('content-type')??'',/^multipart\/form-data;/);
      assert.equal(request.headers.get('paypal-request-id'),null);
      const form=await request.formData();const part=form.get('input');assert(part instanceof Blob);
      assert.equal(part.type,'application/json');
      const body=JSON.parse(await part.text()) as {evidences:Array<Record<string,unknown>>};
      this.posts.push(body);
      if(!this.missingSubmitted)this.body.evidences=[...(this.body.evidences as unknown[]),{...body.evidences[0],source:'SUBMITTED_BY_SELLER',date:new Date().toISOString()}];
      if(this.lost)throw new Error('Fixture lost response after accepted data POST');
      return response({links:[{href:`${origin}/v1/customer/disputes/PP-R-TEST-1`,rel:'self',method:'GET'}]});
    }
    throw new Error('Unexpected fixed fixture request');
  };
  gateway() {return new DisputesGateway('fixture-client','fixture-secret',new OneWriteTransport(this.fetch));}
}
const request:FulfillmentEvidence={...owner,disputeId:'PP-R-TEST-1',operationId:'recovery-dispute-test-1',trackingNumber:'SYNTHETIC-FW-0010',carrierName:'Fernwood regional fixture',
  notes:'Sandbox exercise; synthetic shipping evidence. No physical delivery is asserted. Glasshouse operation recovery-dispute-test-1. The fixture records a regional delay.'};

test('scoped Disputes normalization binds seller capture, keeps distinct buyer identity and strips provider personal text',()=>{
  const body=caseBody();
  const normalized=normalizeDispute(body,'PP-R-TEST-1',owner);
  assert.equal(normalized.captureId,owner.captureId);assert.equal(normalized.buyerTransactionId,'BUYER-DISTINCT-1');
  assert.deepEqual(normalized.actions,['provide-evidence']);assert(normalized.sellerResponseDueAt);
  assert(!JSON.stringify(normalized).includes('Private'));assert(!JSON.stringify(normalized).includes('private@example.test'));
  assert.throws(()=>normalizeDispute(body,'PP-R-TEST-1',{...owner,captureId:'FOREIGN-CAPTURE'}));
  assert.throws(()=>normalizeDispute(body,'PP-R-TEST-1',{...owner,amountMinor:4400}));
  assert.throws(()=>normalizeDispute({...body,disputed_transactions:[...(body.disputed_transactions as unknown[]),...(body.disputed_transactions as unknown[])]},'PP-R-TEST-1',owner));
  const unknown=normalizeDispute({...body,status:'FUTURE_STATE'},'PP-R-TEST-1',owner);assert.equal(unknown.status,'FUTURE_STATE');
});

test('a dispute inventory is empty only after a complete scoped response; pagination cannot widen or repeat',async()=>{
  const fixture=new Cases();fixture.pages=[{items:[],links:[]}];
  const empty=await fixture.gateway().list(owner);assert.equal(empty.complete,true);assert.deepEqual(empty.ids,[]);
  assert.equal(fixture.requests.at(-1)?.query,'?disputed_transaction_id=CAPTURE-OWNED-1&page_size=50');
  fixture.pages=[{links:[]}];await assert.rejects(()=>fixture.gateway().list(owner));
  fixture.pages=[{items:[{dispute_id:'PP-R-TEST-1'}],links:[{rel:'next',method:'GET',href:`${origin}/v1/customer/disputes?page=2&page_size=50`}]}];
  await assert.rejects(()=>fixture.gateway().list(owner),/owned capture scope/);
  fixture.pages=[{items:[{dispute_id:'PP-R-TEST-1'}],links:[{rel:'next',method:'GET',href:`${origin}/v1/customer/disputes?disputed_transaction_id=${owner.captureId}&page_size=50&page=2`}]},{items:[{dispute_id:'PP-R-TEST-1'}],links:[]}];
  await assert.rejects(()=>fixture.gateway().list(owner),/repeated a dispute identity/);
  fixture.pages[1]={items:[{dispute_id:'PP-R-TEST-2'}],links:[]};
  assert.deepEqual((await fixture.gateway().list(owner)).ids,['PP-R-TEST-1','PP-R-TEST-2']);
  fixture.denyRead=true;await assert.rejects(()=>fixture.gateway().list(owner));assert.equal(fixture.posts.length,0);
});

test('SQL dispute import uses current owned grants, deduplicates observations and leaves prior T/K snapshots unchanged',async t=>{
  const h=await paymentHarness();t.after(()=>h.pg.close());await ensureRecoverySchema(h.db);
  const run=await approvedRun(h);await h.executor.drain({tenantId:h.who.tenantId,runId:run.id,limit:1});
  const payment=await ownedPayment(h.db,h.who,run.manifest.entries[0].orderId);
  const fixture=new Cases();fixture.body=caseBody({captureId:payment.captureId,amountMinor:payment.entry.amountMinor,currency:'USD'});
  const service=new DisputeService(h.db,fixture.gateway(),h.evidence);
  const before=buildSnapshot(await datasetFor(h.who,h.db),{knownAt:new Date().toISOString()});
  const result=await service.syncOrder(h.who,payment.orderId);assert.equal(result.disputes.length,1);
  const afterDataset=await datasetFor(h.who,h.db);
  const historical=buildSnapshot(afterDataset,before.context);assert.equal(historical.hash,before.hash);
  const now=buildSnapshot(afterDataset,{knownAt:new Date(Date.now()+100).toISOString()});
  const current=now.orders.find(order=>order.id===payment.orderId)!;
  assert.equal(current.disputeId,'PP-R-TEST-1');assert.equal(current.disputeSource,'sandbox');assert.equal(current.disputeState,'waiting_for_seller_response');
  assert.equal(current.fulfillmentState,before.orders.find(order=>order.id===payment.orderId)!.fulfillmentState);
  assert.equal(current.refundedMinor,0);assert.equal(current.trackingInPayPal,false);
  assert.equal(current.resourceVersion,before.orders.find(order=>order.id===payment.orderId)!.resourceVersion+1);
  await service.syncOrder(h.who,payment.orderId);
  assert.equal((await datasetFor(h.who,h.db)).revision,afterDataset.revision);
  const priorCalls=fixture.requests.length;
  await assert.rejects(()=>service.syncOrder({...h.who,tenantId:'foreign-workspace'},payment.orderId));
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);
  await assert.rejects(()=>service.syncOrder({...h.who,role:'owner'},payment.orderId),/Current workspace/);
  assert.equal(fixture.requests.length,priorCalls);
});

test('multipart evidence requires current case state, exact fixture notes and a fresh authority callback, then independent merchant read',async()=>{
  const fixture=new Cases();let checks=0;
  const result=await fixture.gateway().provideEvidence(request,async()=>{checks++;});
  assert.equal(checks,1);assert.equal(fixture.posts.length,1);assert.equal(result.submitted,true);assert(evidenceObserved(result.observation,request));
  assert(!JSON.stringify(result.observation).includes(request.notes));assert.equal(result.observation.status,'WAITING_FOR_SELLER_RESPONSE');
  assert.deepEqual((fixture.posts[0] as {evidences:unknown[]}).evidences,[{evidence_type:'PROOF_OF_FULFILLMENT',evidence_info:{tracking_info:[{carrier_name:'OTHER',carrier_name_other:request.carrierName,tracking_number:request.trackingNumber}]},notes:request.notes}]);
  assert.equal(fixture.requests.filter(row=>row.method==='GET'&&row.path.endsWith('PP-R-TEST-1')).length,2);
  await assert.rejects(()=>fixture.gateway().provideEvidence(request,async()=>{}),/already present/);assert.equal(fixture.posts.length,1);
});

test('ambiguous accepted evidence is read-reconciled by exact original marker; HTTP acceptance alone is not submission proof',async()=>{
  const fixture=new Cases();fixture.lost=true;const gateway=fixture.gateway();
  await assert.rejects(()=>gateway.provideEvidence(request,async()=>{}),error=>error instanceof ProviderError&&error.outcome==='unknown');
  assert.equal(fixture.posts.length,1);
  const current=await gateway.get(request.disputeId,owner);assert(evidenceObserved(current,request));
  assert(!evidenceObserved(current,{...request,notes:request.notes+' Changed.'}));
  const incomplete=new Cases();incomplete.missingSubmitted=true;
  const result=await incomplete.gateway().provideEvidence(request,async()=>{});assert.equal(result.receipt.status,200);assert.equal(result.submitted,false);
});

test('unknown state, expired deadline, item-specific request, foreign action URL and revoked authority cannot send evidence',async()=>{
  for(const change of [
    {status:'FUTURE_STATE'},
    {seller_response_due_date:'2020-01-01T00:00:00Z'},
    {evidences:[{evidence_type:'PROOF_OF_FULFILLMENT',source:'REQUESTED_FROM_SELLER',item_id:'unbound-item'}]},
    {links:[{rel:'provide_evidence',method:'POST',href:'https://foreign.example/v1/customer/disputes/PP-R-TEST-1/provide-evidence'}]},
  ]) {
    const fixture=new Cases();fixture.body={...fixture.body,...change};
    await assert.rejects(()=>fixture.gateway().provideEvidence(request,async()=>{}));assert.equal(fixture.posts.length,0);
  }
  const fixture=new Cases();
  await assert.rejects(()=>fixture.gateway().provideEvidence(request,async()=>{throw new Error('Current role was revoked');}));assert.equal(fixture.posts.length,0);
  await assert.rejects(()=>fixture.gateway().provideEvidence({...request,notes:'Claiming physical delivery'},async()=>{}));assert.equal(fixture.posts.length,0);
});
