import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {OwnedPayment} from '../lib/server/recovery/authority';
import {agentHarness,functionCall,request,tool} from './helpers/agents';
const {ScopedPayPalToolkit}=await import('../lib/server/agents/toolkit');
const {AgentTools}=await import('../lib/server/agents/tools');
const {seedManifest}=await import('../packages/payments/manifest');
const {seedMarker}=await import('../lib/server/payments/execution');
const {buildSnapshot}=await import('../packages/domain');
const {snapshotContext}=await import('../lib/server/snapshots');
const {persistDataset,hash}=await import('../lib/server/repository');
type Harness=Awaited<ReturnType<typeof agentHarness>>;
const errorCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
const fixtureOwned=(suffix='A'):OwnedPayment=>({tenantId:`toolkit-fixture-${suffix}`,orderId:`local-${suffix}`,runId:`fixture-run-${suffix}`,entry:{orderId:`local-${suffix}`,reference:`TEST-${suffix}`,product:'Synthetic qualification item',amountMinor:4600,currency:'USD',resourceVersion:1},providerOrderId:`ORDER_${suffix}`,captureId:`CAPTURE_${suffix}`,customId:`fixture-owned-${suffix}`,orderGrantVersion:1,captureGrantVersion:1});

/** Actual installed Toolkit code, with an explicitly synthetic HTTP transport. */
class ToolkitWire {
  requests:{method:string;url:URL;redirect:RequestRedirect|undefined}[]=[];
  status=200;replacement:unknown=undefined;onRead:(()=>Promise<void>)|null=null;onToken:(()=>Promise<void>)|null=null;
  constructor(readonly owned:OwnedPayment,readonly disputeId='CASE_FIXTURE'){}
  order(){return {id:this.owned.providerOrderId,status:'COMPLETED',payer:{email_address:'PRIVATE_PAYER_NOT_FOR_MODEL'},purchase_units:[{custom_id:this.owned.customId,payments:{captures:[{id:this.owned.captureId,status:'COMPLETED',amount:{currency_code:'USD',value:(this.owned.entry.amountMinor/100).toFixed(2)},create_time:'2026-11-11T10:00:00Z'}]}}]};}
  dispute(){return {dispute_id:this.disputeId,status:'WAITING_FOR_BUYER_RESPONSE',reason:'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',dispute_life_cycle_stage:'INQUIRY',dispute_amount:{currency_code:'USD',value:'46.00'},update_time:'2026-11-11T10:00:00Z',disputed_transactions:[{seller_transaction_id:this.owned.captureId,gross_amount:{currency_code:'USD',value:(this.owned.entry.amountMinor/100).toFixed(2)}}],messages:[{content:'PRIVATE_CASE_TEXT_NOT_FOR_MODEL'}]};}
  reporting(){return {page:1,total_items:1,total_pages:1,last_refreshed_datetime:'2026-11-11T03:29:59Z',transaction_details:[{transaction_info:{transaction_id:this.owned.captureId,transaction_status:'S',transaction_initiation_date:'2026-11-11T10:00:00Z',transaction_amount:{currency_code:'USD',value:(this.owned.entry.amountMinor/100).toFixed(2)}},payer_info:{email_address:'PRIVATE_REPORTING_PAYER'}}]};}
  fetch:typeof fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    assert.equal(url.origin,'https://api.sandbox.paypal.com');
    const method=init?.method??'GET';this.requests.push({method,url,redirect:init?.redirect});
    if(url.pathname==='/v1/oauth2/token'){
      assert.equal(method,'POST');assert.equal(init?.body,'grant_type=client_credentials');await this.onToken?.();
      return this.json({access_token:'fixture-access-token',token_type:'Bearer',expires_in:300});
    }
    assert.equal(method,'GET');await this.onRead?.();
    const value=this.replacement!==undefined?this.replacement:url.pathname.startsWith('/v2/checkout/orders/')?this.order():url.pathname==='/v1/customer/disputes'?{items:[this.dispute()]}:url.pathname.startsWith('/v1/customer/disputes/')?this.dispute():url.pathname==='/v1/reporting/transactions'?this.reporting():assert.fail('Unregistered Toolkit URL');
    return this.json(value,this.status);
  };
  private json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','paypal-debug-id':'fixture-debug'}});}
  toolkit(){return new ScopedPayPalToolkit('fixture-client-id','fixture-client-secret','synthetic',this.fetch);}
}

/** Fixture-only admission: no PayPal executor, external call or real ledger. */
async function admitSyntheticOwned(h:Harness){
  const manifest=seedManifest(h.dataset),entry=manifest.entries[0],suffix=randomBytes(5).toString('hex');
  const owned:OwnedPayment={tenantId:h.who.tenantId,orderId:entry.orderId,runId:`toolkit-fixture-${suffix}`,entry,providerOrderId:`ORDER_${suffix}`,captureId:`CAPTURE_${suffix}`,customId:'',orderGrantVersion:1,captureGrantVersion:1};
  owned.customId=seedMarker(owned.tenantId,owned.runId,owned.orderId);
  await h.db.query('INSERT INTO gh_seed_runs(tenant_id,id,seed_version,manifest_hash,manifest,status,created_by,membership_version) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)',[h.who.tenantId,owned.runId,manifest.seedVersion,manifest.hash,JSON.stringify(manifest),'complete',h.who.id,h.who.membershipVersion]);
  await h.db.query("INSERT INTO gh_seed_items(tenant_id,run_id,order_id,entry,status,provider_order_id,provider_capture_id) VALUES($1,$2,$3,$4::jsonb,'captured',$5,$6)",[h.who.tenantId,owned.runId,owned.orderId,JSON.stringify(entry),owned.providerOrderId,owned.captureId]);
  for(const [kind,id] of [['order',owned.providerOrderId],['capture',owned.captureId]])await h.db.query('INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body) VALUES($1,$2,$3,$4,$5,now(),$6::jsonb)',[h.who.tenantId,kind,id,owned.orderId,owned.runId,JSON.stringify({syntheticTransport:true,notAProviderObservation:true})]);
  const source=h.dataset.events.find(event=>event.orderId===owned.orderId&&event.type==='payment.captured')!;
  source.sourceClass='sandbox';source.sourceLabel='Synthetic Toolkit qualification transport';source.sourceRef='fixture://owned-capture';
  source.payload={...source.payload,paypalOrderId:owned.providerOrderId,captureId:owned.captureId,providerResourceId:owned.captureId,syntheticTransport:true};
  for(const interval of h.dataset.intervals.filter(row=>row.sourceEventId===source.id))interval.sourceClass='sandbox';
  const record=h.dataset.orders.find(row=>row.id===owned.orderId)!;record.paymentSource='sandbox';record.captureId=owned.captureId;record.paypalOrderId=owned.providerOrderId;
  await persistDataset(h.db,h.dataset);
  Object.assign(h.snapshot,await h.saveSnapshot(buildSnapshot(h.dataset,snapshotContext(h.who,h.dataset))));
  return owned;
}
async function issued(h:Harness,name:string,args:Record<string,unknown>){
  const child=await h.handoff(await h.begin(),'investigator'),call=functionCall(name,args);
  await h.issue(child.run.id,[tool(name)],[call]);
  return {runId:child.run.id,callId:call.call_id,name,args,clientId:h.clientId,snapshotHash:h.snapshot.hash};
}

test('installed Toolkit executes its four scoped reads and returns bounded, redacted, explicitly synthetic facts',async()=>{
  const owned=fixtureOwned(),wire=new ToolkitWire(owned),toolkit=wire.toolkit();let guards=0;
  const names=['paypal_get_order','paypal_list_disputes','paypal_get_dispute','paypal_find_transaction'];
  const results=[];
  for(const name of names)results.push(await toolkit.read(name,owned,name==='paypal_get_dispute'?wire.disputeId:undefined,async()=>{guards++;}));
  assert.equal(guards,8);assert.equal(wire.requests.length,8);assert.ok(wire.requests.every(row=>row.redirect==='error'));
  assert.deepEqual(wire.requests.map(row=>row.method),['POST','GET','POST','GET','POST','GET','POST','GET']);
  assert.ok(results.every(result=>result.transport==='Toolkit'&&result.source==='synthetic_transport'&&result.package==='@paypal/agent-toolkit@1.11.0'&&result.bodyHash.length===64));
  assert.equal(JSON.stringify(results).includes('PRIVATE_'),false);assert.equal(JSON.stringify(results).includes('fixture-access-token'),false);
  assert.equal(results[0].facts.amountMinor,4600);assert.equal((results[1].facts.disputes as {status:string}[])[0].status,'WAITING_FOR_BUYER_RESPONSE');
  assert.equal(results[3].coverage.complete,false);assert.equal(results[3].facts.providerRefreshedAt,'2026-11-11T03:29:59.000Z');assert.match(results[3].disclosure,/absence.*does not establish/);
  const reporting=wire.requests.at(-1)!.url;assert.ok(reporting.searchParams.getAll('transaction_id').every(id=>id===owned.captureId));assert.equal(reporting.searchParams.get('page'),'1');
});

test('Toolkit wrapper blocks writes before OAuth and verifies exact returned order, capture, marker and amount',async()=>{
  const owned=fixtureOwned(),wire=new ToolkitWire(owned),toolkit=wire.toolkit();
  await assert.rejects(toolkit.read('refund_payment',owned,undefined,async()=>{}),errorCode('TOOLKIT_WRITE_DENIED'));assert.equal(wire.requests.length,0);
  await assert.rejects(toolkit.read('paypal_get_dispute',owned,undefined,async()=>{}),errorCode('TOOLKIT_EVIDENCE_UNVERIFIED'));assert.equal(wire.requests.length,0);
  for(const field of ['id','capture','marker','amount']){
    const body=wire.order();if(field==='id')body.id='FOREIGN_ORDER';if(field==='capture')body.purchase_units[0].payments.captures[0].id='FOREIGN_CAPTURE';if(field==='marker')body.purchase_units[0].custom_id='FOREIGN_MARKER';if(field==='amount')body.purchase_units[0].payments.captures[0].amount.value='100.00';wire.replacement=body;
    await assert.rejects(toolkit.read('paypal_get_order',owned,undefined,async()=>{}),errorCode('TOOLKIT_EVIDENCE_UNVERIFIED'));
  }
});

test('Toolkit reporting failures and foreign or malformed pages never become a clean absent-payment result',async()=>{
  const owned=fixtureOwned(),wire=new ToolkitWire(owned),toolkit=wire.toolkit();
  wire.status=503;wire.replacement={error:'synthetic outage'};
  await assert.rejects(toolkit.read('paypal_find_transaction',owned,undefined,async()=>{}),errorCode('TOOLKIT_READ_UNRESOLVED'));assert.equal(wire.requests.length,2);
  wire.status=200;
  for(const body of [{...wire.reporting(),transaction_details:[{transaction_info:{...wire.reporting().transaction_details[0].transaction_info,transaction_id:'FOREIGN_CAPTURE'}}]}, {...wire.reporting(),page:2}, {...wire.reporting(),total_items:-1}, {found:false}]){
    wire.replacement=body;await assert.rejects(toolkit.read('paypal_find_transaction',owned,undefined,async()=>{}),errorCode('TOOLKIT_EVIDENCE_UNVERIFIED'));
  }
  wire.replacement={page:1,total_items:0,total_pages:0};const empty=await toolkit.read('paypal_find_transaction',owned,undefined,async()=>{});assert.equal(empty.facts.observed,false);assert.equal(empty.coverage.complete,false);assert.match(empty.disclosure,/lag/);
});

test('concurrent installed Toolkit reads retain separate owned-resource contexts',async()=>{
  const one=new ToolkitWire(fixtureOwned('ONE')),two=new ToolkitWire(fixtureOwned('TWO'));
  const values=await Promise.all([one.toolkit().read('paypal_get_order',one.owned,undefined,async()=>{}),two.toolkit().read('paypal_get_order',two.owned,undefined,async()=>{})]);
  assert.equal(values[0].captureId,'CAPTURE_ONE');assert.equal(values[1].captureId,'CAPTURE_TWO');assert.equal(one.requests.length,2);assert.equal(two.requests.length,2);
});

test('owned Toolkit tool executes once, persists an encrypted receipt and rechecks grants on replay',async t=>{
  const h=await agentHarness();t.after(h.dispose);const owned=await admitSyntheticOwned(h),wire=new ToolkitWire(owned),tools=new AgentTools(h.journal,wire.toolkit());
  const call=await issued(h,'paypal_get_order',{orderId:owned.orderId});
  const before=hash(h.dataset),first=await tools.claim(h.who,call);assert.equal(first.result?.success,true);assert.deepEqual(await tools.claim(h.who,call),first);assert.equal(wire.requests.length,2);
  const row=(await h.db.query<import('../lib/server/agents/journal').ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE id=$1',[call.callId]))[0];assert.equal(row.dispatch_count,1);assert.equal(row.private_document.includes(owned.captureId),false);assert.equal(row.private_document.includes('PRIVATE_'),false);assert.equal(hash(h.dataset),before);assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);
  await h.db.query("UPDATE gh_provider_resources SET active=false WHERE kind='capture'");
  await assert.rejects(tools.claim(h.who,call),errorCode('OWNED_CAPTURE_REQUIRED'));assert.equal(wire.requests.length,2);
  await assert.rejects(h.models.submit(h.who,{runId:call.runId,index:1,request:request([tool('read_incident')]),clientId:h.clientId,snapshotHash:h.snapshot.hash}),errorCode('OWNED_CAPTURE_REQUIRED'));
});

test('a model-issued foreign local order and an unbound dispute are denied before Toolkit OAuth',async t=>{
  const h=await agentHarness();t.after(h.dispose);const owned=await admitSyntheticOwned(h),wire=new ToolkitWire(owned),tools=new AgentTools(h.journal,wire.toolkit());
  const foreign=await issued(h,'paypal_get_order',{orderId:'foreign-local-order'});await assert.rejects(tools.claim(h.who,foreign),errorCode('TOOLKIT_OWNED_SNAPSHOT_REQUIRED'));
  const unbound=await issued(h,'paypal_get_dispute',{orderId:owned.orderId,disputeId:'UNBOUND_CASE'});await assert.rejects(tools.claim(h.who,unbound),errorCode('TOOLKIT_CASE_BINDING'));assert.equal(wire.requests.length,0);
});

test('revocation between Toolkit OAuth and GET prevents the read and preserves an explicit failure',async t=>{
  const h=await agentHarness();t.after(h.dispose);const owned=await admitSyntheticOwned(h),wire=new ToolkitWire(owned),tools=new AgentTools(h.journal,wire.toolkit());
  const call=await issued(h,'paypal_get_order',{orderId:owned.orderId});wire.onToken=async()=>{await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);};
  await assert.rejects(tools.claim(h.who,call),errorCode('CURRENT_AUTHORITY_REQUIRED'));assert.equal(wire.requests.length,1);
  const row=(await h.db.query<import('../lib/server/agents/journal').ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE id=$1',[call.callId]))[0];assert.equal(h.journal.toolDocument(row).result?.success,false);assert.equal(row.dispatch_count,1);
});

test('a Toolkit response racing resource revocation is encrypted and cannot be disclosed or replayed',async t=>{
  const h=await agentHarness();t.after(h.dispose);const owned=await admitSyntheticOwned(h),wire=new ToolkitWire(owned),tools=new AgentTools(h.journal,wire.toolkit());
  const call=await issued(h,'paypal_get_order',{orderId:owned.orderId});wire.onRead=async()=>{await h.db.query("UPDATE gh_provider_resources SET version=version+1 WHERE kind='capture'");};
  await assert.rejects(tools.claim(h.who,call),errorCode('TOOLKIT_GRANT_CHANGED'));assert.equal(wire.requests.length,2);
  const row=(await h.db.query<import('../lib/server/agents/journal').ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE id=$1',[call.callId]))[0];assert.equal(row.state,'completed');assert.equal(h.journal.toolDocument(row).result?.success,true);assert.equal(row.private_document.includes(owned.captureId),false);
  await assert.rejects(tools.claim(h.who,call),errorCode('TOOLKIT_GRANT_CHANGED'));assert.equal(wire.requests.length,2);
});

test('disabled Toolkit reads produce a recorded refusal without claiming successful Toolkit transport',async t=>{
  const h=await agentHarness();t.after(h.dispose);const owned=await admitSyntheticOwned(h),call=await issued(h,'paypal_get_order',{orderId:owned.orderId});
  const result=await h.tools.claim(h.who,call);assert.equal(result.result?.success,false);
  const events=await h.db.query<{body:import('../packages/domain/types').AgentRunEvent}>('SELECT body FROM gh_agent_durable_events');
  const complete=events.filter(({body})=>body.toolName==='paypal_get_order'&&body.eventType==='tool_completed');
  assert.equal(complete.length,1);assert.equal(complete[0].body.transportKind,'application');assert.equal(complete[0].body.resultStatus,'denied');
});
