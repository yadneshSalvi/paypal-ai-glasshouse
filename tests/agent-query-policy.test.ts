import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {AgAiTool,AgAiToolContext,AgAiToolResult} from 'ag-studio';
import {nativeQueryRefusal} from '../lib/server/agents/query-policy';
import {nativeStudio} from './helpers/studio-native';
import {agentHarness,functionCall} from './helpers/agents';

// Exact model-issued query retained from the staged hosted Sample investigation.
// Its rows are fictional order references, not customer or provider identities.
const original=JSON.parse(readFileSync(new URL('./fixtures/agent-query-conflicting-order.json',import.meta.url),'utf8'));
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const context:AgAiToolContext={signal:new AbortController().signal,run:{threadId:'query-fixture-thread',runId:'query-fixture-run',agentId:'investigator'},success:(response,data)=>({success:true,response,data}),error:messages=>({success:false,issues:(Array.isArray(messages)?messages:[messages]).map(message=>({message}))})};
const execute=(tool:AgAiTool,args:Record<string,unknown>)=>tool.execute!({name:'execute_query',toolCallId:'native-query-fixture',args},context);
// This suite joins a real DOM/Studio engine to a real SQL journal. The model
// transport is explicitly controlled: the production SDK correctly refuses a
// browser-global environment, so no SDK/browser security option is weakened.
function controlledModelInDom(t:TestContext,h:Awaited<ReturnType<typeof agentHarness>>){
  t.mock.method(h.provider,'create',async(...[request,beforeSend,onKnownId]:Parameters<typeof h.provider.create>)=>{
    await beforeSend();
    const response=await h.fixture.fetch(new Request('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify(request),headers:{'content-type':'application/json'}}));
    const result=await response.json();await onKnownId?.(result.id,result.store??null);return result;
  });
}


test('retained live-model input reproduces the installed Studio fatal ordering validation',async t=>{
  const f=await nativeStudio(t),before=clone(f.api.getHistory());
  await execute(f.api.getAiTools().executeQuery(),original);
  assert.ok(f.errors.some(e=>e.fatal&&e.details.some(message=>message.includes('conflicting orderBy'))));
  assert.deepEqual(clone(f.api.getHistory()),before,'The original bad read must not be described as a report mutation.');
});

test('server refuses the exact bad query once before any native lease and preserves current authority and history',async t=>{
  const f=await nativeStudio(t),h=await agentHarness();t.after(h.dispose);controlledModelInDom(t,h);
  const parent=await h.begin(),child=await h.handoff(parent,'investigator');
  const query=f.api.getAiTools().executeQuery(),schema=query.schema()!;
  const bad=functionCall('execute_query',clone(original));
  const issued=await h.issue(child.run.id,[schema],[bad]);assert.equal(issued.state,'completed',JSON.stringify(issued));
  const claim={runId:child.run.id,callId:bad.call_id,name:bad.name,args:clone(original),clientId:h.clientId,snapshotHash:h.snapshot.hash};
  const before=clone(f.api.getHistory()),grants=await Promise.all(Array.from({length:6},()=>h.tools.claim(h.who,claim)));
  assert.ok(grants.every(grant=>grant.state==='completed'&&grant.result?.success===false));
  assert.ok(grants.every(grant=>JSON.stringify(grant)===JSON.stringify(grants[0])));
  assert.match(JSON.stringify(grants[0]),/Split these into separate queries/);
  const row=(await h.db.query<{dispatch_count:number;lease_token:string|null;private_document:string}>("SELECT dispatch_count,lease_token,private_document FROM gh_agent_tool_calls WHERE id=$1",[bad.call_id]))[0];
  assert.equal(row.dispatch_count,0);assert.equal(row.lease_token,null);
  assert.deepEqual(h.journal.toolDocument((await h.db.query<import('../lib/server/agents/journal').ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE id=$1',[bad.call_id]))[0]).args,original);
  assert.equal((await h.journal.events(h.who)).filter(e=>e.eventType==='tool_completed'&&e.toolName==='execute_query').length,1);
  assert.deepEqual(clone(f.api.getHistory()),before);assert.deepEqual(f.errors,[]);
  await assert.rejects(h.tools.claim(h.who,{...claim,args:{...clone(original),different:true}}),/exact model-issued/);
  await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1 AND actor_id=$2',[h.who.tenantId,h.who.id]);
  await assert.rejects(h.tools.claim(h.who,claim),/membership|authority|access/i);
});

test('separately ordered native queries remain executable after the refused input, without report or source changes',async t=>{
  const f=await nativeStudio(t),h=await agentHarness();t.after(h.dispose);controlledModelInDom(t,h);
  const parent=await h.begin(),child=await h.handoff(parent,'investigator'),native=f.api.getAiTools().executeQuery(),schema=native.schema()!;
  const before=clone(f.api.getHistory());
  assert.ok(nativeQueryRefusal(original));
  for(const field of ['occurredAt','ingestedAt']){
    const args=clone(original);args.query.measures=args.query.measures.filter((m:{field:{aggregation:string;id:string}})=>!['first','last'].includes(m.field.aggregation)||m.field.id.endsWith('.'+field));
    assert.equal(nativeQueryRefusal(args),null);
    const call=functionCall('execute_query',args);const issued=await h.issue(child.run.id,[schema],[call]);assert.equal(issued.state,'completed',JSON.stringify(issued));
    const grant=await h.tools.claim(h.who,{runId:child.run.id,callId:call.call_id,name:call.name,args,clientId:h.clientId,snapshotHash:h.snapshot.hash});
    assert.equal(grant.state,'execute');assert.ok(grant.leaseToken);
    const result=await execute(native,args) as AgAiToolResult;assert.equal(result.success,true,JSON.stringify(result));
    if(result.success)assert.ok((result.data as {result:unknown[]}).result.length>0);
    await h.tools.acknowledge(h.who,{runId:child.run.id,callId:call.call_id,clientId:h.clientId,leaseToken:grant.leaseToken!,result,snapshotHash:h.snapshot.hash});
  }
  assert.deepEqual(f.errors,[]);assert.deepEqual(clone(f.api.getHistory()),before);
  const added=await f.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId:'after-query-recovery',type:'column-chart-grouped',xTrack:0,yTrack:200,xSpan:24,ySpan:20});
  assert.equal(added.success,true);assert.equal(f.api.getHistory().undo.length,before.undo.length+1);f.api.undo();assert.equal(f.api.getState().pages[0].widgets?.['after-query-recovery'],undefined);assert.deepEqual(f.errors,[]);
});

test('query policy preserves valid common ordering, independent measures and nested query scopes',()=>{
  const before=JSON.stringify(original);assert.match(nativeQueryRefusal(original)??'',/earliest_occurrence.*earliest_ingestion/);assert.equal(JSON.stringify(original),before);
  const common=clone(original);for(const m of common.query.measures)if(m.orderBy)m.orderBy=clone(common.query.measures[2].orderBy);assert.equal(nativeQueryRefusal(common),null);
  const independent=clone(original);for(const m of independent.query.measures)if(m.orderBy)m.field.aggregation='min';assert.equal(nativeQueryRefusal(independent),null);
  const firstOnly=clone(original);firstOnly.query.measures=firstOnly.query.measures.slice(0,4);assert.equal(nativeQueryRefusal(firstOnly),null);
  const reverse=clone(firstOnly);reverse.query.measures[3].orderBy[0].direction='desc';assert.ok(nativeQueryRefusal(reverse));
  const reordered=clone(firstOnly);reordered.query.measures[3].orderBy=[{direction:'asc',field:{id:'finding_snapshot.occurredAt'}}];assert.equal(nativeQueryRefusal(reordered),null);
  assert.ok(nativeQueryRefusal({query:{kind:'apiQuery',variant:'projection',projection:[{expression:{query:clone(original.query)}}]}}));
  assert.equal(nativeQueryRefusal({query:{kind:'apiQuery',variant:'projection',projection:[]}}),null);
});
