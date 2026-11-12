import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {AgAiToolContext,AgAiToolInvocation,AgDataSourcesDefinition} from 'ag-studio';
import {nativeStudio} from './helpers/studio-native';
import {executeIsolatedQuery} from '../packages/agents/isolated-query';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'));
const ordering=read('agent-query-conflicting-order.json'),expression=read('agent-query-unaggregated-expression.json');
const context=(signal=new AbortController().signal):AgAiToolContext=>({signal,run:{threadId:'isolated-query-thread',runId:'isolated-query-run',agentId:'investigator'},success:(response,data)=>({success:true,response,data}),error:messages=>({success:false,issues:(Array.isArray(messages)?messages:[messages]).map(message=>({message}))})});
const invocation=(args:Record<string,unknown>,id='isolated-query-call'):AgAiToolInvocation=>({name:'execute_query',toolCallId:id,args});
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

test('the second retained actual-model query reports a fatal native error despite a success result',async t=>{
  const f=await nativeStudio(t),before=clone(f.api.getHistory());
  const result=await f.api.getAiTools().executeQuery().execute!(invocation(expression),context());
  await new Promise<void>(resolve=>setTimeout(resolve,0));
  assert.equal(result.success,true,'Retain the installed SDK false-success negative control.');
  assert.ok(f.errors.some(event=>event.fatal&&event.details.some(detail=>detail.includes('has no aggregation'))));
  assert.deepEqual(clone(f.api.getHistory()),before);
});

test('both retained malformed queries fail in isolated native engines and leave the interactive report usable',async t=>{
  const f=await nativeStudio(t),before=clone(f.api.getHistory()),data=f.api.getDataEngine()!.getDataSources();
  for(const [index,args] of [ordering,expression].entries()){
    const result=await executeIsolatedQuery(data as AgDataSourcesDefinition,invocation(clone(args),`bad-${index}`),context());
    assert.equal(result.success,false,JSON.stringify(result));
    assert.match(JSON.stringify(result),index===0?/conflicting orderBy/:/has no aggregation/);
    assert.deepEqual(clone(f.api.getHistory()),before);assert.deepEqual(f.errors,[]);
  }
  const valid=clone(expression);valid.query.measures=[{field:{id:'finding_snapshot.id',aggregation:'countd'},as:'records'}];delete valid.query.filter;
  const result=await executeIsolatedQuery(data as AgDataSourcesDefinition,invocation(valid),context());
  assert.equal(result.success,true,JSON.stringify(result));
  if(result.success)assert.ok((result.data as {result:{records:number}[]}).result[0].records>0);
  assert.deepEqual(clone(f.api.getHistory()),before);assert.deepEqual(f.errors,[]);
  const added=await f.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId:'after-isolated-query',type:'column-chart-grouped',xTrack:0,yTrack:200,xSpan:24,ySpan:20});
  assert.equal(added.success,true);f.api.undo();assert.equal(f.api.getState().pages[0].widgets?.['after-isolated-query'],undefined);assert.deepEqual(f.errors,[]);
});

test('independent concurrent native reads preserve rows and a cancelled read never initializes',async t=>{
  const f=await nativeStudio(t),data=f.api.getDataEngine()!.getDataSources() as AgDataSourcesDefinition,before=clone(data);
  const valid={query:{kind:'apiQuery',variant:'aggregation',measures:[{field:{id:'order_snapshot.id',aggregation:'countd'},as:'orders'}]}};
  const results=await Promise.all(Array.from({length:3},(_,index)=>executeIsolatedQuery(data,invocation(valid,`concurrent-${index}`),context())));
  assert.ok(results.every(result=>result.success),JSON.stringify(results));
  for(const result of results)if(result.success)assert.equal((result.data as {result:{orders:number}[]}).result[0].orders,600);
  const controller=new AbortController();controller.abort();
  assert.match(JSON.stringify(await executeIsolatedQuery(data,invocation(valid),context(controller.signal))),/cancelled before execution/);
  assert.deepEqual(clone(data),before);assert.deepEqual(f.errors,[]);
});
