import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AgAiChatMessage,AgAiEvent,AgAiHistoryStore,AgAiRunInput,AgAiThread,AgAiTool,AgAiToolContext} from 'ag-studio';
import {observeNativeThread,type NativeThreadView} from '../packages/agents/native-thread-observer';
import {nativeStudio} from './helpers/studio-native';

function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function until(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('The native observer did not receive the expected session change.');}
function context(threadId:string):AgAiToolContext{return {signal:new AbortController().signal,run:{threadId,runId:'observer-parent-run',agentId:'coordinator'},success:(response,data)=>({success:true,response,data}),error:message=>({success:false,issues:[{message:String(message)}]})};}
function texts(view:NativeThreadView|undefined){return view?.messages.flatMap(message=>message.parts.flatMap(part=>part.type==='text'?[part.text]:[]))??[];}
function* nativeText(id:string,text:string):Generator<AgAiEvent>{yield {type:'TEXT_MESSAGE_START',messageId:id,role:'assistant'};yield {type:'TEXT_MESSAGE_CONTENT',messageId:id,delta:text};yield {type:'TEXT_MESSAGE_END',messageId:id};}

test('an open transcript follows actual native delegate registration and same-thread session replacement',async t=>{
  const studio=await nativeStudio(t),releases=[deferred(),deferred()];let attempt=0,delegate:AgAiTool|undefined;
  const harness=studio.native.createAiHarness(studio.api as never,({tools})=>{
    delegate=tools.delegateTo(['investigator']);return {primary:'coordinator',agents:[
      {id:'coordinator',async *run(){}},
      {id:'investigator',async *run(input:AgAiRunInput):AsyncGenerator<AgAiEvent>{const index=attempt++;yield {type:'RUN_STARTED',threadId:input.threadId,runId:input.runId};yield* nativeText(`first-${index}`,`Native child ${index} started.`);await releases[index].promise;yield* nativeText(`last-${index}`,`Native child ${index} continued.`);yield {type:'RUN_FINISHED',threadId:input.threadId,runId:input.runId};}},
    ]};
  });t.after(()=>harness.dispose?.());
  const root=await harness.createThread({agentId:'coordinator'}),views:NativeThreadView[]=[];
  const stop=observeNativeThread(harness,'observer-call-sub',view=>views.push(view));t.after(stop);
  assert.equal(views.at(-1)?.state,'waiting');
  const invoke=()=>delegate!.execute!({toolCallId:'observer-call',name:'delegate_to',args:{type:{id:'investigator'},instructions:'Controlled native observer fixture.'}},context(root.threadId));
  const first=invoke();await until(()=>texts(views.at(-1)).includes('Native child 0 started.'));
  const original=views.at(-1)!.session;assert.ok(original);releases[0].resolve();await first;
  assert.ok(texts(views.at(-1)).includes('Native child 0 continued.'));
  const second=invoke();await until(()=>texts(views.at(-1)).includes('Native child 1 started.'));
  assert.notEqual(views.at(-1)?.session,original,'Native delegate re-entry creates a replacement session with the same thread id.');
  assert.equal(views.at(-1)?.session,harness.getSession?.('observer-call-sub'));
  const beforeStop=views.length;stop();releases[1].resolve();await second;
  assert.equal(views.length,beforeStop,'Unmount removes both harness and session observers.');
  assert.deepEqual(studio.errors,[]);
});

test('late saved-history hydration cannot replace an already registered live native delegate',async t=>{
  const studio=await nativeStudio(t),hydration=deferred<AgAiThread|undefined>(),release=deferred();let delegate:AgAiTool|undefined,loads=0;
  const child:AgAiThread={summary:{threadId:'hydration-call-sub',parentThreadId:'saved-root',agentId:'investigator',title:'Actual saved native fixture',updatedAt:1},messages:[{id:'old-native-message',role:'assistant',createdAt:1,parts:[{type:'text',text:'Earlier persisted native fixture.'}]}]};
  const history:AgAiHistoryStore={listThreads:async()=>[child.summary],loadThread:async()=>{loads++;return hydration.promise;},saveThread:async()=>{},deleteThread:async()=>{},addEventListener(){},removeEventListener(){}};
  const harness=studio.native.createAiHarness(studio.api as never,({tools})=>{
    delegate=tools.delegateTo(['investigator']);return {primary:'coordinator',history,agents:[{id:'coordinator',async *run(){}},{id:'investigator',async *run(input:AgAiRunInput):AsyncGenerator<AgAiEvent>{yield {type:'RUN_STARTED',threadId:input.threadId,runId:input.runId};yield* nativeText('live-native-message','Live native child.');await release.promise;yield* nativeText('live-native-later','Live native child continued.');yield {type:'RUN_FINISHED',threadId:input.threadId,runId:input.runId};}}]};
  });t.after(()=>harness.dispose?.());
  const root=await harness.createThread({agentId:'coordinator'});await until(()=>!!harness.getThread(child.summary.threadId));
  const views:NativeThreadView[]=[],stop=observeNativeThread(harness,child.summary.threadId,view=>views.push(view));t.after(stop);
  assert.equal(views.at(-1)?.state,'loading');assert.equal(loads,1);
  const running=delegate!.execute!({toolCallId:'hydration-call',name:'delegate_to',args:{type:{id:'investigator'},instructions:'Controlled native hydration race.'}},context(root.threadId));
  await until(()=>texts(views.at(-1)).includes('Live native child.'));
  const live=views.at(-1)?.session;hydration.resolve(child);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(views.at(-1)?.session,live);assert.equal(views.at(-1)?.session,harness.getSession?.(child.summary.threadId));
  assert.equal(texts(views.at(-1)).includes('Earlier persisted native fixture.'),false,'The observer reads the actual current session, without inventing a merge.');
  release.resolve();await running;assert.ok(texts(views.at(-1)).includes('Live native child continued.'));
  assert.deepEqual(studio.errors,[]);
});

test('a registered historical thread with failed loading reports unavailability without claiming missing history',async t=>{
  const studio=await nativeStudio(t),views:NativeThreadView[]=[];
  const summary={threadId:'unavailable-child',parentThreadId:'saved-root',agentId:'investigator',updatedAt:1};
  const history:AgAiHistoryStore={listThreads:async()=>[summary],loadThread:async()=>{throw new Error('Controlled history transport failure.');},saveThread:async()=>{},deleteThread:async()=>{},addEventListener(){},removeEventListener(){}};
  const harness=studio.native.createAiHarness(studio.api as never,()=>({primary:'coordinator',history,agents:[{id:'coordinator',async *run(){}},{id:'investigator',async *run(){}}]}));t.after(()=>harness.dispose?.());
  await harness.createThread({agentId:'coordinator'});await until(()=>!!harness.getThread(summary.threadId));
  const stop=observeNativeThread(harness,summary.threadId,view=>views.push(view));t.after(stop);
  await until(()=>views.at(-1)?.state==='unavailable');assert.deepEqual(views.at(-1)?.messages,[] as AgAiChatMessage[]);
});
