import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {AgAiChatMessage,AgAiEvent,AgAiHarness,AgAiRunInput,AgAiTelemetryEvent,AgAiThread,AgAiTool,AgAiToolResult,AgAnyAiAgentRunContext,AgStudioApi} from 'ag-studio';
import type {GlasshouseRegistry,StudioBridge} from '../packages/studio/types';
import type {AgentHistoryBridge} from '../packages/agents/durable-client';
import {agentHarness,functionCall,message,nativeInput,tool} from './helpers/agents';
const {directLlmRunner}=await import('ag-studio');
const {DurableAgents,visibleReplayFilter,mergeNativeMessages}=await import('../packages/agents/durable-client');
type Harness=Awaited<ReturnType<typeof agentHarness>>;

/** The native AG loop is real. HTTP and Studio fixture seams are explicit; the
 * actual browser harness/session/renderer remains a separate root qualification. */
async function fixture(t:TestContext){
  const h=await agentHarness(),requests:{path:string;body:Record<string,unknown>}[]=[],pending=new Set<Promise<Response>>();
  const apiState={loseThreadSave:false};
  const dispatch=async(path:string,init?:RequestInit):Promise<Response>=>{
    assert.ok(path.startsWith('/api/agents/'),'No external network is permitted by this native-runner fixture.');
    const pathname=new URL(path,'http://isolated.test').pathname,pieces=pathname.slice('/api/agents/'.length).split('/').map(decodeURIComponent),key=pieces.join('/');
    const body=init?.body?JSON.parse(String(init.body)):{};requests.push({path:key,body});
    try{
      let value:unknown;
      if(key==='status')value={runs:await h.journal.status(h.who),events:await h.journal.events(h.who),documents:[],modelMode:'synthetic',toolkit:{installed:'1.11.0',enabled:false,mode:'unqualified'},encrypted:true};
      else if(key==='runs')value=await h.journal.enroll(h.who,body);
      else if(pieces[0]==='runs'&&pieces[2]==='finish')value=await h.journal.finish(h.who,pieces[1],body.clientId,body.action);
      else if(pieces[0]==='runs'&&pieces[2]==='heartbeat')value=await h.journal.heartbeat(h.who,pieces[1],body.clientId);
      else if(key==='turns')value=await h.models.submit(h.who,body);
      else if(pieces[0]==='turns'&&pieces[3]==='step')value=await h.models.step(h.who,pieces[1],Number(pieces[2]),body.clientId);
      else if(key==='tools/claim')value=await h.tools.claim(h.who,body);
      else if(key==='tools/acknowledge')value=await h.tools.acknowledge(h.who,body);
      else if(key==='threads')value=await h.threads.list(h.who);
      else if(pieces[0]==='threads'&&init?.method==='POST'){
        value=await h.threads.save(h.who,pieces[1],body);
        if(apiState.loseThreadSave){apiState.loseThreadSave=false;throw new Error('Synthetic response loss after exact encrypted thread CAS.');}
      }else if(pieces[0]==='threads')value=await h.threads.load(h.who,pieces[1]);
      else assert.fail(`Unexpected native fixture route ${key}`);
      return Response.json(value);
    }catch(error){
      if(error instanceof Error&&error.message.startsWith('Synthetic response loss'))throw error;
      const value=error as {status?:number;message?:string;code?:string};return Response.json({error:value.message??'Synthetic API failure',code:value.code},{status:value.status??500});
    }
  };
  t.mock.method(globalThis,'fetch',(input:string|URL|Request,init?:RequestInit)=>{
    const work=dispatch(input instanceof Request?input.url:String(input),init);pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
  });
  const errors:string[]=[],events:AgAiTelemetryEvent[]=[];
  const bridge:StudioBridge={getSnapshot:()=>h.snapshot,onTime(){},onOrder(){},onBranch(){},onRevision(){},onWidgetReady(){},onEvent(){},onApi(){},onHistory(){},onError:text=>{errors.push(text);}};
  const studio={getHistory(){throw new Error('This headless fixture has no native Studio workspace.');}} as unknown as AgStudioApi<GlasshouseRegistry>;
  const workspace:AgentHistoryBridge={async save(){throw new Error('This test has not installed a native mutation fixture.');},mutation(){}};
  const controller=new DurableAgents(studio,bridge,workspace);
  const ctx=(tools:AgAiTool[],extra:Partial<AgAnyAiAgentRunContext>={}):AgAnyAiAgentRunContext=>({params:undefined,instructions:()=> 'Untrusted native fixture instructions.',tools:()=>tools,signal:new AbortController().signal,emit:event=>{events.push(event);},...extra});
  const settle=async()=>{while(pending.size)await Promise.allSettled([...pending]);};
  t.after(async()=>{await settle();await h.dispose();});
  return {h,controller,ctx,errors,events,requests,settle,apiState,bridge,workspace,studio};
}
function nativeTool(name:string,execute:NonNullable<AgAiTool['execute']>,parameters:Record<string,unknown>={type:'object',properties:{},additionalProperties:false}):AgAiTool{return {name,description:`Native qualification ${name}`,kind:'client',schema:()=>tool(name,parameters),execute};}
async function collect(stream:AsyncIterable<AgAiEvent>){const events:AgAiEvent[]=[];for await(const event of stream)events.push(event);return events;}

test('actual native directLlmRunner uses the durable turn index and server tools, suppressing unissued preflight calls',async t=>{
  const f=await fixture(t),{h,controller}=f;let clientDomainCalls=0;
  const read=nativeTool('read_incident',async()=>{clientDomainCalls++;return {success:false,issues:[{message:'The server must own this tool.'}]};});
  const call=functionCall('read_incident',{}),answer=message('The deterministic source reports 600 orders.');h.fixture.outputs.push([call],[answer]);
  const native=directLlmRunner({id:'coordinator',adapter:controller.adapter,maxTurns:5}),runner=controller.wrap(native),input=nativeInput('Read this incident.');
  const stream=await collect(runner.run(input,f.ctx([read],{defaultToolCalls:()=>[{tool:'read_incident'}]})));await f.settle();
  assert.equal(clientDomainCalls,0);assert.equal(h.fixture.creates.length,2);assert.deepEqual(f.events.filter(event=>event.type==='turn_started').map(event=>event.trace.turnIndex),[0,1]);
  assert.equal(stream.filter(event=>event.type==='RUN_STARTED').length,1);assert.equal(stream.filter(event=>event.type==='RUN_FINISHED').length,1);assert.equal(stream.some(event=>event.type==='RUN_ERROR'),false);
  assert.equal(stream.filter(event=>event.type==='TOOL_CALL_RESULT').length,1);assert.equal(JSON.stringify(h.fixture.creates[1]).includes('2760000'),true);
  assert.equal((await h.journal.status(h.who))[0].state,'completed');assert.deepEqual(f.errors,[]);
  // Re-entry uses the same native user message and immutable recorded turns.
  await collect(runner.run(input,f.ctx([read])));await f.settle();assert.equal(h.fixture.creates.length,2);assert.equal(clientDomainCalls,0);
  assert.deepEqual((await h.db.query<{turn_index:number;dispatch_count:number}>('SELECT turn_index,dispatch_count FROM gh_agent_model_turns ORDER BY turn_index')).map(row=>[row.turn_index,row.dispatch_count]),[[0,1],[1,1]]);
});

test('actual native child loop forces complete_task and binds the handoff to that exact recorded summary',async t=>{
  const f=await fixture(t),{h,controller}=f,rootInput=nativeInput('Investigate source evidence.');
  const task='Read source evidence and return a bounded finding.',summary='Read the recorded source evidence. The cause remains a hypothesis.';
  const delegate=functionCall('delegate_to',{type:{id:'investigator'},instructions:task}),read=functionCall('read_evidence',{}),complete=functionCall('complete_task',{summary,artifacts:[]});
  h.fixture.outputs.push([delegate],[read],[message('Source observations are ready.')],[complete],[message('The investigator returned the recorded finding.')]);
  const childRunner=controller.wrap(directLlmRunner({id:'investigator',adapter:controller.adapter,maxTurns:6}));
  const terminal=nativeTool('complete_task',async(call,ctx)=>ctx.success(String(call.args.summary),{summary:call.args.summary,artifacts:call.args.artifacts}),{type:'object',properties:{summary:{type:'string'},artifacts:{type:'array',items:{type:'object'}}},required:['summary','artifacts'],additionalProperties:false});
  const childEvents:AgAiEvent[]=[];
  const nativeDelegate=nativeTool('delegate_to',async(call,ctx)=>{
    const input=nativeInput(String(call.args.instructions),{threadId:`${call.toolCallId}-sub`,parentRunId:ctx.run.runId,parentToolCallId:call.toolCallId});
    childEvents.push(...await collect(childRunner.run(input,f.ctx([nativeTool('read_evidence',async()=>assert.fail('Read evidence must run on the server.'))],{completeTask:terminal}))));
    return ctx.success(summary);
  },{type:'object',properties:{type:{type:'object',properties:{id:{type:'string',enum:['investigator']}},required:['id'],additionalProperties:false},instructions:{type:'string'}},required:['type','instructions'],additionalProperties:false});
  const rootRunner=controller.wrap(directLlmRunner({id:'coordinator',adapter:controller.adapter,maxTurns:4}));
  const events=await collect(rootRunner.run(rootInput,f.ctx([nativeDelegate])));await f.settle();
  assert.equal(events.some(event=>event.type==='RUN_ERROR'),false);assert.equal(childEvents.some(event=>event.type==='RUN_ERROR'),false);assert.equal(h.fixture.creates.length,5);
  assert.deepEqual(h.fixture.creates[3].tool_choice,{type:'function',name:'complete_task'});
  const runs=await h.journal.status(h.who),child=runs.find(run=>run.agentId==='investigator')!;assert.equal(child.threadId,`${delegate.call_id}-sub`);assert.equal(child.parentRunId,rootInput.runId);assert.equal(child.parentToolCallId,delegate.call_id);assert.ok(runs.every(run=>run.state==='completed'));
  assert.ok(f.events.some(event=>event.type==='run_started'&&event.trace.parentRunId===rootInput.runId&&event.trace.parentToolCallId===delegate.call_id));
  const receipt=(await h.db.query<import('../lib/server/agents/journal').ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE id=$1',[delegate.call_id]))[0];assert.deepEqual(h.journal.toolDocument(receipt).result,{success:true,response:summary});
  assert.equal(JSON.stringify(h.fixture.creates[4]).includes(summary),true);assert.deepEqual(f.errors,[]);
});

test('unknown provider outcome remains held through an actual native runner re-entry',async t=>{
  const f=await fixture(t),{h,controller}=f;h.fixture.unknown=true;
  const runner=controller.wrap(directLlmRunner({id:'coordinator',adapter:controller.adapter,maxTurns:3})),input=nativeInput('A question with an unknown provider outcome.');
  const one=await collect(runner.run(input,f.ctx([])));await f.settle();const two=await collect(runner.run(input,f.ctx([])));await f.settle();
  assert.ok(one.some(event=>event.type==='RUN_ERROR'));assert.ok(two.some(event=>event.type==='RUN_ERROR'));assert.equal(h.fixture.creates.length,1);assert.equal(h.fixture.gets.length,0);
  const [run]=await h.journal.status(h.who);assert.equal(run.state,'held');assert.equal(run.modelTurns[0].state,'unknown');assert.equal(run.modelTurns[0].dispatchCount,1);
});

test('changing snapshot while the actual native tool runs holds the next turn without another model dispatch',async t=>{
  const f=await fixture(t),{h,controller}=f;const renamed=functionCall('rename_thread',{name:'A scoped investigation'});h.fixture.outputs.push([renamed]);
  const rename=nativeTool('rename_thread',async(_call,ctx)=>{f.bridge.getSnapshot=()=>({...h.snapshot,hash:'f'.repeat(64)});return ctx.success('Renamed locally.');},{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false});
  const runner=controller.wrap(directLlmRunner({id:'coordinator',adapter:controller.adapter,maxTurns:3}));
  const events=await collect(runner.run(nativeInput('Rename this investigation.'),f.ctx([rename])));await f.settle();assert.equal(h.fixture.creates.length,1);assert.ok(events.some(event=>event.type==='RUN_ERROR'));
  const [run]=await h.journal.status(h.who);assert.equal(run.state,'held');assert.equal(run.tools[0].state,'unknown');
});

test('native history reconciles an exact lost CAS before saving later observed messages',async t=>{
  const f=await fixture(t),{controller,h}=f;
  const first:AgAiThread={summary:{threadId:'native-history-fixture',agentId:'coordinator',title:'Saved native conversation',updatedAt:1},messages:[{id:'observed-native-user',role:'user',parts:[{type:'text',text:'Observed first native message.'}],createdAt:1}]};
  f.apiState.loseThreadSave=true;await controller.history.saveThread(first);assert.equal(f.errors.length,1);
  const second={...first,summary:{...first.summary,updatedAt:2},messages:[{id:'observed-native-response',role:'assistant' as const,parts:[{type:'text' as const,text:'Observed later native response.'}],createdAt:2}]};
  await controller.history.saveThread(second);await f.settle();
  const saved=await h.threads.load(h.who,first.summary.threadId);assert.equal(saved.version,2);assert.deepEqual(saved.thread?.messages,[...first.messages,...second.messages]);
  const writes=f.requests.filter(request=>request.path==='threads/native-history-fixture'&&request.body.thread);assert.equal(writes.length,3);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(writes[2].body.expectedVersion,1);
});

test('two native history adapters cannot silently overwrite a newer saved transcript',async t=>{
  const f=await fixture(t),{controller,h}=f;
  const old:AgAiThread={summary:{threadId:'two-tab-native-history',agentId:'coordinator',title:'Original',updatedAt:1},messages:[{id:'actual-user-id',role:'user',parts:[{type:'text',text:'Original native message.'}],createdAt:1}]};
  await controller.history.saveThread(old);
  const otherErrors:string[]=[],other=new DurableAgents(f.studio,{...f.bridge,onError:text=>otherErrors.push(text)},f.workspace);await other.history.loadThread(old.summary.threadId);
  await controller.history.saveThread({...old,summary:{...old.summary,title:'Newer first tab',updatedAt:2}});
  await other.history.saveThread({...old,summary:{...old.summary,title:'Stale second tab',updatedAt:2}});await f.settle();assert.equal(otherErrors.length,1);assert.match(otherErrors[0],/newer native transcript/i);assert.equal((await h.threads.load(h.who,old.summary.threadId)).thread?.summary.title,'Newer first tab');
});

test('replay filtering preserves actual native identities, unfinished tool results and hidden-reasoning exclusion',()=>{
  const messages:AgAiChatMessage[]=[{id:'provider-message',role:'assistant',createdAt:1,parts:[{type:'text',text:'Already shown.'}]},{id:'native-tool-message',role:'assistant',createdAt:2,parts:[{type:'tool_call',toolCall:{toolCallId:'call-observed',name:'read_incident',args:{},status:'executing'}}]}];
  const visible=visibleReplayFilter(messages);
  assert.equal(visible({type:'TEXT_MESSAGE_START',messageId:'provider-message',role:'assistant'}),false);assert.equal(visible({type:'TOOL_CALL_START',toolCallId:'call-observed',toolCallName:'read_incident'}),false);
  assert.equal(visible({type:'TOOL_CALL_RESULT',messageId:'call-observed-result',toolCallId:'call-observed',content:'{"success":true}'}),true);
  assert.equal(visible({type:'REASONING_MESSAGE_START',messageId:'private-continuation'}),false);assert.equal(visible({type:'TEXT_MESSAGE_CONTENT',messageId:'new-provider-message',delta:'Newly observed.'}),true);
  const current=[{...messages[1],parts:[{type:'text' as const,text:'An actually observed replacement part.'}]},{id:'new-native-user',role:'user' as const,createdAt:3,parts:[{type:'text' as const,text:'Continue saved work.'}]}];
  assert.deepEqual(mergeNativeMessages(messages,current).map(item=>item.id),['provider-message','native-tool-message','new-native-user']);assert.equal(mergeNativeMessages(messages,current)[1],current[0]);
});
