'use client';
import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import type {AgAiHarness,AgAiChatSession,AgAiChatMessage,AgAiToolCallView,AgAiThreadSummary} from 'ag-studio';
import {ArrowUp,ArrowUpRight,Check,ChevronDown,ChevronRight,Clock3,FileText,History,Link2,LoaderCircle,LockKeyhole,Plus,RotateCw,ShieldCheck,Sparkles,Square,Workflow,X} from 'lucide-react';
import type {AgentRunEvent,Snapshot} from '@/packages/domain/types';
import type {AgentFinding,RunView} from '@/packages/agents/contracts';
import {durableAgents,type DurableStatus} from '@/packages/agents/durable-client';
import {observeNativeThread,type NativeThreadView} from '@/packages/agents/native-thread-observer';
import {AgentMarkdown} from './agent-markdown';
import {isProposalEvidence,ProposalEvidenceCard} from './agent-proposal-evidence';
import {money,dateLabel} from '@/lib/client';

interface Props {harness:AgAiHarness|null;open:boolean;onClose():void;snapshot:Snapshot;events:AgentRunEvent[];prompt:string|null;clearPrompt():void;aiAvailable:boolean;onReviewPlan?(id:string):void;onFindings?():void}
export function AgentRail({harness,open,onClose,snapshot,events,prompt,clearPrompt,aiAvailable,onReviewPlan,onFindings}:Props){
  const [session,setSession]=useState<AgAiChatSession|null>(null);
  const [messages,setMessages]=useState<readonly AgAiChatMessage[]>([]);
  const [status,setStatus]=useState('idle');
  const [value,setValue]=useState('');
  const [historyOpen,setHistoryOpen]=useState(false);
  const [threads,setThreads]=useState<readonly AgAiThreadSummary[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [tab,setTab]=useState<'conversation'|'findings'>('conversation');
  const [durable,setDurable]=useState<DurableStatus|null>(null);
  const messagesEnd=useRef<HTMLDivElement>(null),pendingPrompt=useRef<string|null>(null),autoOpened=useRef(false);
  const sessionRef=useRef(session);sessionRef.current=session;
  const panelRef=useRef<HTMLElement>(null),opener=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    if(!open)return;opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const first=panelRef.current?.querySelector<HTMLButtonElement>('button');first?.focus();
    return()=>{if(opener.current?.isConnected)opener.current.focus();};
  },[open]);
  const tabKey=(event:KeyboardEvent<HTMLButtonElement>)=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
    const next=event.key==='Home'?'conversation':event.key==='End'?'findings':tab==='conversation'?'findings':'conversation';
    setTab(next);document.getElementById(`agent-${next}-tab`)?.focus();
  };
  useEffect(()=>{
    if(!harness)return;
    autoOpened.current=false;setSession(null);setMessages([]);setError(null);
    const update=()=>{
      const saved=[...harness.threads].sort((a,b)=>b.updatedAt-a.updatedAt);setThreads(saved);
      if(!autoOpened.current&&!sessionRef.current&&saved[0]){autoOpened.current=true;void harness.openThread(saved[0].threadId).then(setSession).catch(error=>setError(error.message));}
    };
    update();harness.addEventListener('changed',update);return()=>harness.removeEventListener('changed',update);
  },[harness]);
  useEffect(()=>{
    if(!session){setMessages([]);setStatus('idle');return;}
    const update=()=>{setMessages([...session.messages]);setStatus(session.status);};
    update();session.addEventListener('changed',update);return()=>session.removeEventListener('changed',update);
  },[session]);
  useEffect(()=>{
    if(!open||!harness)return;let live=true,running=false;
    const refresh=async()=>{if(running)return;running=true;try{const result=await durableAgents(harness)?.refresh();if(live&&result)setDurable(result);}catch(error){if(live)setError(error instanceof Error?error.message:'Saved agent status could not be read.');}finally{running=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{live=false;clearInterval(timer);};
  },[harness,open]);
  useEffect(()=>{if(tab==='conversation')messagesEnd.current?.scrollIntoView({block:'nearest'});},[messages,status,tab]);
  const currentRun=durable?.runs.find(run=>run.threadId===session?.threadId&&!run.parentRunId);
  const unresolved=currentRun&&['held','running'].includes(currentRun.state)&&status!=='running';
  const related=durable?.runs.filter(run=>run.id===currentRun?.id||isDescendant(run,currentRun?.id,durable.runs))??[];
  const unknown=related.some(run=>run.modelTurns.some(turn=>turn.state==='unknown')||run.tools.some(tool=>tool.state==='unknown'));
  const unavailable=related.some(run=>run.modelTurns.some(turn=>turn.state==='unavailable'));
  const failedModel=related.flatMap(run=>run.modelTurns).find(turn=>turn.state==='failed');
  const outputLimit=related.flatMap(run=>run.modelTurns).find(turn=>turn.outcome?.reason==='max_output_tokens')?.outcome;
  const temporaryProvider=related.some(run=>run.modelTurns.some(turn=>turn.providerStored===false));
  const findings=(durable?.documents??[]).filter(isFinding);
  const briefs=(durable?.documents??[]).filter(isBrief);
  const send=async(text:string)=>{
    if(!harness||!text.trim()||busy||status==='running'||unresolved)return;
    setBusy(true);setError(null);setValue('');autoOpened.current=true;setTab('conversation');
    try{const active=session||await harness.createThread({agentId:'coordinator',title:'Fernwood incident investigation'});setSession(active);active.sendMessage(text.trim());}
    catch(error){setError(error instanceof Error?error.message:'The investigation could not start.');}finally{setBusy(false);}
  };
  useEffect(()=>{if(!prompt||!harness||pendingPrompt.current===prompt)return;pendingPrompt.current=prompt;void send(prompt).finally(()=>{clearPrompt();pendingPrompt.current=null;});},[prompt,harness]);
  const openThread=async(id:string)=>{if(!harness)return;autoOpened.current=true;try{setSession(await harness.openThread(id));setHistoryOpen(false);setTab('conversation');}catch(error){setError(error instanceof Error?error.message:'Could not restore investigation.');}};
  const newThread=()=>{autoOpened.current=true;if(session)void durableAgents(harness)?.stop(session).catch(error=>setError(error.message));setSession(null);setMessages([]);setError(null);setHistoryOpen(false);setTab('conversation');};
  const resume=async()=>{if(!session||!currentRun)return;try{setError(null);await durableAgents(harness)?.resume(session,currentRun);}catch(error){setError(error instanceof Error?error.message:'The saved run could not resume.');}};
  if(!open)return null;
  return <aside ref={panelRef} className="agent-rail" aria-label="Glasshouse agents" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
    <div className="agent-top"><div className="agent-symbol"><Sparkles size={18}/></div><div><span className="eyebrow">GLASSHOUSE AGENTS</span><h2>Think it through.</h2></div><button className="icon-button" onClick={onClose} aria-label="Close agents"><X size={18}/></button></div>
    <div className="agent-context"><span className="status-dot"/><span>Fernwood incident · finding v{snapshot.context.cohortVersion}</span><button className="icon-button" aria-label="Saved investigations" aria-expanded={historyOpen} onClick={()=>setHistoryOpen(!historyOpen)}><History size={14}/></button><button className="icon-button" aria-label="New investigation" onClick={newThread}><Plus size={14}/></button></div>
    <div className="agent-tabs" role="tablist" aria-label="Investigation content"><button role="tab" tabIndex={tab==='conversation'?0:-1} aria-selected={tab==='conversation'} aria-controls="agent-conversation-panel" id="agent-conversation-tab" onKeyDown={tabKey} onClick={()=>setTab('conversation')}>Conversation</button><button role="tab" tabIndex={tab==='findings'?0:-1} aria-selected={tab==='findings'} aria-controls="agent-findings-panel" id="agent-findings-tab" onKeyDown={tabKey} onClick={()=>setTab('findings')}>Evidence & findings<span>{findings.length+briefs.length}</span></button></div>
    <div className="agent-scroll" role="tabpanel" id={tab==='conversation'?'agent-conversation-panel':'agent-findings-panel'} aria-labelledby={tab==='conversation'?'agent-conversation-tab':'agent-findings-tab'}>
      {tab==='findings'&&onFindings&&<button className="button agent-finding-library" onClick={onFindings}><History size={15}/>Open finding reviews & history<ArrowUpRight size={14}/></button>}
      <div className={'agent-durability '+(durable?.modelMode==='synthetic'?'synthetic':'')}><LockKeyhole size={12}/><span>{durable?.modelMode==='synthetic'?'Synthetic transport · isolated qualification':durable?.encrypted?'Encrypted history · durable checkpoints':'Opening saved investigation'}<small>Native AG Studio · {durable?.modelMode==='live'?'live model':durable?.modelMode==='synthetic'?'synthetic qualification':'model unavailable'}</small></span><span className="durability-pulse"/></div>
      {historyOpen&&<div className="agent-history"><span className="eyebrow">SAVED INVESTIGATIONS</span>{threads.length?threads.map(thread=><button key={thread.threadId} onClick={()=>void openThread(thread.threadId)}><History size={14}/><span>{thread.title||'Untitled investigation'}</span><ChevronRight size={14}/></button>):<p>Your first investigation will be saved here.</p>}</div>}
      {events.length>0&&<details className="agent-event-log"><summary><Workflow size={13}/>{events.length} recorded events<ChevronDown size={13}/></summary><div>{events.slice(0,24).map(event=><p key={event.eventId}><i className={event.resultStatus}/><span>{event.summary}</span><small>{event.transportKind}</small></p>)}</div></details>}
      {tab==='findings'?<div className="agent-findings"><div className="agent-section-intro"><span className="eyebrow">EVIDENCE BEFORE EXPLANATION</span><h3>A finding you can inspect.</h3><p>Facts are computed from the saved snapshot. Interpretations retain their sources and counterpoints.</p></div>{findings.length?findings.map(finding=><FindingCard key={finding.id} finding={finding} current={finding.snapshotHash===snapshot.hash}/>):<div className="agent-empty-artifact"><Link2 size={23}/><p>Ask the Investigator to record a finding. Its citations, source clocks and exact scope will appear here.</p></div>}{briefs.map(brief=><BriefCard key={brief.id} brief={brief}/>)}</div>:<>
        {!messages.length&&<div className="agent-welcome"><div className="agent-orbit"><span/><span/><span/><Workflow size={27}/></div><h3>From signal<br/>to understanding.</h3><p>Ask a question. Follow the evidence, actual handoffs and changes made to your workspace.</p><div className="agent-roster"><span>Coordinator</span><i>↗</i><span>Investigator</span><span>Planner</span><span>Operator</span><span>Writer</span><span>Page + Widget</span></div><div className="agent-starters"><button disabled={!harness||!aiAvailable} onClick={()=>void send('Investigate why these orders are affected. Inspect evidence, save a sourced finding with a counterpoint, and have the Page and Widget agents create a useful regional comparison.')}><span>Why these orders?</span><ArrowUpRight size={16}/></button><button disabled={!harness||!aiAvailable} onClick={()=>void send('Compare recovery branches under a $300 refund cap and explain every exclusion.')}><span>Compare recovery options</span><ArrowUpRight size={16}/></button><button disabled={!harness||!aiAvailable} onClick={()=>void send('Ask the Investigator to refund delayed orders now. Verify its authority before doing anything.')}><span>Test the authority boundary</span><ShieldCheck size={15}/></button><button disabled={!harness||!aiAvailable} onClick={()=>void send('Ask the Writer to save a sourced incident brief using findings and actual operation outcomes. Clearly state which cases remain open.')}><span>Write the incident brief</span><FileText size={15}/></button></div></div>}
        {related.length>0&&<details className="agent-handoff-map"><summary><Workflow size={14}/><span>Recorded handoffs</span><small>{related.length} native runs</small><ChevronDown size={12}/></summary><div>{[...related].reverse().map(run=><div className={'handoff-node '+run.state} key={run.id}><i/><span>{run.agentId}<small>{run.parentRunId?'Delegated':'User turn'} · {run.modelTurns.length} model turns</small></span><em>{run.state}</em></div>)}</div></details>}
        {temporaryProvider&&<p className="agent-retention-note">The provider returned temporary storage. Pending responses may expire; completed responses remain in your encrypted history.</p>}
        {messages.map(message=><div key={message.id} className={'agent-message '+message.role}>{message.role==='assistant'&&<span className="message-byline"><span className="tiny-star">✦</span>COORDINATOR</span>}{message.parts.map((part,index)=>part.type==='text'?(message.role==='assistant'?<AgentMarkdown key={index} text={part.text}/>:<div className="message-text" key={index}>{part.text}</div>):part.type==='error'?<div className="inline-error" key={index}>{part.message}</div>:part.type==='tool_call'?<ToolCall key={part.toolCall.toolCallId} call={part.toolCall} harness={harness} onReviewPlan={onReviewPlan}/>:null)}</div>)}
        {(busy||status==='running')&&<div className="agent-working" role="status"><LoaderCircle size={14}/><span>{currentRun?.modelTurns.some(turn=>turn.state==='pending')?'Following the exact saved model response…':'Following the evidence…'}</span></div>}
        {unresolved&&<div className={'agent-checkpoint '+(unknown||unavailable||failedModel?'unknown':'')} role="status"><div><LockKeyhole size={17}/><span className="eyebrow">SAVED CHECKPOINT</span></div><h3>{outputLimit?'The answer reached its output limit.':failedModel?'The original answer did not complete.':unavailable?'The saved response is unavailable.':unknown?'An outcome needs review.':'Your investigation is still here.'}</h3><p>{outputLimit?`The provider ended this exact answer at its ${outputLimit.outputLimit?.toLocaleString()??'recorded'}-token limit. Completed tools, native history and the full manifest remain available. This terminal answer cannot resume; no replacement request was sent.`:failedModel?'The provider ended the original answer without a complete result. Its identity and completed evidence are preserved. Start a separate investigation to continue; this response will not be retried.':unavailable?'The provider can no longer return this exact response. Its original identity and earlier results are preserved. Glasshouse will not send a replacement request.':unknown?'A request began without a confirmed outcome. Glasshouse will not send it again. Review its recorded steps or start a separate investigation.':currentRun.snapshotHash!==snapshot.hash?'This turn belongs to an earlier evidence snapshot. Its history is preserved; a new investigation will use the current scope.':'Continue the same turn. Completed model responses, tool results and workspace changes are reused.'}</p><code>{currentRun.id.slice(0,28)} · {currentRun.snapshotHash.slice(0,10)}</code><div className="checkpoint-actions">{!unknown&&!unavailable&&!failedModel&&currentRun.snapshotHash===snapshot.hash&&<button className="button primary" disabled={!currentRun.canResume} onClick={()=>void resume()}><RotateCw size={13}/>{currentRun.canResume?'Resume saved turn':'Waiting for original tab'}</button>}<button className="button" onClick={newThread}>New investigation<ArrowUpRight size={13}/></button></div></div>}
        {error&&<div className="inline-error" role="alert">{error}</div>}<div ref={messagesEnd}/>
      </>}
    </div>
    <form className="agent-composer" onSubmit={event=>{event.preventDefault();void send(value);}}><label className="sr-only" htmlFor="agent-prompt">Ask the Glasshouse agents</label><textarea id="agent-prompt" value={value} onChange={event=>setValue(event.target.value)} placeholder={unresolved?'Saved checkpoint above':aiAvailable?'Ask about this incident…':'Live AI is not connected'} disabled={!aiAvailable||!!unresolved} rows={1} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void send(value);}}}/>{status==='running'?<button type="button" aria-label="Stop investigation" onClick={()=>{if(session)void durableAgents(harness)?.stop(session).catch(error=>setError(error.message));}}><Square size={14}/></button>:<button type="submit" aria-label="Send message" disabled={!value.trim()||busy||!harness||!aiAvailable||!!unresolved}><ArrowUp size={17}/></button>}<p><ShieldCheck size={12}/>Financial actions require your review.</p></form>
  </aside>;
}
function isDescendant(run:RunView,root:string|undefined,runs:RunView[]){if(!root)return false;let next=run.parentRunId;const seen=new Set<string>();while(next&&!seen.has(next)){if(next===root)return true;seen.add(next);next=runs.find(row=>row.id===next)?.parentRunId??null;}return false;}
function isFinding(value:unknown):value is AgentFinding{return !!value&&typeof value==='object'&&'interpretation'in value&&'evidence'in value&&Array.isArray(value.evidence);}
interface Brief {id:string;title:string;snapshotHash:string;createdAt:string;facts:Snapshot['totals'];sourceCoverage:Snapshot['sourceCoverage'];outcomes:{cases:{id:string;status:string}[];operations:{status:string;kind:string;amountMinor:number}[]};limitations:string[]}
function isBrief(value:unknown):value is Brief{return !!value&&typeof value==='object'&&'limitations'in value&&'outcomes'in value&&'facts'in value;}
function FindingCard({finding,current}:{finding:AgentFinding;current:boolean}){
  const paymentLabel=finding.sourceCoverage?.sandboxPayments===0?'Sample':finding.sourceCoverage?.samplePayments===0?'Sandbox':'Mixed sources';
  return <article className="agent-finding-card"><div className="finding-card-top"><span className="eyebrow">{finding.status==='insufficient_evidence'?'INSUFFICIENT EVIDENCE':'SOURCED HYPOTHESIS'}</span><span className={current?'scope-current':'scope-earlier'}>{current?'Current scope':'Earlier snapshot'}</span></div><h3>{finding.title}</h3><div className="finding-facts"><div><strong>{finding.facts.affected}</strong><span>affected orders</span></div><div><strong>{money(finding.facts.capturedMinor)}</strong><span>{paymentLabel} captured · {finding.facts.currency}</span></div><div><strong>{finding.facts.openDisputes}</strong><span>open cases</span></div></div><span className="finding-label">INTERPRETATION</span><p>{finding.interpretation}</p><div className="finding-counterpoint"><span className="finding-label">COUNTERPOINT</span><p>{finding.counterpoint}</p></div><details className="finding-sources"><summary><Link2 size={13}/>{finding.evidence.length} exact source records<ChevronDown size={13}/></summary>{finding.evidence.map(source=><div key={source.id}><span>{source.sourceLabel}</span><strong>{source.title}</strong><code>{source.id}</code><small>Occurred {dateLabel(source.occurredAt)}<br/>Known {dateLabel(source.ingestedAt)}</small><code>sha256 {source.hash.slice(0,16)}</code></div>)}</details><footer><span>Source cohort {finding.revision} · Original proposal · {finding.facts.clock==='narrative_replay'?'Narrative clock':'Observed clock'}</span><code>{finding.snapshotHash.slice(0,14)}</code></footer></article>;
}
function BriefCard({brief}:{brief:Brief}){return <details className="agent-brief-card"><summary><FileText size={18}/><span><strong>{brief.title}</strong><small>Saved {dateLabel(brief.createdAt)}</small></span><ChevronDown size={13}/></summary><div><p>{brief.facts.affected} affected orders · {brief.facts.openDisputes} open cases at this snapshot.</p><span className="finding-label">OBSERVED CASE STATES</span>{brief.outcomes.cases.map(row=><p key={row.id}><code>{row.id}</code><br/>{row.status.replaceAll('_',' ').toLowerCase()}</p>)}{brief.limitations.map(text=><p className="brief-limitation" key={text}>{text}</p>)}<code>Scope {brief.snapshotHash.slice(0,16)}</code></div></details>;}
function ToolCall({call,harness,onReviewPlan}:{call:AgAiToolCallView;harness:AgAiHarness|null;onReviewPlan?:(id:string)=>void}){
  const [child,setChild]=useState<NativeThreadView>({state:'waiting',session:null,messages:[]});
  useEffect(()=>{
    setChild({state:'waiting',session:null,messages:[]});
    if(!call.childThreadId||!harness)return;
    return observeNativeThread(harness,call.childThreadId,setChild);
  },[call.childThreadId,harness]);
  const executing=['ready','streaming','executing'].includes(call.status),result=call.result as {success?:boolean;data?:{id?:string;refundTotalMinor?:number;eligibleCount?:number;source?:string;transport?:string}}|undefined;
  const failed=result?.success===false;const complete=call.status==='complete'&&!failed;
  const recorded=call.result===undefined?null:JSON.stringify(call.result,null,2);
  const downloadResult=()=>{if(!recorded)return;const link=document.createElement('a'),url=URL.createObjectURL(new Blob([recorded],{type:'application/json'}));link.href=url;link.download=`glasshouse-${call.name}-${call.toolCallId}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return <details className={'tool-call '+(failed?'error':call.status)} open={executing&&!!call.childThreadId}><summary>{executing?<LoaderCircle size={13}/>:complete?<Check size={13}/>:<Clock3 size={13}/>}<span>{call.name.replaceAll('_',' ')}</span><small>{failed?'refused':complete?'recorded':call.status}</small><ChevronDown size={12}/></summary><div className="tool-detail"><details className="tool-receipt"><summary>Exact task</summary><pre>{JSON.stringify(call.args,null,2)}</pre></details>{call.childThreadId&&<div className="nested-agent"><span className="eyebrow">NATIVE DELEGATED RUN</span>{child.messages.filter(message=>message.role==='assistant').map(message=><div key={message.id}>{message.parts.map((part,index)=>part.type==='text'?<AgentMarkdown key={index} text={part.text}/>:part.type==='tool_call'?<ToolCall key={part.toolCall.toolCallId} call={part.toolCall} harness={harness} onReviewPlan={onReviewPlan}/>:part.type==='error'?<p className="inline-error" key={index}>{part.message}</p>:null)}</div>)}{child.state!=='ready'&&<p role="status">{child.state==='unavailable'?'The saved native transcript could not be loaded. Its recorded tool result remains available below.':child.state==='waiting'?(executing?'Starting the native delegate…':'The native delegate is not available in this session. Its recorded tool result remains available below.'):'Opening the actual saved delegate…'}</p>}</div>}{['prepare_recovery','read_recovery_proposal'].includes(call.name)&&result?.success&&isProposalEvidence(result.data)&&<ProposalEvidenceCard evidence={result.data} onReviewPlan={onReviewPlan}/>}{call.name.startsWith('paypal_')&&result?.success&&<p className="toolkit-receipt-label"><Link2 size={12}/>{result.data?.source==='synthetic_transport'?'Synthetic transport qualification':'Sandbox read'} · installed PayPal Toolkit</p>}{recorded!==null&&<details className="tool-receipt"><summary>Recorded result</summary><pre>{recorded.slice(0,12000)}</pre>{recorded.length>12000&&<p className="tool-receipt-preview">Showing a preview. The complete result is preserved in the native history.</p>}<button className="tool-receipt-download" onClick={downloadResult}>Download complete recorded result<ArrowUpRight size={13}/></button></details>}</div></details>;
}
