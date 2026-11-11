import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportHarness} from './helpers/reports';
import {routeHarness,commandId,failure} from './helpers/workspaces';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import * as routes from '../app/api/reports/[[...path]]/route';
import {randomBytes} from 'node:crypto';
const params=(...path:string[])=>({params:Promise.resolve({path})});
const privateKeys=(t:import('node:test').TestContext,key:string)=>{
  const previous=[process.env.GLASSHOUSE_REPORT_KEY,process.env.GLASSHOUSE_AGENT_KEY];process.env.GLASSHOUSE_REPORT_KEY=key;process.env.GLASSHOUSE_AGENT_KEY=key;
  t.after(()=>{for(const [index,name] of ['GLASSHOUSE_REPORT_KEY','GLASSHOUSE_AGENT_KEY'].entries())if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];});
};

test('private report HTTP routes deny anonymous, foreign-origin and foreign-workspace requests and return exact private JSON',async t=>{
  const h=await reportHarness(t),request=routeHarness(t,{...h,service:h.workspaceService});privateKeys(t,h.key);
  const anonymous=await routes.GET(new Request('http://localhost:4525/api/reports'),params());assert.equal(anonymous.status,401);
  const rejected=await routes.POST(request('reports',{body:h.input(),origin:'https://foreign.invalid'}),params());assert.equal(rejected.status,403);assert.equal((await h.db.query('SELECT * FROM gh_report_editions')).length,0);
  const created=await routes.POST(request('reports',{body:h.input()}),params());assert.equal(created.status,200);const report=await created.json();
  assert.equal(created.headers.get('cache-control'),'private, no-store');assert.equal(created.headers.has('set-cookie'),false);
  const json=await routes.GET(request('reports/'+report.summary.id+'/json'),params(report.summary.id,'json'));
  assert.equal(json.status,200);assert.match(json.headers.get('content-disposition')??'',/^attachment;/);assert.equal(json.headers.get('x-glasshouse-document-hash'),report.summary.documentHash);assert.deepEqual(await json.json(),report);
  const wrong=await routes.GET(request('reports/foreign-report'),params('foreign-report'));assert.equal(wrong.status,404);
  const foreignParent=await routes.POST(request('reports',{body:h.input({parentId:'foreign-report'})}),params());assert.equal(foreignParent.status,404);
  const invalidPaper=await routes.GET(request('reports/'+report.summary.id+'/pdf?paper=A3'),params(report.summary.id,'pdf'));assert.equal(invalidPaper.status,400);
  assert.equal((await h.db.query('SELECT * FROM gh_report_editions')).length,1);assert.equal((await h.db.query('SELECT * FROM gh_payment_commands')).length,0);
});

test('final HTTP disclosure revalidation prevents a response that raced membership revocation',async t=>{
  const h=await reportHarness(t),request=routeHarness(t,{...h,service:h.workspaceService});privateKeys(t,h.key);
  const report=await h.service.create(h.scoped,h.input()),original=ReportService.prototype.read;
  t.mock.method(ReportService.prototype,'read',async function(this:ReportService,...args:Parameters<ReportService['read']>){const result=await original.apply(this,args);await h.db.query('UPDATE gh_memberships SET active=false,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[h.saved.tenantId,h.saved.id]);return result;});
  const result=await routes.GET(request('reports/'+report.summary.id),params(report.summary.id));assert.equal(result.status,403);assert.equal((await result.json()).code,'CURRENT_AUTHORITY_REQUIRED');
  assert.equal((await h.db.query('SELECT * FROM gh_report_editions')).length,1);
});

test('wrong private keys and a corrupted PDF cannot be disclosed as verified evidence',async t=>{
  const h=await reportHarness(t),report=await h.service.create(h.scoped,h.input());
  const wrong=new ReportService(h.db,new ReportSecrets(randomBytes(32).toString('base64')),new AgentSecrets(h.key));
  await assert.rejects(wrong.read(h.scoped,report.summary.id),failure('REPORT_UNVERIFIED'));
  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:'synthetic-corruption-test',render:async()=>({bytes:Buffer.from('%PDF-1.7\nSynthetic fixture\n%%EOF'),pages:1})});
  await service.pdf(h.scoped,report.summary.id,'A4');
  await h.db.query("UPDATE gh_report_pdf SET byte_hash=$1 WHERE report_id=$2",['0'.repeat(64),report.summary.id]);
  await assert.rejects(service.pdf(h.scoped,report.summary.id,'A4'),failure('REPORT_PDF_UNVERIFIED'));assert.deepEqual(await service.read(h.scoped,report.summary.id),report);
});

test('revoking a provider grant during render preserves the cached result but holds disclosure',async t=>{
  const h=await reportHarness(t),owned=await h.boundCapture(),report=await h.service.create(h.scoped,h.input({snapshotHash:owned.snapshot.hash}));let renders=0;
  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:'synthetic-resource-revoke',render:async()=>{renders++;await h.db.query("UPDATE gh_provider_resources SET active=false WHERE kind='capture' AND provider_id=$1",[owned.captureId]);return {bytes:Buffer.from('%PDF-1.7\nSynthetic fixture\n%%EOF'),pages:1};}});
  await assert.rejects(service.pdf(h.scoped,report.summary.id,'A4'),failure('REPORT_RESOURCE_ACCESS_CHANGED'));
  assert.equal((await h.db.query<{state:string}>('SELECT state FROM gh_report_pdf'))[0].state,'ready');assert.equal(renders,1);
  await assert.rejects(service.pdf(h.scoped,report.summary.id,'A4'),failure('REPORT_RESOURCE_ACCESS_CHANGED'));assert.equal(renders,1);
});

test('report list pagination is scoped, stable and reads authenticated summaries without full editions',async t=>{
  const h=await reportHarness(t),first=await h.service.create(h.scoped,h.input()),queries:string[]=[];
  const spy={...h.db,query:async<T extends Record<string,unknown>>(sql:string,values?:unknown[])=>{queries.push(sql);return h.db.query<T>(sql,values);},transaction:async<T,>(work:(tx:import('../packages/db/client').Database)=>Promise<T>)=>h.db.transaction(tx=>work({...tx,query:async<R extends Record<string,unknown>>(sql:string,values?:unknown[])=>{queries.push(sql);return tx.query<R>(sql,values);}}))};
  const service=new ReportService(spy,new ReportSecrets(h.key),new AgentSecrets(h.key)),list=await service.list(h.scoped);assert.deepEqual(list.reports,[first.summary]);assert.equal(list.hasMore,false);
  assert(queries.some(sql=>sql.startsWith('SELECT tenant_id,id,document_hash,private_summary')));assert(!queries.some(sql=>sql.includes('SELECT * FROM gh_report_editions')));
  assert.deepEqual((await service.list(h.scoped,first.summary.id)).reports,[]);await assert.rejects(service.list(h.scoped,'foreign-cursor'),failure('REPORT_NOT_FOUND'));
});
