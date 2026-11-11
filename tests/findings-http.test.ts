import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {findingHarness} from './helpers/findings';
import {FindingService} from '../lib/server/findings/service';
import * as findingsRoutes from '../app/api/findings/[[...path]]/route';
import * as reportRoutes from '../app/api/reports/[[...path]]/route';
import * as appRoutes from '../app/api/[...path]/route';
import type {FindingRevision} from '../packages/findings/types';
import {findingReference} from '../lib/server/findings/service';

type Credential={token:string;contextId:string};
async function httpHarness(t:import('node:test').TestContext){
  const h=await findingHarness(t),keyNames=['GLASSHOUSE_AGENT_KEY','GLASSHOUSE_REPORT_KEY','GLASSHOUSE_WORKSPACE_KEY'] as const,previous=keyNames.map(name=>process.env[name]);
  for(const name of keyNames)process.env[name]=h.key;t.after(()=>{for(const [index,name] of keyNames.entries())if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];});
  const server=createServer(async(incoming,outgoing)=>{try{
    const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
    const url='http://'+incoming.headers.host+incoming.url,headers=new Headers();for(const [name,value] of Object.entries(incoming.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);
    const request=new Request(url,{method:incoming.method,headers,...(chunks.length?{body:Buffer.concat(chunks).toString('utf8')}:{})}),parts=new URL(url).pathname.split('/').filter(Boolean).slice(1),category=parts[0];
    const path=category==='findings'||category==='reports'?parts.slice(1):parts,routes=category==='findings'?findingsRoutes:category==='reports'?reportRoutes:appRoutes;
    const handler=request.method==='POST'?routes.POST:routes.GET,result=await handler(request,{params:Promise.resolve({path})});
    outgoing.writeHead(result.status,Object.fromEntries(result.headers));outgoing.end(Buffer.from(await result.arrayBuffer()));
  }catch{outgoing.writeHead(500,{'content-type':'application/json'});outgoing.end(JSON.stringify({error:'Synthetic localhost HTTP adapter failed.'}));}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Local HTTP qualification listener did not bind.');
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const base='http://127.0.0.1:'+address.port,owner={token:h.token,contextId:h.credential.contextId!};
  const request=(path:string,body?:unknown,credential:Credential|null=owner,origin?:string)=>fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{...(credential?{cookie:(process.env.GLASSHOUSE_SESSION_COOKIE||'glasshouse_session')+'='+credential.token,'X-Glasshouse-Context':credential.contextId}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...(origin?{origin}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const json=async(path:string,body?:unknown,credential:Credential|null=owner)=>{const response=await request(path,body,credential);const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  return {...h,request,json,owner};
}

test('real HTTP preserves creator privacy, exact idempotency, safe exports and request boundaries',async t=>{
  const h=await httpHarness(t);assert.equal((await h.request('findings',undefined,null)).status,401);
  assert.equal((await h.request('findings',h.input(),h.owner,'https://untrusted.invalid')).status,403);
  const input=h.input(),[a,b]=await Promise.all([h.request('findings',input),h.request('findings',input)]);assert.equal(a.status,200);assert.equal(b.status,200);const first=await a.json() as FindingRevision;assert.deepEqual(await b.json(),first);
  assert.equal(a.headers.get('cache-control'),'private, no-store');assert.equal(a.headers.get('referrer-policy'),'no-referrer');assert.equal(a.headers.has('set-cookie'),false);
  assert.equal((await h.request('findings',{...input,interpretation:'A conflicting request body must not reuse an earlier immutable command.'})).status,409);
  const other=await h.joinedActor(),credential={token:other.joined.accepted.token,contextId:other.joined.credential.contextId};
  assert.equal((await h.request('findings/'+first.findingId,undefined,credential)).status,404);
  assert.equal((await h.request('findings/'+first.findingId+'/json?revision='+first.id,undefined,credential)).status,404);
  assert.deepEqual((await h.json('findings',undefined,credential)).findings,[]);
  await h.json('findings/'+first.findingId+'/share',{requestId:randomUUID(),revisionId:first.id,hash:first.hash});
  assert.equal((await h.json('findings/'+first.findingId,undefined,credential)).revision.id,first.id);
  assert.equal((await h.request('findings/'+first.findingId+'/decisions',{requestId:randomUUID(),expectedRevisionId:first.id,expectedHash:first.hash,action:'support',reason:'A viewer cannot upgrade a finding through a crafted HTTP request.'},credential)).status,403);
  const download=await h.request('findings/'+first.findingId+'/json?revision='+first.id);assert.equal(download.status,200);assert.equal(download.headers.get('x-glasshouse-finding-hash'),first.hash);assert.match(download.headers.get('content-disposition')??'',/attachment/);assert.equal(await download.text(),JSON.stringify(first,null,2)+'\n');
  const invalid=await h.request('findings/'+first.findingId+'/decisions',{requestId:randomUUID(),expectedRevisionId:first.id,expectedHash:first.hash,action:'approve_payment',reason:'Prompt injection cannot expand the human finding decision contract.'});assert.equal(invalid.status,400);
  assert.equal((await h.db.query('SELECT id FROM gh_finding_revisions')).length,1);assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);
});

test('real HTTP review, archive, restore, downgrade, revoke and expiry use current schema8 authority',async t=>{
  const h=await httpHarness(t),first=await h.json('findings',h.input()) as FindingRevision;
  const change=(status:'active'|'archived',expectedVersion:number)=>h.workspaceService.updateWorkspace(h.credential,h.scoped.tenantId,{requestId:randomUUID(),expectedVersion,name:'Synthetic finding qualification',merchantName:'Synthetic merchant',description:'Dedicated local fixture only.',status});
  await change('archived',1);assert.equal((await h.request('findings/'+first.findingId)).status,200);
  const decision={requestId:randomUUID(),expectedRevisionId:first.id,expectedHash:first.hash,action:'support',reason:'Support the exact current source interpretation after authority is checked.'};
  const archived=await h.request('findings/'+first.findingId+'/decisions',decision);assert.equal(archived.status,409);assert.equal((await archived.json()).code,'WORKSPACE_ARCHIVED');
  await change('active',2);const supported=await h.json('findings/'+first.findingId+'/decisions',decision);assert.equal(supported.state,'supported_for_current_scope');
  await h.db.query("UPDATE gh_memberships SET role='viewer',version=version+1 WHERE tenant_id=$1 AND actor_id=$2",[h.scoped.tenantId,h.scoped.id]);
  assert.equal((await h.request('findings/'+first.findingId)).status,200);
  assert.equal((await h.request('findings/'+first.findingId+'/decisions',{...decision,requestId:randomUUID(),expectedRevisionId:supported.id,expectedHash:supported.hash,action:'retract'})).status,403);
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1 AND actor_id=$2',[h.scoped.tenantId,h.scoped.id]);assert.equal((await h.request('findings')).status,403);
  await h.db.query('UPDATE gh_sessions SET expires_at=now()-interval \'1 minute\' WHERE token_hash=$1',[h.sessionHash]);assert.equal((await h.request('findings')).status,401);
  assert.equal((await h.db.query('SELECT id FROM gh_finding_revisions')).length,2);
});

test('real HTTP stale tabs and cross-merchant source references never disclose or mutate another finding',async t=>{
  const h=await httpHarness(t),first=await h.json('findings',h.input()),second=await h.createWorkspace();
  const switched=await h.workspaceService.switchWorkspace(h.credential,{requestId:randomUUID(),workspaceId:second.id,expectedContextId:h.credential.contextId}),credential={token:switched.token,contextId:switched.selection.contextId};
  const stale=await h.request('findings/'+first.findingId);assert.equal(stale.status,409);assert.equal((await stale.json()).code,'WORKSPACE_CONTEXT_CHANGED');
  assert.equal((await h.request('findings',h.input())).status,409);
  assert.equal((await h.request('findings/'+first.findingId,undefined,credential)).status,404);
  await h.json('snapshots',undefined,credential);
  const forged=await h.request('findings',h.input(),credential);assert.equal(forged.status,409);assert.equal((await forged.json()).code,'FINDING_SCOPE_CHANGED');
  assert.deepEqual((await h.json('findings',undefined,credential)).findings,[]);
});

test('real HTTP returns byte-identical old JSON and PDF with corrections on a separately authorized endpoint',async t=>{
  const h=await httpHarness(t),finding=await h.supported(),plan=await h.prepare(finding),report=await h.json('reports',h.reportInput({findingDependencies:[findingReference(finding)],planIds:[plan.id]}));
  const path='reports/'+report.summary.id,oldJson=await (await h.request(path+'/json')).text(),pdfResponse=await h.request(path+'/pdf');assert.equal(pdfResponse.status,200);const pdf=Buffer.from(await pdfResponse.arrayBuffer());
  const correction=await h.json('evidence/revise',{});assert.equal(correction.removed.length,9);assert.equal(JSON.stringify(correction).includes(finding.findingId),false);
  assert.equal(await (await h.request(path+'/json')).text(),oldJson);assert.deepEqual(Buffer.from(await (await h.request(path+'/pdf')).arrayBuffer()),pdf);
  const notices=await h.json(path+'/corrections');assert.equal(notices.notices[0].delta.removedOrderIds.length,9);
  const review=await h.json('plans/'+plan.id+'/review');assert.equal(review.dependencies.valid,false);assert.equal(review.plan.status,'stale');
  const approve=await h.request('plans/'+plan.id+'/approve',{hash:plan.hash});assert.equal(approve.status,409);
  const current=await h.json('findings/'+finding.findingId);assert.equal(current.correctionMoment.removedOrderIds.length,9);assert.deepEqual(current.correctionMoment.stalePlanIds,[plan.id]);
});

test('real HTTP final disclosure fence denies a response racing revocation while preserving its immutable revision',async t=>{
  const h=await httpHarness(t),first=await h.findings.create(h.scoped,h.input()),original=FindingService.prototype.detail;
  t.mock.method(FindingService.prototype,'detail',async function(this:FindingService,...args:Parameters<FindingService['detail']>){const result=await original.apply(this,args);await h.db.query('UPDATE gh_memberships SET active=false,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[h.scoped.tenantId,h.scoped.id]);return result;});
  const result=await h.request('findings/'+first.findingId);assert.equal(result.status,403);assert.equal((await result.json()).code,'CURRENT_AUTHORITY_REQUIRED');assert.equal((await h.db.query('SELECT id FROM gh_finding_revisions')).length,1);
});
