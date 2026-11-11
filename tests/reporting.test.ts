import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PaypalClient} from 'paypal';
import {recoveryHarness} from './helpers/recovery';
import {digest} from '../packages/payments/security';
import {ReportingGateway,type ReportingGrant,type ReportingReader} from '../lib/server/reporting/gateway';
import {ReportingService} from '../lib/server/reporting/service';
import {ensureReportingSchema} from '../lib/server/reporting/schema';
import {ensureObservationSchema} from '../lib/server/observations/schema';
import {bindConnector,type ObservationConnector} from '../lib/server/observations/connector';
import type {ReportingPage} from '../packages/reporting/types';
import {HttpError} from '../lib/server/errors';
const start='2026-11-01T00:00:00.000Z',end='2026-11-02T00:00:00.000Z',refreshed='2026-11-03T00:00:00.000Z';
const input=()=>({requestId:randomUUID(),start,end});
function page(number:number,grants:ReportingGrant[],totalPages=1):ReportingPage{
 const g=grants[0]!;return {page:number,totalPages,totalItems:totalPages,returned:1,excluded:0,refreshedAt:refreshed,observedAt:new Date().toISOString(),bodyHash:digest({number,g}),
 entries:[{transactionId:g.id,kind:g.kind,orderId:g.orderId,status:'S',amountMinor:4200,currency:'USD',occurredAt:start,updatedAt:start}]};}
async function harness(reader:ReportingReader){const h=await recoveryHarness();await ensureObservationSchema(h.db);await ensureReportingSchema(h.db);
 const c:ObservationConnector={id:'reporting-connector',tenantId:h.who.tenantId,credentialHash:digest('client'),webhookId:'WEBHOOK-REPORTING-TEST',merchantId:'MERCHANT-REPORTING-TEST',configHash:digest('reporting-binding')};await bindConnector(h.db,c);
 return {...h,connector:c,reporting:new ReportingService(h.db,c,reader),due:()=>h.db.query("UPDATE gh_reporting_windows SET next_attempt_at=now()-interval '1 second'")};}
function client(answers:()=>Response){const requests:Request[]=[];const sdk=new PaypalClient({oauth2:{clientId:'fixture-client',clientSecret:'fixture-secret'},logging:{level:'off'},retry:{maxRetries:0},fetch:async(input,init)=>{
 const r=new Request(input,init);requests.push(r);return r.url.endsWith('/token')?Response.json({access_token:'fixture-token',token_type:'Bearer',expires_in:3600}):answers();}});return{gateway:new ReportingGateway(sdk),requests};}
const grant:ReportingGrant={id:'OWNED-CAPTURE',kind:'capture',orderId:'owned-order',version:1};
test('actual SDK reporting GET preserves exact filters, signed money, owned scope and private-field exclusion',async()=>{
 const h=client(()=>Response.json({page:1,total_pages:1,total_items:2,last_refreshed_datetime:refreshed,transaction_details:[
 {transaction_info:{transaction_id:grant.id,transaction_status:'S',transaction_amount:{currency_code:'USD',value:'-5.00'},transaction_initiation_date:start,transaction_updated_date:start,transaction_note:'private-note'},payer_info:{email_address:'private@example.test'}},
 {transaction_info:{transaction_id:'UNOWNED',transaction_status:'S',transaction_amount:{currency_code:'USD',value:'99.00'},transaction_initiation_date:start,transaction_updated_date:start}}]}));
 const r=await h.gateway.read(start,end,1,[grant],AbortSignal.timeout(2000));assert.equal(r.entries.length,1);assert.equal(r.entries[0].amountMinor,-500);assert.equal(r.excluded,1);assert(!JSON.stringify(r).includes('private'));assert(!JSON.stringify(r).includes('UNOWNED'));
 const request=h.requests[1],url=new URL(request.url);assert.equal(request.method,'GET');assert.equal(url.pathname,'/v1/reporting/transactions');assert.equal(request.headers.get('content-type'),null);
 assert.deepEqual(Object.fromEntries(url.searchParams),{start_date:start,end_date:end,fields:'transaction_info',balance_affecting_records_only:'Y',page_size:'100',page:'1'});
});
test('an explicitly empty report differs from malformed pagination, stale pages and provider refusal',async()=>{
 const empty=client(()=>Response.json({page:1,total_pages:0,total_items:0}));assert.equal((await empty.gateway.read(start,end,1,[grant],AbortSignal.timeout(2000))).entries.length,0);
 for(const value of [{page:2,total_pages:2,total_items:2,transaction_details:[]},{page:1,total_items:0},{page:1,total_pages:0,total_items:0,transaction_details:[{}]}]){
 const h=client(()=>Response.json(value));await assert.rejects(h.gateway.read(start,end,1,[grant],AbortSignal.timeout(2000)),(e:unknown)=>e instanceof HttpError&&e.code==='REPORTING_SHAPE_UNCERTAIN');}
 for(const status of [400,403,429,500]){const h=client(()=>Response.json({name:'INVALID_REQUEST',message:'Choose a valid start date.',debug_id:'fixture-debug'}, {status}));await assert.rejects(h.gateway.read(start,end,1,[grant],AbortSignal.timeout(2000)),(e:unknown)=>e instanceof HttpError&&e.status===(status===400?400:status===500?502:503));assert.equal(h.requests.length,2);}
});
test('durable page cursor resumes across instances and repeated owned observations retain one evidence version',async t=>{
 const calls:number[]=[];const reader:ReportingReader={read:async(_s,_e,n,g)=>{calls.push(n);return page(n,g,2);}};const h=await harness(reader);t.after(()=>h.pg.close());const writes=h.fixture.writes.length;
 const original=input(),run=await h.reporting.start(h.who,original);assert.equal((await h.reporting.start(h.who,original)).id,run.id);await assert.rejects(h.reporting.start(h.who,{...original,end:'2026-11-03T00:00:00.000Z'}),/different dates/);
 await h.reporting.drain({tenantId:h.who.tenantId,limit:1});assert.deepEqual(calls,[1]);let overview=await h.reporting.overview(h.who);assert.equal(overview.runs[0].state,'active');assert.equal(overview.runs[0].coverage[0].nextPage,2);
 await h.due();await new ReportingService(h.db,h.connector,reader).drain({tenantId:h.who.tenantId,limit:1});overview=await h.reporting.overview(h.who);assert.equal(overview.runs[0].state,'complete');assert.equal(overview.runs[0].pages,2);assert.equal(overview.runs[0].observedResources,1);assert.equal(h.fixture.writes.length,writes);
 assert.equal((await h.db.query('SELECT * FROM gh_reporting_evidence')).length,1);await assert.rejects(h.reporting.overview({...h.who,tenantId:'foreign'}),/membership/);
});
test('a changed reporting generation cannot be labelled complete and earlier pages survive cancellation',async t=>{
 const h=await harness({read:async(_s,_e,n,g)=>({...page(n,g,2),refreshedAt:n===1?refreshed:'2026-11-04T00:00:00.000Z'})});t.after(()=>h.pg.close());const r=await h.reporting.start(h.who,input());await h.reporting.drain({limit:1});await h.due();await h.reporting.drain({limit:1});
 let run=(await h.reporting.overview(h.who)).runs[0];assert.equal(run.state,'attention');assert.equal(run.pages,1);assert.match(run.reason!,/refreshed/);assert.equal(run.observedResources,1);
 await h.reporting.cancel(h.who,r.id);run=(await h.reporting.overview(h.who)).runs[0];assert.equal(run.state,'cancelled');assert.equal(run.pages,1);assert.equal((await h.reporting.drain()).processed,0);
});
test('transient read failures retry the same saved page and never fabricate an empty report',async t=>{
 let count=0;const h=await harness({read:async(_s,_e,n,g)=>{if(count++===0)throw new HttpError(503,'REPORTING_RATE_LIMIT','Controlled rate limit');return page(n,g);}});t.after(()=>h.pg.close());await h.reporting.start(h.who,input());await h.reporting.drain({limit:1});
 let run=(await h.reporting.overview(h.who)).runs[0];assert.equal(run.pages,0);assert.equal(run.observedResources,0);assert.equal(run.coverage[0].nextPage,1);assert.equal(run.coverage[0].state,'retry');await h.due();await h.reporting.drain({limit:1});run=(await h.reporting.overview(h.who)).runs[0];assert.equal(run.state,'complete');assert.equal(count,2);
 const attempts=await h.db.query<{state:string}>('SELECT state FROM gh_reporting_pages ORDER BY started_at');assert.deepEqual(attempts.map(a=>a.state),['failed','complete']);
});
test('revocation during a read rejects its late data and never changes original money records',async t=>{
 let mutate:()=>Promise<unknown>;const h=await harness({read:async(_s,_e,n,g)=>{await mutate();return page(n,g);}});t.after(()=>h.pg.close());const writes=h.fixture.writes.length;
 mutate=()=>h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1 AND actor_id=$2',[h.who.tenantId,h.who.id]);await h.reporting.start(h.who,input());await h.reporting.drain({limit:1});
 assert.equal((await h.db.query('SELECT * FROM gh_reporting_evidence')).length,0);assert.equal((await h.db.query<{state:string}>('SELECT state FROM gh_reporting_runs'))[0].state,'attention');assert.equal(h.fixture.writes.length,writes);
});
test('two workers share a page lease, expired attempts remain visible, and stale completion loses its fence',async t=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r});let calls=0;
 const reader:ReportingReader={read:async(_s,_e,n,g)=>{calls++;if(calls===1){entered();await gate;}return page(n,g);}};
 const h=await harness(reader);t.after(()=>h.pg.close());await h.reporting.start(h.who,input());const first=h.reporting.drain({limit:1});await started;
 assert.equal((await h.reporting.drain({limit:1})).processed,0);await h.db.query("UPDATE gh_reporting_windows SET lease_until=now()-interval '1 second'");await h.reporting.drain({limit:1});release();await first;
 const run=(await h.reporting.overview(h.who)).runs[0];assert.equal(run.state,'complete');assert.equal(run.pages,1);assert.equal(run.observedResources,1);assert.equal(calls,2);
 const rows=await h.db.query<{state:string}>('SELECT state FROM gh_reporting_pages ORDER BY started_at');assert.deepEqual(rows.map(r=>r.state),['interrupted','complete']);
});
test('changed owned-resource grants and connector bindings stop reads before transport',async t=>{
 let calls=0;const h=await harness({read:async(_s,_e,n,g)=>{calls++;return page(n,g);}});t.after(()=>h.pg.close());await h.reporting.start(h.who,input());await h.db.query("UPDATE gh_provider_resources SET version=version+1 WHERE tenant_id=$1 AND kind='capture'",[h.who.tenantId]);await h.reporting.drain({limit:1});
 assert.equal(calls,0);assert.equal((await h.reporting.overview(h.who)).runs[0].state,'attention');
 await assert.rejects(new ReportingService(h.db,{...h.connector,tenantId:'foreign'},h.reporting.reader).start(h.who,input()),/workspace/);
});

test('a truncated final page cannot claim complete coverage and earlier pages stay inspectable',async t=>{
 const h=await harness({read:async(_s,_e,n,g)=>({...page(n,g,2),totalItems:3})});t.after(()=>h.pg.close());const run=await h.reporting.start(h.who,input());await h.reporting.drain({limit:1});await h.due();await h.reporting.drain({limit:1});
 const view=(await h.reporting.overview(h.who)).runs[0];assert.equal(view.state,'attention');assert.equal(view.pages,1);assert.match(view.reason!,/row count/);
 const evidence=await h.reporting.evidence(h.who,run.id,1);assert.equal(evidence.total,1);assert.equal(evidence.rows[0].amountMinor,4200);assert.equal(evidence.rows[0].evidenceHash.length,64);
 await assert.rejects(h.reporting.evidence({...h.who,tenantId:'foreign'},run.id,1),/membership/);await assert.rejects(h.reporting.evidence(h.who,randomUUID(),1),/no such scan/);
});
test('daily boundary overlap deduplicates evidence without mixing each window’s page counts',async t=>{
 const spans:string[]=[];const h=await harness({read:async(s,_e,n,g)=>{spans.push(s);return page(n,g);}});t.after(()=>h.pg.close());await h.reporting.start(h.who,{...input(),end:'2026-11-03T00:00:00.000Z'});await h.reporting.drain({limit:2});
 const view=(await h.reporting.overview(h.who)).runs[0];assert.equal(view.state,'complete');assert.equal(view.completedWindows,2);assert.equal(view.pages,2);assert.equal(view.observedResources,1);assert.deepEqual(spans,[start,end]);
});
test('cancellation during an outstanding read discards the late page and closes its lease',async t=>{
 let stop!:()=>Promise<unknown>;const h=await harness({read:async(_s,_e,n,g)=>{await stop();return page(n,g);}});t.after(()=>h.pg.close());const run=await h.reporting.start(h.who,input());stop=()=>h.reporting.cancel(h.who,run.id);await h.reporting.drain({limit:1});
 assert.equal((await h.reporting.overview(h.who)).runs[0].state,'cancelled');assert.equal((await h.reporting.evidence(h.who,run.id,1)).total,0);
 const w=(await h.db.query<{state:string;lease_id:string|null}>('SELECT state,lease_id FROM gh_reporting_windows'))[0];assert.equal(w.state,'cancelled');assert.equal(w.lease_id,null);assert.equal((await h.db.query<{state:string}>('SELECT state FROM gh_reporting_pages'))[0].state,'discarded');
});
