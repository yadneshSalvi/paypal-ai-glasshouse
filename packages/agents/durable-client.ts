'use client';
import type {AgAiChatMessage,AgAiChatSession,AgAiEvent,AgAiHarness,AgAiHistoryStore,AgAiThread,AgAiTool,AgAnyAiAgentRunner,AgLlmAdapter,AgStudioApi} from 'ag-studio';
import {api} from '@/lib/client';
import type {AgentRunEvent} from '../domain/types';
import type {GlasshouseRegistry,StudioBridge} from '../studio/types';
import type {ReportHistory} from '../studio/history-saves';
import type {AgentId,AgentLayoutReceipt,EnrolledRun,RunView,ToolGrant,TurnView} from './contracts';
import {studioData} from '../studio/registry';
import {executeIsolatedQuery} from './isolated-query';

export interface DurableStatus {runs:RunView[];events:AgentRunEvent[];documents:unknown[];modelMode:'live'|'synthetic'|'unavailable';toolkit:{installed:string;enabled:boolean;mode:string};encrypted:boolean}
export interface AgentHistoryBridge {
  save(history:ReportHistory,label:string,receipt?:AgentLayoutReceipt):Promise<void>;
  mutation(active:boolean):void;
}
const mutationTools=new Set(['add_widget','position_widget','remove_widget','add_page_filter','remove_page_filter','configure_widget','add_widget_filter','remove_widget_filter']);
const controllers=new WeakMap<AgAiHarness,DurableAgents>();
export function durableAgents(harness:AgAiHarness|null){return harness?controllers.get(harness):undefined;}
function delay(ms:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{
  if(signal?.aborted){reject(signal.reason);return;}
  const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});
});}
export function visibleReplayFilter(messages:readonly AgAiChatMessage[]){
  const text=new Set(messages.filter(message=>message.parts.some(part=>part.type==='text')).map(message=>message.id));
  const calls=new Map(messages.flatMap(message=>message.parts.flatMap(part=>part.type==='tool_call'?[[part.toolCall.toolCallId,part.toolCall.result!==undefined] as const]:[])));
  return (event:AgAiEvent)=>{
    if(event.type.startsWith('REASONING_'))return false;
    if('messageId'in event&&event.messageId&&text.has(event.messageId))return false;
    if('toolCallId'in event&&event.toolCallId&&calls.has(event.toolCallId))return event.type==='TOOL_CALL_RESULT'&&!calls.get(event.toolCallId);
    return true;
  };
}
/** Merge only actual observed native messages by their stable native identities.
 * A child re-entry is a new native user message; it never fabricates past output. */
export function mergeNativeMessages(saved:readonly AgAiChatMessage[],current:readonly AgAiChatMessage[]){
  const updates=new Map(current.map(message=>[message.id,message]));
  const ids=new Set(saved.map(message=>message.id));
  return [...saved.map(message=>updates.get(message.id)??message),...current.filter(message=>!ids.has(message.id))];
}
export class DurableAgents {
  private harness:AgAiHarness|null=null;
  private clientId=crypto.randomUUID();
  private resumes=new Map<string,string>();
  private turns=new Map<string,number>();
  private active=new Map<string,{runId:string;clientId:string;snapshotHash:string}>();
  private versions=new Map<string,number>();
  private recorded=new Map<string,AgAiThread>();
  private writes=new Map<string,Promise<void>>();
  private uncertain=new Map<string,{thread:AgAiThread;expectedVersion:number}>();
  private mutationQueue:Promise<void>=Promise.resolve();
  private listeners=new Set<(event:{type:'changed'})=>void>();
  private seenEvents=new Set<string>();
  private latest:DurableStatus|null=null;
  readonly history:AgAiHistoryStore;
  readonly adapter:AgLlmAdapter;
  constructor(private readonly studio:AgStudioApi<GlasshouseRegistry>,private readonly bridge:StudioBridge,private readonly workspace:AgentHistoryBridge){
    this.history={
      listThreads:()=>api('agents/threads'),
      loadThread:async id=>{const result=await api<{thread:AgAiThread|null;version:number}>(`agents/threads/${encodeURIComponent(id)}`);this.versions.set(id,result.version);if(result.thread)this.recorded.set(id,result.thread);return result.thread??undefined;},
      saveThread:thread=>this.saveThread(thread).catch(error=>{this.bridge.onError(error instanceof Error?error.message:'The native transcript save is held.');}),
      deleteThread:id=>api(`agents/threads/${encodeURIComponent(id)}`,undefined,'DELETE').then(()=>{this.versions.delete(id);this.recorded.delete(id);}),
      addEventListener:(_type,listener)=>{this.listeners.add(listener);},removeEventListener:(_type,listener)=>{this.listeners.delete(listener);},
    };
    this.adapter={executeTurn:(request,options)=>{
      const trace=options?.trace,runId=trace?.runId;
      const complete=(async()=>{
        if(!runId)throw new Error('The native model turn has no durable run identity.');
        const active=this.active.get(trace!.threadId);if(!active||active.runId!==runId)throw new Error('The native run must be enrolled before requesting a model turn.');
        const index=this.turns.get(runId)??0;
        const snapshotHash=this.bridge.getSnapshot().hash;
        if(snapshotHash!==active.snapshotHash)throw new Error('The workspace snapshot changed. This saved turn is held at its original scope.');
        let turn=await api<TurnView>('agents/turns',{runId,index,request,clientId:active.clientId,snapshotHash},undefined,options?.signal);
        for(;;){
          options?.signal?.throwIfAborted();
          if(this.bridge.getSnapshot().hash!==active.snapshotHash)throw new Error('The workspace snapshot changed while the model was working. Its exact response remains saved.');
          if(turn.state==='completed'&&turn.response){void this.refresh().catch(()=>{});return turn.response;}
          if(['unknown','failed','unavailable'].includes(turn.state))throw new Error(turn.reason||'This saved model outcome is unresolved. No create request will be repeated.');
          turn=await api<TurnView>(`agents/turns/${encodeURIComponent(runId)}/${index}/step`,{clientId:active.clientId},undefined,options?.signal);
          if(turn.state!=='completed')await delay(turn.retryAfterMs??1500,options?.signal);
        }
      })();
      return {complete,stream:{async *[Symbol.asyncIterator]():AsyncGenerator<AgAiEvent>{
        const response=await complete;
        for(const item of response.output){
          if(item.type==='message'){
            yield {type:'TEXT_MESSAGE_START',messageId:item.id,role:'assistant'};
            yield {type:'TEXT_MESSAGE_CONTENT',messageId:item.id,delta:item.content.map(part=>part.type==='text'?part.text:part.refusal).join('\n')};
            yield {type:'TEXT_MESSAGE_END',messageId:item.id};
          }else if(item.type==='function_call'){
            yield {type:'TOOL_CALL_START',toolCallId:item.callId,toolCallName:item.name};
            yield {type:'TOOL_CALL_ARGS',toolCallId:item.callId,delta:item.arguments};
            yield {type:'TOOL_CALL_END',toolCallId:item.callId};
          }
        }
      }}};
    }};
  }
  attach(harness:AgAiHarness){this.harness=harness;controllers.set(harness,this);}
  get status(){return this.latest;}
  async refresh(threadId?:string){
    this.latest=await api<DurableStatus>(`agents/status${threadId?`?threadId=${encodeURIComponent(threadId)}`:''}`);
    for(const event of [...this.latest.events].reverse())if(!this.seenEvents.has(event.eventId)){this.seenEvents.add(event.eventId);this.bridge.onEvent(event);}
    return this.latest;
  }
  async resume(session:AgAiChatSession,run:RunView){
    if(session.status==='running')throw new Error('The native session is still running.');
    this.clientId=crypto.randomUUID();this.resumes.set(session.threadId,run.id);
    session.sendMessage('Continue the saved investigation from its recorded checkpoint.');
  }
  async stop(session:AgAiChatSession){
    session.cancel();const active=this.active.get(session.threadId);
    if(active)await api(`agents/runs/${encodeURIComponent(active.runId)}/finish`,{clientId:active.clientId,action:'cancel'});
    await this.refresh();
  }
  private async saveThread(thread:AgAiThread){
    const id=thread.summary.threadId,copy=structuredClone(thread);
    const task=(this.writes.get(id)??Promise.resolve()).then(async()=>{
      if(!this.versions.has(id))await this.history.loadThread(id);
      const uncertain=this.uncertain.get(id);
      if(uncertain){
        // Retrying the same CAS document only reconciles a lost history response.
        const saved=await api<{version:number}>(`agents/threads/${encodeURIComponent(id)}`,uncertain);
        this.versions.set(id,saved.version);this.recorded.set(id,uncertain.thread);this.uncertain.delete(id);
      }
      const prior=this.recorded.get(id);
      const combined={...copy,messages:mergeNativeMessages(prior?.messages??[],copy.messages)};
      const request={thread:combined,expectedVersion:this.versions.get(id)??0};this.uncertain.set(id,request);
      const saved=await api<{version:number}>(`agents/threads/${encodeURIComponent(id)}`,request);
      this.versions.set(id,saved.version);this.recorded.set(id,combined);this.uncertain.delete(id);
    });
    this.writes.set(id,task.catch(()=>{}));return task;
  }
  private async persistNative(threadId:string){
    const session=this.harness?.getSession?.(threadId),summary=this.harness?.getThread(threadId);
    if(!session||!summary)return;
    await this.saveThread({summary,messages:session.messages,artifacts:session.artifacts,sharedState:session.sharedState});
  }
  wrap(runner:AgAnyAiAgentRunner):AgAnyAiAgentRunner {
    const controller=this;
    return {...runner,defaultToolCalls:()=>[],async *run(input,ctx){
      let runId:string|undefined;const clientId=(input.parentRunId?[...controller.active.values()].find(active=>active.runId===input.parentRunId)?.clientId:undefined)??controller.clientId;
      let heartbeat:ReturnType<typeof setInterval>|undefined;let ended=false;let failed=false;
      try{
        const resumed=controller.resumes.get(input.threadId);controller.resumes.delete(input.threadId);
        const enrolled=await api<EnrolledRun>('agents/runs',{input,agentId:runner.id as AgentId,params:ctx.params,snapshotHash:controller.bridge.getSnapshot().hash,clientId,resumeRunId:resumed},undefined,ctx.signal);
        runId=enrolled.run.id;controller.active.set(input.threadId,{runId,clientId,snapshotHash:enrolled.run.snapshotHash});controller.turns.set(runId,0);
        const filter=visibleReplayFilter(controller.harness?.getSession?.(input.threadId)?.messages??[]);
        heartbeat=setInterval(()=>{void api(`agents/runs/${encodeURIComponent(runId!)}/heartbeat`,{clientId}).catch(error=>controller.bridge.onError(error instanceof Error?error.message:'The saved investigation needs attention.'));},10000);
        const wrapped={...ctx,params:enrolled.params??ctx.params,defaultToolCalls:()=>[],tools:()=>ctx.tools().map(tool=>controller.wrapTool(tool)),completeTask:ctx.completeTask?controller.wrapTool(ctx.completeTask):undefined,
          emit:(event:Parameters<NonNullable<typeof ctx.emit>>[0])=>{if(event.type==='turn_started')controller.turns.set(runId!,event.trace.turnIndex??0);ctx.emit?.(event);}};
        for await(const event of runner.run({...enrolled.input,runId},wrapped)){
          if(event.type==='RUN_ERROR')failed=true;
          if(event.type==='RUN_FINISHED')ended=true;
          if(filter(event))yield event;
          if(['TOOL_CALL_RESULT','TEXT_MESSAGE_END'].includes(event.type))await controller.persistNative(input.threadId);
        }
        await controller.persistNative(input.threadId);
      }catch(error){failed=true;controller.bridge.onError(error instanceof Error?error.message:'The saved investigation is held.');yield {type:'RUN_ERROR',message:error instanceof Error?error.message:'This investigation is saved with an unresolved step.',code:'DURABLE_RUN_HELD'};}
      finally{
        if(heartbeat)clearInterval(heartbeat);
        if(runId){
          try{await api(`agents/runs/${encodeURIComponent(runId)}/finish`,{clientId,action:ended&&!failed&&!ctx.signal?.aborted?'complete':'hold'});}catch(error){controller.bridge.onError(error instanceof Error?error.message:'The run checkpoint is held.');}
          controller.active.delete(input.threadId);controller.turns.delete(runId);
        }
        void controller.refresh().catch(()=>{});
      }
    }};
  }
  private wrapTool(tool:AgAiTool):AgAiTool {
    return {...tool,execute:async(call,ctx)=>{
      const active=this.active.get(ctx.run.threadId);if(!active)throw new Error('This tool has no enrolled native run.');
      const perform=async()=>{
        const mutation=mutationTools.has(call.name);
        // The same ordered writer first admits any previous native/manual changes.
        if(mutation)await this.workspace.save(this.studio.getHistory(),'Before an agent workspace change');
        if(this.bridge.getSnapshot().hash!==active.snapshotHash)throw new Error('The workspace changed snapshot before this native tool.');
        const grant=await api<ToolGrant>('agents/tools/claim',{runId:active.runId,callId:call.toolCallId,name:call.name,args:call.args,clientId:active.clientId,snapshotHash:active.snapshotHash},undefined,ctx.signal);
        if(grant.state==='completed'&&grant.result){
          // The native plan store is ephemeral. Restore the exact recorded design
          // through its public idempotent tool; no report or provider mutation occurs.
          if(call.name==='create_plan'&&tool.execute)await tool.execute(call,ctx);
          return grant.result;
        }
        if(grant.state!=='execute'||!grant.leaseToken)throw new Error(grant.reason||'The original tool result is unknown. It will not be executed again.');
        if(!tool.execute)throw new Error('This native tool has no executor.');
        if(mutation)this.workspace.mutation(true);
        try{
          const result=call.name==='execute_query'
            ?await executeIsolatedQuery(studioData(this.bridge.getSnapshot()) as import('ag-studio').AgDataSourcesDefinition,call,ctx)
            :await tool.execute(call,ctx);
          const acknowledgement={runId:active.runId,callId:call.toolCallId,clientId:active.clientId,leaseToken:grant.leaseToken,result,snapshotHash:this.bridge.getSnapshot().hash};
          if(mutation){
            if(!grant.mutationId)throw new Error('The native workspace mutation has no durable identity.');
            const history=this.studio.getHistory();this.bridge.onHistory(history);
            await this.workspace.save(history,`${ctx.run.agentId}: ${call.name}`,{...acknowledgement,mutationId:grant.mutationId});
          }else await api('agents/tools/acknowledge',acknowledgement,undefined,ctx.signal);
          void this.refresh().catch(()=>{});return result;
        }finally{if(mutation)this.workspace.mutation(false);}
      };
      if(!mutationTools.has(call.name))return perform();
      const task=this.mutationQueue.then(perform);this.mutationQueue=task.then(()=>{},()=>{});return task;
    }};
  }
}
