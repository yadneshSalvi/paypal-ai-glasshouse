'use client';
import {useEffect,useRef,useState} from 'react';
import type {AgAiHarness,AgAiChatSession,AgAiChatMessage,AgAiToolCallView,AgAiThreadSummary} from 'ag-studio';
import {ArrowUp,ArrowUpRight,Check,ChevronDown,ChevronRight,Clock3,History,LoaderCircle,Plus,ShieldCheck,Sparkles,Square,Workflow,X} from 'lucide-react';
import type {AgentRunEvent,Snapshot} from '@/packages/domain/types';

interface Props {harness:AgAiHarness|null;open:boolean;onClose():void;snapshot:Snapshot;events:AgentRunEvent[];prompt:string|null;clearPrompt():void;aiAvailable:boolean}
export function AgentRail({harness,open,onClose,snapshot,events,prompt,clearPrompt,aiAvailable}:Props){
  const [session,setSession]=useState<AgAiChatSession|null>(null);
  const [messages,setMessages]=useState<readonly AgAiChatMessage[]>([]);
  const [status,setStatus]=useState('idle');
  const [value,setValue]=useState('');
  const [historyOpen,setHistoryOpen]=useState(false);
  const [threads,setThreads]=useState<readonly AgAiThreadSummary[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const messagesEnd=useRef<HTMLDivElement>(null);
  const pendingPrompt=useRef<string|null>(null);
  useEffect(()=>{
    if(!harness)return;
    setSession(null);setMessages([]);setError(null);
    const update=()=>setThreads(harness.threads);
    update();harness.addEventListener('changed',update);
    return()=>harness.removeEventListener('changed',update);
  },[harness]);
  useEffect(()=>{
    if(!session){setMessages([]);setStatus('idle');return;}
    const update=()=>{setMessages([...session.messages]);setStatus(session.status);};
    update();session.addEventListener('changed',update);
    return()=>session.removeEventListener('changed',update);
  },[session]);
  useEffect(()=>{messagesEnd.current?.scrollIntoView({block:'nearest'});},[messages,status]);
  const send=async(text:string)=>{
    if(!harness||!text.trim()||busy||status==='running')return;
    setBusy(true);setError(null);setValue('');
    try {const active=session||await harness.createThread({agentId:'coordinator',title:'Fernwood incident investigation'});setSession(active);active.sendMessage(text.trim());}
    catch(e){setError(e instanceof Error?e.message:'The investigation could not start.');}
    finally{setBusy(false);}
  };
  useEffect(()=>{
    if(!prompt||!harness||pendingPrompt.current===prompt)return;
    pendingPrompt.current=prompt;void send(prompt).finally(()=>{clearPrompt();pendingPrompt.current=null;});
  },[prompt,harness]);
  const openThread=async(id:string)=>{if(!harness)return;try{setSession(await harness.openThread(id));setHistoryOpen(false);}catch(e){setError(e instanceof Error?e.message:'Could not restore investigation.');}};
  if(!open)return null;
  return <aside className="agent-rail" aria-label="Glasshouse agents">
    <div className="agent-top"><div className="agent-symbol"><Sparkles size={18}/></div><div><span className="eyebrow">GLASSHOUSE AGENTS</span><h2>Think it through.</h2></div><button className="icon-button" onClick={onClose} aria-label="Close agents"><X size={18}/></button></div>
    <div className="agent-context"><span className="status-dot"/><span>Fernwood incident · finding v{snapshot.context.cohortVersion}</span><button className="icon-button" title="Saved investigations" aria-label="Saved investigations" aria-expanded={historyOpen} onClick={()=>setHistoryOpen(!historyOpen)}><History size={14}/></button><button className="icon-button" title="New investigation" aria-label="New investigation" onClick={()=>{session?.cancel();setSession(null);setMessages([]);setError(null);}}><Plus size={14}/></button></div>
    {historyOpen&&<div className="agent-history"><span className="eyebrow">SAVED INVESTIGATIONS</span>{threads.length?threads.map(t=><button key={t.threadId} onClick={()=>openThread(t.threadId)}><History size={14}/><span>{t.title||'Untitled investigation'}</span><ChevronRight size={14}/></button>):<p>Your first investigation will be saved here.</p>}</div>}
    <div className="agent-scroll">
      {!messages.length&&<div className="agent-welcome"><div className="agent-orbit"><span/><span/><span/><Workflow size={27}/></div><h3>From signal<br/>to understanding.</h3><p>Ask a question. Follow the evidence, the delegated work and the changes made to your workspace.</p><div className="agent-roster"><span>Coordinator</span><i>↗</i><span>Investigator</span><span>Planner</span><span>Widget</span></div><div className="agent-starters"><button disabled={!harness||!aiAvailable} onClick={()=>send('Investigate why these orders are affected. Inspect the evidence and have the Widget agent add a useful regional comparison to the workspace.')}><span>Why these orders?</span><ArrowUpRight size={16}/></button><button disabled={!harness||!aiAvailable} onClick={()=>send('Compare the recovery branches under a $300 refund cap and explain every exclusion.')}><span>Compare recovery options</span><ArrowUpRight size={16}/></button><button disabled={!harness||!aiAvailable} onClick={()=>send('Ask the Investigator to refund the delayed orders now. Verify its authority before doing anything.')}><span>Test the authority boundary</span><ShieldCheck size={15}/></button></div></div>}
      {messages.map(message=><div key={message.id} className={'agent-message '+message.role}>{message.role==='assistant'&&<span className="message-byline"><span className="tiny-star">✦</span>COORDINATOR</span>}{message.parts.map((part,i)=>part.type==='text'?<div className="message-text" key={i}>{part.text}</div>:part.type==='error'?<div className="inline-error" key={i}>{part.message}</div>:part.type==='tool_call'?<ToolCall key={part.toolCall.toolCallId} call={part.toolCall} harness={harness}/>:null)}</div>)}
      {(busy||status==='running')&&<div className="agent-working"><LoaderCircle size={14}/><span>{events.find(e=>e.resultStatus==='running')?.summary||'Following the evidence…'}</span></div>}
      {error&&<div className="inline-error">{error}</div>}
      <div ref={messagesEnd}/>
    </div>
    {events.length>0&&<details className="agent-event-log"><summary><Workflow size={13}/>{events.length} observed run events<ChevronDown size={13}/></summary><div>{events.slice(0,20).map(e=><p key={e.eventId}><i className={e.resultStatus}/><span>{e.summary}</span><small>{e.transportKind}</small></p>)}</div></details>}
    <form className="agent-composer" onSubmit={e=>{e.preventDefault();void send(value);}}><label className="sr-only" htmlFor="agent-prompt">Ask the Glasshouse agents</label><textarea id="agent-prompt" value={value} onChange={e=>setValue(e.target.value)} placeholder={aiAvailable?'Ask about this incident…':'Live AI is not connected'} disabled={!aiAvailable} rows={2} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send(value);}}}/><div><span><ShieldCheck size={12}/>You approve every action.</span>{status==='running'?<button type="button" aria-label="Stop investigation" onClick={()=>session?.cancel()}><Square size={14}/></button>:<button type="submit" aria-label="Send message" disabled={!value.trim()||busy||!harness||!aiAvailable}><ArrowUp size={17}/></button>}</div></form>
    <div className="agent-footnote">Live model · source-grounded tools · saved history</div>
  </aside>;
}
function ToolCall({call,harness}:{call:AgAiToolCallView;harness:AgAiHarness|null}){
  const [child,setChild]=useState<AgAiChatSession|null>(null);
  const [messages,setMessages]=useState<readonly AgAiChatMessage[]>([]);
  useEffect(()=>{
    if(!call.childThreadId||!harness)return;
    const nested=harness.getSession?.(call.childThreadId);if(!nested)return;
    setChild(nested);const update=()=>setMessages([...nested.messages]);update();nested.addEventListener('changed',update);return()=>nested.removeEventListener('changed',update);
  },[call.childThreadId,harness,call.status]);
  const executing=['ready','streaming','executing'].includes(call.status);
  return <details className={'tool-call '+call.status} open={executing&&!!call.childThreadId}><summary>{executing?<LoaderCircle size={13}/>:call.status==='complete'?<Check size={13}/>:<Clock3 size={13}/>}<span>{call.name.replaceAll('_',' ')}</span><small>{call.status==='complete'?'complete':call.status}</small><ChevronDown size={12}/></summary><div className="tool-detail"><details className="tool-receipt"><summary>Task details</summary><pre>{JSON.stringify(call.args,null,2)}</pre></details>{call.childThreadId&&<div className="nested-agent"><span className="eyebrow">DELEGATED RUN</span>{messages.map(m=><div key={m.id}>{m.parts.map((p,i)=>p.type==='text'?<p key={i}>{p.text}</p>:p.type==='tool_call'?<div className="child-tool" key={i}><ChevronRight size={12}/>{p.toolCall.name.replaceAll('_',' ')}<small>{p.toolCall.status}</small></div>:null)}</div>)}{!child&&<p>Delegated run saved · {call.childThreadId.slice(0,10)}</p>}</div>}{call.result!==undefined&&<details className="tool-receipt"><summary>Tool result</summary><pre>{JSON.stringify(call.result,null,2).slice(0,8000)}</pre></details>}</div></details>;
}
