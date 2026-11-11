'use client';
import {useCallback,useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import dynamic from 'next/dynamic';
import type {AgStudioApi,AgAiHarness,AgReportHistory} from 'ag-studio';
import {Activity,ArrowDown,ArrowDownToLine,ArrowLeft,ArrowRight,ArrowUpRight,BookOpen,Check,CheckCheck,ChevronDown,ChevronRight,CircleHelp,Clock3,Command,Copy,Download,ExternalLink,FileClock,FileText,Filter,GitBranch,History,Layers3,Leaf,LoaderCircle,LockKeyhole,Menu,MoreHorizontal,PanelRightClose,Plus,RefreshCw,RotateCcw,Search,Settings2,ShieldCheck,Sparkles,Truck,TriangleAlert,Undo2,Redo2,Workflow,X} from 'lucide-react';
import type {Actor,Snapshot,RecoveryPlan,Operation,AuditEvent,AgentRunEvent,RecoveryBranch,ActionRow} from '@/packages/domain/types';
import type {GlasshouseRegistry,StudioBridge} from '@/packages/studio/types';
import type {HistoryRestoreStatus} from '@/packages/studio/history';
import type {SavedHistory} from '@/packages/studio/history-saves';
import {api,dateLabel,money,sourceLabel,scopedApiUrl} from '@/lib/client';
import {admitWorkspace,announceWorkspaceChange,connectWorkspaceSignals,workspaceScope} from '@/lib/workspace-context';
import type {WorkspaceBootstrap,WorkspaceDirectory} from '@/packages/workspaces/types';
import {WorkspaceDirectoryDialog} from './workspace-directory';
import {FindingLibrary,FindingSelector} from './finding-library';
import type {FindingDetail,FindingReference,PlanDependencyReview} from '@/packages/findings/types';
import {ReportLibrary} from './report-library';
import {browserReportHash} from '@/packages/reports/canonical';
import {AgentRail} from './agent-rail';
import {OrderRecord} from './order-record';
import type {OrderDetail} from '@/packages/domain/order-detail';
import {ObservationHealth,ReceiptStatus} from './observation-status';
import {ReportingStatus} from './reporting-status';
import {useDialogFocus,useDialogRequestBoundary} from './dialog-focus';

const StudioWorkspace=dynamic(()=>import('@/packages/studio/workspace'),{ssr:false,loading:()=> <div className="studio-loading"><LoaderCircle size={24}/><span>Preparing your instruments…</span></div>});
type View='overview'|'incident'|'recovery'|'disputes'|'history';
type CapabilityProof={available:boolean;reason:string};
type Capabilities={studio:{available:boolean;version:string;widgets:number};storage:{available:boolean;type:string};ai:{available:boolean;model:string};paypal:{available:boolean;isolated:boolean;reason:string};refunds:CapabilityProof;tracking:CapabilityProof;disputes:CapabilityProof;webhooks:CapabilityProof};
type Bootstrap={actor:Actor;snapshot:Snapshot;workspace:WorkspaceBootstrap;capabilities:Capabilities;studioLicense:string};
type AuditRow=AuditEvent & {sequence:number};
type Bundle={session:Bootstrap;history:AgReportHistory<GlasshouseRegistry>|null;historyVersion:number;plans:RecoveryPlan[];operations:Operation[];audit:AuditRow[];events:AgentRunEvent[]};
let initialLoad:Promise<Bundle>|null=null;
async function loadWorkspace():Promise<Bundle>{
  const session=await api<Bootstrap>('session',{});
  admitWorkspace(session.workspace.identity.contextId,session.workspace.workspace.id);
  const [saved,plans,operations,audit,events]=await Promise.all([api<SavedHistory>('layout?envelope=1'),api<RecoveryPlan[]>('plans'),api<Operation[]>('operations'),api<AuditRow[]>('history'),api<AgentRunEvent[]>('agent/events')]);
  return {session,history:saved.history,historyVersion:saved.version,plans,operations,audit,events};
}
function KeyRoundIcon(){return <LockKeyhole size={31}/>;}
const nav:[View,string,typeof Activity][]=[['overview','Overview',Activity],['incident','Incident room',Layers3],['recovery','Recovery',GitBranch],['disputes','Disputes',ShieldCheck],['history','History',FileClock]];

export function GlasshouseApp({initialView}:{initialView:string}){
  const [view,setView]=useState<View>(nav.some(v=>v[0]===initialView)?initialView as View:'incident');
  const [bundle,setBundle]=useState<Bundle|null>(null);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [plans,setPlans]=useState<RecoveryPlan[]>([]);
  const [operations,setOperations]=useState<Operation[]>([]);
  const [audit,setAudit]=useState<AuditRow[]>([]);
  const [events,setEvents]=useState<AgentRunEvent[]>([]);
  const [loadError,setLoadError]=useState<string|null>(null);
  const [notice,setNotice]=useState<{text:string;tone:'good'|'error'|'info'}|null>(null);
  const [agentOpen,setAgentOpen]=useState(false);
  const [agentPrompt,setAgentPrompt]=useState<string|null>(null);
  const [harness,setHarness]=useState<AgAiHarness|null>(null);
  const [studioApi,setStudioApi]=useState<AgStudioApi<GlasshouseRegistry>|null>(null);
  const [studioHistory,setStudioHistory]=useState<AgReportHistory<GlasshouseRegistry>|null>(null);
  const [historyStatus,setHistoryStatus]=useState<HistoryRestoreStatus|null>(null);
  const historyVerified=useRef(false);
  const historyActions=useRef<{save():Promise<void>;retry():Promise<void>}|null>(null);
  const [historySaveError,setHistorySaveError]=useState<string|null>(null);
  const [editable,setEditable]=useState(false);
  const [snapshotBusy,setSnapshotBusy]=useState(false);
  const [committed,setCommitted]=useState<string|null>(null);
  const [searchOpen,setSearchOpen]=useState(false);
  const [sourceOpen,setSourceOpen]=useState(false);
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const [reportsOpen,setReportsOpen]=useState(false);
  const [findingsOpen,setFindingsOpen]=useState<string|null>(null),[correctionMoment,setCorrectionMoment]=useState<FindingDetail['correctionMoment']>(null),correctionSeen=useRef(new Set<string>());
  const onFindingCorrection=useCallback((moment:NonNullable<FindingDetail['correctionMoment']>)=>{if(!correctionSeen.current.has(moment.sourceChangeId)){correctionSeen.current.add(moment.sourceChangeId);setCorrectionMoment(moment);}},[]);
  useEffect(()=>{const id=new URLSearchParams(location.search).get('finding');if(id)setFindingsOpen(id);},[]);
  const contextState=useSyncExternalStore(workspaceScope.subscribe,workspaceScope.snapshot,workspaceScope.snapshot);
  const writeHeld=contextState.held||bundle?.session.workspace.workspace.status==='archived'||bundle?.session.actor.role==='viewer';
  useEffect(connectWorkspaceSignals,[]);
  const [helpOpen,setHelpOpen]=useState(false);
  const [orderId,setOrderId]=useState<string|null>(null);
  const [branchId,setBranchId]=useState<string|null>(null);
  const [selectedPlan,setSelectedPlan]=useState<RecoveryPlan|null>(null);
  const [busy,setBusy]=useState(false);
  const [selectedCount,setSelectedCount]=useState<number|null>(null);
  const [menuOpen,setMenuOpen]=useState(false);
  const requestGeneration=useRef(0);
  const controller=useRef<AbortController|null>(null);
  const snapRef=useRef(snapshot);snapRef.current=snapshot;
  const noticeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const notify=useCallback((text:string,tone:'good'|'error'|'info'='info')=>{setNotice({text,tone});if(noticeTimer.current)clearTimeout(noticeTimer.current);noticeTimer.current=setTimeout(()=>setNotice(null),6500);},[]);
  useEffect(()=>{
    let mounted=true;
    initialLoad ||=loadWorkspace();
    void initialLoad.then(b=>{if(!mounted)return;setBundle(b);setSnapshot(b.session.snapshot);setPlans(b.plans);setOperations(b.operations);setAudit(b.audit);setEvents(b.events);setStudioHistory(b.history);}).catch(e=>{if(mounted){setLoadError(e.message);initialLoad=null;}});
    return()=>{mounted=false;};
  },[]);
  const navigate=useCallback((next:View)=>{setView(next);setMenuOpen(false);window.history.pushState({},'',next==='incident'?'/':'/'+next);window.scrollTo({top:0,behavior:'instant'});},[]);
  useEffect(()=>{
    const pop=()=>{const next=location.pathname.split('/')[1]||'incident';setView(nav.some(n=>n[0]===next)?next as View:'incident');};
    const keyboard=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();setSearchOpen(s=>!s);}if(e.key==='Escape'){setSearchOpen(false);setHelpOpen(false);setSourceOpen(false);}};
    window.addEventListener('popstate',pop);window.addEventListener('keydown',keyboard);return()=>{window.removeEventListener('popstate',pop);window.removeEventListener('keydown',keyboard);};
  },[]);
  const refreshRecords=useCallback(async()=>{
    const [p,o,a]=await Promise.all([api<RecoveryPlan[]>('plans'),api<Operation[]>('operations'),api<AuditRow[]>('history')]);setPlans(p);setOperations(o);setAudit(a);setSelectedPlan(current=>current?p.find(plan=>plan.id===current.id)??current:null);
  },[]);
  const recoveryActive=operations.some(operation=>['queued','submitting','provider_pending','unknown_outcome'].includes(operation.status));
  useEffect(()=>{
    if(!bundle||!recoveryActive||view!=='recovery'&&!selectedPlan)return;
    let active=true,pending=false;
    const timer=setInterval(()=>{if(pending||!active)return;pending=true;void refreshRecords().catch(()=>{}).finally(()=>{pending=false;});},5000);
    return()=>{active=false;clearInterval(timer);};
  },[bundle,recoveryActive,view,selectedPlan?.id,refreshRecords]);
  const changeSnapshot=useCallback(async(asOf?:string,knownAt?:string)=>{
    const generation=++requestGeneration.current;
    controller.current?.abort();controller.current=new AbortController();
    setSnapshotBusy(true);
    try{const q=new URLSearchParams({generationId:String(generation)});if(asOf)q.set('asOf',asOf);if(knownAt)q.set('knownAt',knownAt);const next=await api<Snapshot>('snapshots?'+q,undefined,undefined,controller.current.signal);if(generation!==requestGeneration.current)return;setSnapshot(next);setSelectedCount(null);}
    catch(e){if(e instanceof Error&&e.name!=='AbortError')notify(e.message,'error');}
    finally{if(generation===requestGeneration.current)setSnapshotBusy(false);}
  },[notify]);
  const revise=async()=>{
    if(writeHeld){notify('This workspace is read-only. Saved evidence remains available.','info');return;}
    if(busy)return;setBusy(true);
    try{const r=await api<{removed:string[];alreadyApplied?:boolean}>('evidence/revise',{});await changeSnapshot(snapRef.current?.context.asOf);await refreshRecords();notify(r.alreadyApplied?'These delivery records are already part of the evidence.':`${r.removed.length} delivery records received. The actual scope and affected saved decisions were checked against the new sources.`,'good');}
    catch(e){notify((e as Error).message,'error');}finally{setBusy(false);}
  };
  const ask=(prompt:string)=>{setAgentOpen(true);setAgentPrompt(prompt);if(view!=='incident')navigate('incident');};
  const bridge=useMemo<StudioBridge>(()=>({
    getSnapshot:()=>snapRef.current!,onTime:time=>void changeSnapshot(time,snapRef.current?.context.knownAt),onOrder:setOrderId,onBranch:setBranchId,onRevision:()=>void revise(),onFindings:()=>setFindingsOpen(''),
    onWidgetReady(id,hash,_total,selected){if(id==='river'&&hash===snapRef.current?.hash)setSelectedCount(selected);},
    onEvent:e=>setEvents(old=>old.some(row=>row.eventId===e.eventId)?old:[e,...old].slice(0,100)),onApi:setStudioApi,onHistory:setStudioHistory,onError:e=>notify(e,'error'),
  }),[changeSnapshot,notify,busy]);
  const onCommitted=useCallback((hash:string)=>setCommitted(hash),[]);
  const prepareEdition=async()=>{
    if(writeHeld||!studioApi||!historyActions.current||!historyVerified.current||!snapRef.current)throw new Error('Restore and save the complete native workspace before creating an edition.');
    const snapshotHash=snapRef.current.hash,local=structuredClone(studioApi.getHistory());
    await historyActions.current.save();
    const saved=await api<SavedHistory&{hash:string}>('layout?envelope=1'),localHash=await browserReportHash(local);
    if(saved.hash!==localHash||await browserReportHash(studioApi.getHistory())!==localHash||snapRef.current?.hash!==snapshotHash)throw new Error('The snapshot or native history changed while preparing this edition. Review the current workspace before creating a new report.');
    return {snapshotHash,expectedLayoutVersion:saved.version,expectedLayoutHash:localHash};
  };
  const saveLayout=async()=>{if(writeHeld){notify('This workspace is read-only.','info');return;}if(!studioApi||!historyVerified.current){notify('The saved workspace is preserved while its history is being checked.','error');return;}try{if(!historyActions.current)throw new Error('The workspace save controls are not ready.');await historyActions.current.save();notify('Investigation layout and undo history saved.','good');await refreshRecords();}catch(e){notify((e as Error).message,'error');}};
  const newPlan=async(branch:string,budgetMinor:number,findingDependencies:FindingReference[]=[])=>{
    return api<RecoveryPlan>('plans',{branchId:branch,budgetMinor,snapshotHash:snapRef.current?.hash,findingDependencies});
  };
  const approve=async(plan:RecoveryPlan,fixtureAcknowledged:boolean)=>{
    const approved=await api<RecoveryPlan>(`plans/${plan.id}/approve`,{hash:plan.hash,fixtureAcknowledged});setSelectedPlan(approved);await refreshRecords();notify(approved.executionMode==='sample'?'Rehearsal manifest approved. Provider action requirements can now be inspected.':'Exact sandbox manifest approved.','good');return approved;
  };
  const execute=async(plan:RecoveryPlan)=>{
    await api(`plans/${plan.id}/execute`,{hash:plan.hash});await refreshRecords();notify(plan.executionMode==='sandbox'?'The exact actions are saved in the durable queue. Each result will appear after independent provider verification.':'The rehearsal requirements are recorded beside each action.','info');
  };
  const updateDirectory=(directory:WorkspaceDirectory)=>{
    if(!bundle||directory.identity.contextId!==bundle.session.workspace.identity.contextId)return;
    const selected=directory.workspaces.find(row=>row.id===bundle.session.actor.tenantId);
    if(!selected||selected.membershipVersion!==bundle.session.actor.membershipVersion||selected.role!==bundle.session.actor.role){workspaceScope.hold('Workspace membership changed. Open a current workspace to continue.');return;}
    setBundle(current=>current?{...current,session:{...current.session,workspace:{identity:directory.identity,workspace:selected}}}:current);
  };
  const startFresh=async()=>{try{const result=await api<Bootstrap>('session/new',{});announceWorkspaceChange(result.workspace.identity.contextId,result.actor.tenantId);location.assign('/');}catch(error){setLoadError((error as Error).message);}};
  if(!bundle||!snapshot)return <div className="boot-screen"><Logo/><div className="boot-illustration"><span/><span/><span/><i/></div><span className="eyebrow">COMMERCE, WITH CONTEXT.</span><h1>{loadError?'Let’s reconnect.':'Every business has a story.'}</h1><p>{loadError||'Opening the evidence, the moments and the decisions that matter.'}</p>{loadError?<div className="boot-recovery"><button className="button primary" onClick={()=>location.reload()}>Retry connection<RefreshCw size={15}/></button><button className="button" onClick={event=>{event.currentTarget.focus({preventScroll:true});setWorkspaceOpen(true);}}>Choose a workspace<Layers3 size={15}/></button><details><summary>Need separate Sample access?</summary><p>Start a new Sample workspace explicitly. Existing saved work is preserved and requires its original access or a fresh invitation.</p><button className="button" onClick={()=>void startFresh()}>Start new Sample workspace</button></details></div>:<LoaderCircle className="spin" size={22}/>}<span className="boot-foot">GLASSHOUSE · COMMERCE WITH CONTEXT</span>{workspaceOpen&&<WorkspaceDirectoryDialog onClose={()=>setWorkspaceOpen(false)}/>}</div>;
  const currency=snapshot.context.currency;
  const live=bundle.session.capabilities.paypal.available;
  return <div className={'app-shell '+(agentOpen?'with-agent':'')+(contextState.held?' context-held':'')}>
    <header className="app-header"><div className="header-left"><Logo/><span className="header-divider"/><button className="merchant-switch" data-focus-return="workspace-directory" aria-label="Choose or manage merchant workspaces" onClick={event=>{event.currentTarget.focus({preventScroll:true});setWorkspaceOpen(true);}}><span className="merchant-avatar"><Leaf size={15}/></span><span>{bundle.session.workspace.workspace.merchantName}</span><ChevronDown size={13}/></button></div><div className="header-right"><button className="search-launch" aria-label="Find an order or source" onClick={()=>setSearchOpen(true)}><Search size={14}/><span>Find an order, a fact…</span><kbd>⌘ K</kbd></button><button className="icon-button" aria-label="Help and keyboard shortcuts" onClick={()=>setHelpOpen(true)}><CircleHelp size={18}/></button><span className="header-divider"/><button className="profile" onClick={event=>{event.currentTarget.focus({preventScroll:true});setWorkspaceOpen(true);}} aria-label="Open workspace access details">{bundle.session.workspace.identity.displayName.split(/\s+/).map(value=>value[0]).slice(0,2).join('').toUpperCase()}<span/></button><button className="icon-button mobile-menu" onClick={()=>setMenuOpen(!menuOpen)} aria-label="Toggle navigation"><Menu size={19}/></button></div></header>
    <nav className={'app-nav '+(menuOpen?'menu-open':'')} aria-label="Main navigation"><div>{nav.map(([id,label,Icon])=><a key={id} href={id==='incident'?'/':'/'+id} aria-current={view===id?'page':undefined} className={view===id?'selected':''} onClick={e=>{e.preventDefault();navigate(id);}}><Icon size={15}/><span>{label}</span>{id==='incident'&&<i className="nav-signal"/>}{id==='disputes'&&<em>{snapshot.totals.openDisputes}</em>}</a>)}<a href="/sandbox"><ShieldCheck size={15}/><span>Sandbox</span></a></div><button className="connection-status" onClick={()=>setSourceOpen(true)}><i className={live?'live':'sample'}/>{live?'Sandbox connected':'Sample workspace'}<ChevronDown size={12}/></button></nav>
    {contextState.held&&<section className="workspace-context-hold" role="alert"><KeyRoundIcon/><span className="eyebrow">SAVED WORKSPACE PRESERVED</span><h2>Choose where to continue.</h2><p>{contextState.reason}</p><button className="button primary" onClick={event=>{event.currentTarget.focus({preventScroll:true});setWorkspaceOpen(true);}}>Open workspace directory<ArrowRight size={15}/></button></section>}
    <main className="main-content" inert={contextState.held||undefined} aria-hidden={contextState.held||undefined}>
      {(bundle.session.workspace.workspace.status==='archived'||bundle.session.actor.role==='viewer')&&<div className="workspace-readonly" role="status"><LockKeyhole size={16}/><span>{bundle.session.workspace.workspace.status==='archived'?'Archived workspace · saved evidence is readable. Restore it in Manage before starting new work.':'Viewer access · saved evidence is readable. Ask an owner for investigation access to make changes.'}</span><button className="button" onClick={event=>{event.currentTarget.focus({preventScroll:true});setWorkspaceOpen(true);}}>Workspace details</button></div>}
      <div className="page-heading"><div><div className="breadcrumb"><span>{bundle.session.workspace.workspace.merchantName.toUpperCase()}</span><ChevronRight size={11}/><span>{nav.find(n=>n[0]===view)?.[1].toUpperCase()}</span></div><h1>{view==='incident'?'See the whole story.':view==='overview'?'A pulse on your business.':view==='recovery'?'Recover with intention.':view==='disputes'?'Every case, accounted for.':'A record you can return to.'}</h1><p>{view==='incident'?'One signal. Every perspective. A clearer next move.':view==='overview'?'The evidence behind what is changing, and where to look next.':view==='recovery'?'Exact eligibility, visible exclusions, and a decision you own.':view==='disputes'?'Evidence and provider state, kept separate from assumptions.':'Revisit the evidence, decisions and changes that shaped this workspace.'}</p></div><div className="heading-actions"><button className="button" data-focus-return="finding-library" onClick={event=>{event.currentTarget.focus({preventScroll:true});setFindingsOpen('');}} disabled={contextState.held}><Search size={15}/><span>Findings</span></button><button className="button" data-focus-return="report-library" onClick={event=>{event.currentTarget.focus({preventScroll:true});setReportsOpen(true);}} disabled={contextState.held}><FileText size={15}/><span>Saved reports</span></button><span className="story-date"><Clock3 size={13}/>STORY WEEK<span>NOV 02—06, 2026</span></span><button className={'button agent-launch '+(agentOpen?'active':'')} aria-label={agentOpen?'Close Glasshouse agents':'Ask Glasshouse agents'} aria-expanded={agentOpen} onClick={()=>setAgentOpen(!agentOpen)}><Sparkles size={15}/><span>{agentOpen?'Agents open':'Ask Glasshouse'}</span></button></div></div>
      <div className="metric-strip"><Metric label="CAPTURED VALUE" value={money(snapshot.totals.capturedMinor,currency)} note={`${snapshot.totals.captures} payment records`} className="mint"/><Metric label="ORDERS IN VIEW" value={snapshot.totals.orders.toLocaleString()} note="One row per order"/><Metric label="DELAYED ORDERS" value={snapshot.totals.affected.toString()} note={`Finding v${snapshot.context.cohortVersion} · fixture shipping`} className="rose"/><Metric label="OPEN DISPUTES" value={snapshot.totals.openDisputes.toString()} note={snapshot.sourceCoverage.providerDisputes?'Provider verified':'Sample cases · due dates unverified'} className="amber"/><div className="metric-proof"><span className="eyebrow">EVERY NUMBER HAS A SOURCE</span><button onClick={()=>setSourceOpen(true)}><span className="source-chip source-sample">{snapshot.sourceCoverage.sandboxPayments?'Mixed sources':'Sample data'}</span><ArrowUpRight size={14}/></button><span>{dateLabel(snapshot.context.asOf)} · UTC</span></div></div>
      <div className={view==='incident'?'incident-content':'incident-content view-hidden'} aria-hidden={view!=='incident'}>
        <div className="incident-banner"><span className="incident-icon"><Activity size={18}/></span><div><div className="incident-kicker"><span>ACTIVE SIGNAL</span><i/>CARRIER DELAY · PACIFIC NORTHWEST</div><h2>{snapshot.totals.affected} orders. One shared delay.</h2><p>{snapshot.removedOrderIds.length?`New source records removed ${snapshot.removedOrderIds.length} orders from this incident. Review the remaining scope before choosing a response.`:'A carrier handoff pattern needs a closer look. Start with the evidence.'}</p></div><div className="incident-banner-right"><span className="severity-pill"><i/>INVESTIGATING</span><button onClick={()=>ask('Investigate why these orders are affected. Cite the source evidence, test alternative explanations, and have the Widget agent add a useful regional comparison.')}>Why these orders?<ArrowUpRight size={16}/></button></div></div>
        <div className="workspace-toolbar"><div className="workspace-label"><Layers3 size={15}/><strong>Your investigation</strong><span className="cohort-pill">{selectedCount??snapshot.totals.orders} in selection</span><button className="icon-button" aria-label="Clear all shared selections" onClick={()=>{if(studioApi){const state=studioApi.getState();studioApi.setState({...state,pages:state.pages.map(p=>({...p,crossFilter:undefined}))});}notify('Shared selection cleared.');}}><Filter size={13}/></button></div><div><span className={'snapshot-indicator '+(snapshotBusy||committed!==snapshot.hash?'updating':'')}><i/>{snapshotBusy||committed!==snapshot.hash?'Joining snapshot':'Snapshot aligned'}</span><button className="toolbar-button" aria-label="Undo layout change" title="Undo layout change" disabled={writeHeld||historyStatus?.state!=='restored'||!studioHistory?.undo.length} onClick={()=>studioApi?.undo()}><Undo2 size={14}/><span>Undo</span></button><button className="toolbar-button" aria-label="Redo layout change" title="Redo layout change" disabled={writeHeld||historyStatus?.state!=='restored'||!studioHistory?.redo.length} onClick={()=>studioApi?.redo()}><Redo2 size={14}/><span>Redo</span></button><button className={'toolbar-button '+(editable?'active':'')} aria-label={editable?'Finish editing the workspace':'Customize the workspace'} aria-pressed={editable} disabled={writeHeld} onClick={()=>setEditable(!editable)}><Settings2 size={14}/><span>{editable?'Finish editing':'Customize'}</span></button><button className="toolbar-button" aria-label="Save workspace and history" disabled={writeHeld||historyStatus?.state!=='restored'} onClick={saveLayout}><CheckCheck size={14}/><span>Save</span></button></div></div>
        <div className={'workspace-history-status '+(historyStatus?.state==='unavailable'?'is-unavailable':'')} role="status"><History size={14}/>{historyStatus?.state==='restored'?`${studioHistory?.undo.length??0} changes to undo · ${studioHistory?.redo.length??0} to redo · workspace history restored`:historyStatus?.state==='unavailable'?'Your saved workspace is preserved. Its imported history could not be verified; saving is held.':'Checking saved workspace history…'}</div>
        {historySaveError&&<div className="workspace-save-recovery" role="alert"><div><strong>Your workspace changes are held.</strong><p>{historySaveError}</p></div><div><button className="button" onClick={()=>void historyActions.current?.retry().catch(error=>notify(error.message,'error'))}>Retry original save</button><button className="button" onClick={()=>{if(!studioApi)return;const link=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(studioApi.getHistory(),null,2)],{type:'application/json'}));link.href=url;link.download='glasshouse-local-workspace.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>Export local changes</button><button className="button" onClick={()=>location.reload()}>Reload saved workspace</button></div></div>}
        <StudioWorkspace snapshot={snapshot} license={bundle.session.studioLicense} bridge={bridge} editable={editable&&!writeHeld} readOnly={writeHeld} history={bundle.history} historyVersion={bundle.historyVersion} onSaveReady={actions=>{historyActions.current=actions;}} onSaved={(history,historyVersion)=>setBundle(previous=>previous?{...previous,history,historyVersion}:previous)} onSaveError={setHistorySaveError} onHarness={setHarness} onCommitted={onCommitted} onHistoryStatus={status=>{historyVerified.current=status.state==='restored';setHistoryStatus(status);}}/>
        <div className="workspace-foot"><span><ShieldCheck size={12}/>All six instruments share one immutable snapshot.</span><code title={snapshot.hash}>{snapshot.hash.slice(0,12)}</code><button onClick={()=>setSourceOpen(true)}>Source & clock details<ArrowUpRight size={12}/></button></div>
      </div>
      {view==='overview'&&<Overview snapshot={snapshot} onIncident={()=>navigate('incident')} onSources={()=>setSourceOpen(true)}/>}
      {view==='recovery'&&<Recovery snapshot={snapshot} plans={plans} operations={operations} onBranch={setBranchId} onPlan={setSelectedPlan} onOrder={setOrderId} onAsk={()=>ask('Compare targeted and comprehensive recovery at the current snapshot. Explain the exact grace, dispute, prior-remedy and balance exclusions. Prepare the targeted branch under a $300 cap for human review.')}/>}
      {view==='disputes'&&<Disputes snapshot={snapshot} onOrder={setOrderId} onPlan={()=>{navigate('recovery');setBranchId('targeted');}}/>}
      {view==='history'&&<HistoryView audit={audit} plans={plans} events={events} studioHistory={studioHistory} onRefresh={()=>void refreshRecords()} onPlan={setSelectedPlan} onRestore={()=>{navigate('incident');notify('Your latest durable report and undo history are active.');}}/>}
      <footer className="app-footer"><span className="footer-wordmark">glasshouse</span><p>See clearly. Act carefully.</p><button onClick={()=>setHelpOpen(true)}>A field guide to Glasshouse<ArrowUpRight size={12}/></button><span>Built with AG Studio & PayPal</span></footer>
    </main>
    <AgentRail onFindings={()=>setFindingsOpen('')} harness={harness} open={agentOpen} onClose={()=>setAgentOpen(false)} snapshot={snapshot} events={events} prompt={agentPrompt} clearPrompt={()=>setAgentPrompt(null)} aiAvailable={bundle.session.capabilities.ai.available&&!writeHeld} onReviewPlan={id=>{void api<RecoveryPlan[]>('plans').then(rows=>{setPlans(rows);const plan=rows.find(row=>row.id===id);if(plan)setSelectedPlan(plan);else notify('This exact proposal is no longer available.','error');}).catch(error=>notify(error.message,'error'));}}/>
    {notice&&<div className={'toast '+notice.tone} role="status">{notice.tone==='error'?<TriangleAlert size={17}/>:notice.tone==='good'?<Check size={17}/>:<Activity size={17}/>}<span>{notice.text}</span><button onClick={()=>setNotice(null)} aria-label="Dismiss notification"><X size={14}/></button></div>}
    {findingsOpen!==null&&!contextState.held&&<FindingLibrary key={bundle.session.actor.tenantId+':'+bundle.session.actor.id} workspaceId={bundle.session.actor.tenantId} actorId={bundle.session.actor.id} snapshot={snapshot} readOnly={writeHeld} initialFindingId={findingsOpen||undefined} onClose={()=>setFindingsOpen(null)} onChanged={refreshRecords} onOrder={setOrderId} onCorrection={onFindingCorrection} onPlan={(id,current)=>{void api<{plan:RecoveryPlan}>('plans/'+id+'/review').then(result=>{if(current())setSelectedPlan(result.plan);}).catch(error=>{if(current())notify(error.message,'error');});}}/>}
    {correctionMoment&&findingsOpen===null&&!contextState.held&&<div className="finding-correction-moment" role="status"><strong>63 → 54</strong><div><p>The sources changed the scope.</p><small>All nine removed IDs are preserved in the finding. {correctionMoment.stalePlanIds.length} affected plans need a new review.</small></div><button className="icon-button" aria-label="Dismiss source correction" onClick={()=>setCorrectionMoment(null)}><X size={17}/></button></div>}
    {reportsOpen&&!contextState.held&&<ReportLibrary workspaceId={bundle.session.actor.tenantId} actorId={bundle.session.actor.id} readOnly={writeHeld} plans={plans} onClose={()=>setReportsOpen(false)} onPrepare={prepareEdition}/>}
    {workspaceOpen&&<WorkspaceDirectoryDialog initialIdentity={bundle.session.workspace.identity} onDirectory={updateDirectory} onClose={()=>setWorkspaceOpen(false)}/>}
    {searchOpen&&!contextState.held&&<SearchDialog snapshot={snapshot} onClose={()=>setSearchOpen(false)} onOrder={id=>{setOrderId(id);setSearchOpen(false);}}/>}
    {sourceOpen&&!contextState.held&&<SourceDialog snapshot={snapshot} capabilities={bundle.session.capabilities} actor={bundle.session.actor} onClose={()=>setSourceOpen(false)} onKnowledge={known=>{void changeSnapshot(snapshot.context.asOf,known);setSourceOpen(false);}}/>}
    {helpOpen&&<HelpDialog onClose={()=>setHelpOpen(false)} onBegin={()=>{setHelpOpen(false);navigate('incident');}}/>}
    {orderId&&!contextState.held&&<OrderDrawer id={orderId} snapshot={snapshot} onClose={()=>setOrderId(null)}/>}
    {branchId&&!contextState.held&&<BranchDialog key={branchId+':'+snapshot.hash} readOnly={writeHeld} branch={snapshot.branches.find(b=>b.id===branchId)!} snapshot={snapshot} onClose={()=>setBranchId(null)} onPrepare={newPlan} onPrepared={plan=>{setPlans(rows=>[plan,...rows.filter(row=>row.id!==plan.id)]);setSelectedPlan(plan);setBranchId(null);void refreshRecords().catch(error=>notify(error.message,'error'));}} onOrder={setOrderId}/>}
    {selectedPlan&&!contextState.held&&<PlanDialog canAuthorize={!writeHeld&&['owner','operator','judge'].includes(bundle.session.actor.role)} key={selectedPlan.id+':'+selectedPlan.hash} plan={selectedPlan} operations={operations.filter(o=>o.planId===selectedPlan.id)} onClose={()=>setSelectedPlan(null)} onApprove={approve} onExecute={execute} onOrder={setOrderId} onRefresh={refreshRecords} onLatestEvidence={async()=>{await changeSnapshot(snapRef.current?.context.asOf);await refreshRecords();notify('The investigation now uses the latest independently observed evidence. The saved manifest is unchanged.','good');}}/>}
  </div>;
}

function Logo(){return <a className="logo" href="/" aria-label="Glasshouse home"><span className="logo-mark"><i/><i/><i/><i/></span><span>glasshouse<span className="logo-period">.</span></span></a>;}
function Metric({label,value,note,className=''}:{label:string;value:string;note:string;className?:string}){return <div className={'metric '+className}><span className="eyebrow">{label}</span><strong>{value}</strong><span>{note}</span></div>;}

function Overview({snapshot,onIncident,onSources}:{snapshot:Snapshot;onIncident():void;onSources():void}){
  return <div className="overview-page"><div className="section-heading"><div><span className="eyebrow">SIGNAL WATCH</span><h2>What deserves your attention.</h2></div><span className="quiet-label">Deterministic detectors · stated baselines</span></div><div className="detector-grid">{snapshot.detectors.map((d,i)=><article key={d.id} className={'detector-card '+d.status}><div className="detector-top"><span className="detector-num">0{i+1}</span><span className={'status-label '+d.status}>{d.status.replaceAll('_',' ')}</span></div><h3>{d.title}</h3><p>{d.explanation}</p><div className="detector-measure"><strong>{d.currentDenominator?Math.round(d.currentNumerator/d.currentDenominator*100)+'%':'—'}</strong><span>{d.currentNumerator} / {d.currentDenominator}<br/>current observations</span></div><div className="detector-baseline"><span>Baseline {d.baselineNumerator}/{d.baselineDenominator}</span><span>Threshold {d.threshold}</span></div><div className="detector-bottom"><span>{d.formulaVersion} · {sourceLabel(d.sourceClass)}</span><button onClick={d.kind==='carrier_delay'?onIncident:onSources}>{d.status==='detected'?'Investigate signal':'Inspect coverage'}<ArrowUpRight size={15}/></button></div></article>)}</div><div className="overview-bottom"><div className="editorial-card"><span className="eyebrow">A NOTE ON THE PICTURE</span><h2>Context is what turns<br/>a number into a fact.</h2><p>A captured payment, a delivery scan and a support message tell different parts of the story. Glasshouse keeps their origins and clocks visible.</p><button className="text-action" onClick={onSources}>See the source ledger<ArrowUpRight size={16}/></button></div><div className="coverage-card"><h3>What is in this workspace</h3>{[['Payment records',snapshot.sourceCoverage.samplePayments,'Sample'],['Verified sandbox payments',snapshot.sourceCoverage.sandboxPayments,'Live · Sandbox'],['Shipping observations',snapshot.sourceCoverage.fixtureShipments,'Fixture shipping'],['Provider dispute records',snapshot.sourceCoverage.providerDisputes,'Live · Sandbox']].map(([label,count,source])=><div key={label}><span>{label}</span><strong>{count}</strong><small>{source}</small></div>)}</div></div></div>;
}

function Recovery({snapshot,plans,operations,onBranch,onPlan,onOrder,onAsk}:{snapshot:Snapshot;plans:RecoveryPlan[];operations:Operation[];onBranch(id:string):void;onPlan(p:RecoveryPlan):void;onOrder(id:string):void;onAsk():void}){
  const eligible=snapshot.branches.find(b=>b.id==='targeted');
  return <div className="recovery-page"><div className="section-heading"><div><span className="eyebrow">GOODWILL, WITH GUARDRAILS</span><h2>Choose the response that fits.</h2></div><button className="button" onClick={onAsk}><Sparkles size={14}/>Ask the Planner</button></div><div className="recovery-layout"><div className="recovery-main"><div className="recovery-cards">{snapshot.branches.map((b,i)=><article className={'full-branch '+(i===0?'recommended':'')} key={b.id}><div className="branch-caption"><span className="branch-letter">{i===0?'A':'B'}</span><span>{i===0?'Targeted goodwill':'No grace window'}</span>{i===0&&<span className="recommended-label">POLICY MATCH</span>}</div><h3>{money(b.refundTotalMinor)}</h3><p>{b.eligibleCount} eligible orders × $5</p><div className="full-branch-rule">{b.graceHours?`${b.graceHours}+ hours past the delivery promise`:'No delivery grace window'}</div><ul><li><Check size={13}/>Undelivered at the snapshot</li><li><Check size={13}/>No open dispute</li><li><Check size={13}/>No prior refund or goodwill credit</li><li><Check size={13}/>At least $5 refundable balance</li></ul><div className="branch-companion"><Truck size={14}/>{b.trackingCount} tracking updates<span>·</span>{b.disputeCount} dispute responses</div><button className={'button '+(i===0?'primary':'')} data-focus-return={'branch-'+b.id} disabled={!b.actions.length} onClick={()=>onBranch(b.id)}>{b.actions.length?'Review exact actions':'No outstanding actions'}<ArrowRight size={15}/></button></article>)}</div><div className="policy-exclusions"><h3>The exclusions are part of the decision.</h3><p>Open any order to inspect the source evidence and individual policy conditions.</p><div>{snapshot.orders.filter(o=>o.incidentMember&&(o.disputeOpen||o.seedGroup==='grace'||o.seedGroup==='delivered_revision')).slice(0,8).map(o=><button key={o.id} onClick={()=>onOrder(o.id)}><span>{o.reference}</span><span>{o.disputeOpen?'Open dispute':o.fulfillmentState==='delivered'?'Delivered':'Inside grace window'}</span><ArrowUpRight size={13}/></button>)}</div></div></div><aside className="policy-card"><div className="policy-seal"><ShieldCheck size={25}/></div><span className="eyebrow">THE POLICY</span><h3>A small gesture.<br/>An exact decision.</h3><p>Eligibility is computed from the current evidence. AI can explain it and prepare a proposal. You approve the exact manifest.</p><dl><div><dt>Policy</dt><dd>goodwill-delay-v1</dd></div><div><dt>Refund per order</dt><dd>$5.00 USD</dd></div><div><dt>Default cap</dt><dd>$300.00 USD</dd></div><div><dt>Approval window</dt><dd>30 minutes</dd></div><div><dt>Source cohort</dt><dd>v{snapshot.context.cohortVersion}</dd></div></dl><div className="policy-source-note"><LockKeyhole size={15}/><p>Sample records can be reviewed as a rehearsal. Only scoped, verified provider resources can produce real payment outcomes.</p></div></aside></div><div className="section-heading"><div><span className="eyebrow">SAVED DECISIONS</span><h2>Every manifest has a history.</h2></div><span className="quiet-label">{plans.length} saved · {operations.length} action outcomes</span></div>{plans.length?<div className="saved-plans">{plans.map(p=><button key={p.id} onClick={()=>onPlan(p)}><span className="saved-plan-icon"><GitBranch size={19}/></span><span><strong>{p.branch.name}</strong><small>{dateLabel(p.createdAt)} · source cohort v{p.cohortVersion} · {p.executionMode==='sample'?'Rehearsal':'Sandbox'}</small></span><span className={'status-label '+p.status}>{p.status.replaceAll('_',' ')}</span><span className="saved-plan-total">{money(p.branch.refundTotalMinor)}<small>{p.branch.actions.length} actions</small></span><ChevronRight size={16}/></button>)}</div>:<Empty icon={GitBranch} title="Your first decision starts with a review." text={`The targeted branch currently proposes ${eligible?.eligibleCount||0} refunds. Open it to inspect every condition and action.`}/>}</div>;
}

function Disputes({snapshot,onOrder,onPlan}:{snapshot:Snapshot;onOrder(id:string):void;onPlan():void}){
  const cases=snapshot.orders.filter(o=>o.disputeOpen);
  return <div className="disputes-page"><div className="case-notice"><ShieldCheck size={19}/><div><strong>Dispute state comes from the provider.</strong><p>A tracking update or refund does not resolve a case. Unknown deadlines remain unknown.</p></div><button className="button" onClick={onPlan}>Review response plan<ArrowUpRight size={14}/></button></div><div className="section-heading"><h2>Open cases<span className="inline-count">{cases.length}</span></h2><span className="quiet-label">No invented countdowns</span></div><div className="case-grid">{cases.map((o,i)=><article className="case-card" key={o.id}><div className="case-card-top"><span><FileText size={16}/>CASE 0{i+1}</span><span className="source-chip">{sourceLabel(o.disputeSource)}</span></div><h3>{o.reference}</h3><p>{o.customerAlias} · {o.region}</p><div className="case-reason">Item not received</div><dl><div><dt>Order amount</dt><dd>{money(o.amountMinor)}</dd></div><div><dt>Case state</dt><dd>{o.disputeState?.replaceAll('_',' ')||'Not verified'}</dd></div><div><dt>Response deadline</dt><dd className="amber-text">{o.disputeSource==='sandbox'?(o.disputeDueAt?dateLabel(o.disputeDueAt):o.disputeState==='waiting_for_buyer_response'?'Awaiting buyer response':'Not supplied by PayPal'):'Unverified'}</dd></div><div><dt>Evidence source</dt><dd>Fixture shipping</dd></div></dl><div className="case-footer"><span><LockKeyhole size={12}/>Refund excluded by policy</span><button data-focus-return={'order-'+o.id} onClick={event=>{event.currentTarget.focus({preventScroll:true});onOrder(o.id);}}>Open evidence<ArrowUpRight size={14}/></button></div></article>)}</div>{!cases.length&&<Empty icon={ShieldCheck} title="No open cases in this snapshot." text="Try a later story time, or return to the incident room to change the shared context."/>}</div>;
}

function HistoryView({audit,plans,events,studioHistory,onRefresh,onPlan,onRestore}:{audit:AuditRow[];plans:RecoveryPlan[];events:AgentRunEvent[];studioHistory:AgReportHistory<GlasshouseRegistry>|null;onRefresh():void;onPlan(p:RecoveryPlan):void;onRestore():void}){
  return <div className="history-page"><div className="history-summary"><article><span className="eyebrow">WORKSPACE MEMORY</span><strong>{studioHistory?.undo.length||0}</strong><p>Undoable report changes</p><button onClick={onRestore}>Return to saved workspace<ArrowUpRight size={14}/></button></article><article><span className="eyebrow">DECISION RECORD</span><strong>{plans.length}</strong><p>Exact recovery manifests</p></article><article><span className="eyebrow">AGENT ACTIVITY</span><strong>{events.length}</strong><p>Observed lifecycle events</p></article></div><div className="section-heading"><div><span className="eyebrow">DURABLE AUDIT TRAIL</span><h2>What changed, and why.</h2></div><button className="button" onClick={onRefresh}><RefreshCw size={14}/>Refresh record</button></div><div className="audit-list">{audit.length?audit.map(e=><article key={e.sequence} className="audit-row"><div className="audit-track"><span><History size={13}/></span></div><div><span className="audit-type">{e.type.replaceAll('.',' / ').replaceAll('_',' ')}</span><h3>{e.summary}</h3><p>{dateLabel(e.timestamp)} UTC · {e.actorId.slice(0,16)}</p>{e.refId&&plans.some(p=>p.id===e.refId)&&<button className="text-action" onClick={()=>onPlan(plans.find(p=>p.id===e.refId)!)}>Inspect exact manifest<ArrowUpRight size={13}/></button>}<details><summary>Record details</summary><pre>{JSON.stringify(e.data,null,2)}</pre></details></div><span className="audit-sequence">#{e.sequence}</span></article>):<Empty icon={History} title="The record starts here." text="Evidence revisions, plans, approvals, workspace edits and live model turns appear here as they happen."/>}</div></div>;
}

function Empty({icon:Icon,title,text}:{icon:typeof Activity;title:string;text:string}){return <div className="empty-state"><Icon size={27}/><h3>{title}</h3><p>{text}</p></div>;}

export function Modal({title,eyebrow,onClose,children,wide=false,returnFocusKey,contentKey,initialFocus='heading'}:{title:string;eyebrow:string;onClose():void;children:React.ReactNode;wide?:boolean;returnFocusKey?:string;contentKey?:string;initialFocus?:'heading'|'native'}){
  const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null),titleId=useId();
  useDialogFocus(dialog,{heading,returnFocusKey,contentKey,initialFocus});
  return <dialog ref={dialog} aria-labelledby={titleId} className={'modal '+(wide?'wide':'')} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal-content"><header className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></header>{children}</div></dialog>;
}

function SearchDialog({snapshot,onClose,onOrder}:{snapshot:Snapshot;onClose():void;onOrder(id:string):void}){
  const [query,setQuery]=useState('');
  const results=snapshot.orders.filter(o=>[o.reference,o.customerAlias,o.region,o.product,o.id].some(v=>v.toLowerCase().includes(query.toLowerCase()))).slice(0,12);
  return <Modal initialFocus="native" eyebrow="FIND THE RECORD" title="A fact is never far away." onClose={onClose}><label className="search-box"><Search size={19}/><input autoFocus aria-label="Search orders, customer aliases or regions" placeholder="Order, customer alias or region…" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>ESC</kbd></label><div className="search-results">{results.map(o=><button key={o.id} onClick={()=>onOrder(o.id)}><span className="order-mini-icon"><FileText size={16}/></span><span><strong>{o.reference}</strong><small>{o.customerAlias} · {o.region}</small></span><span>{money(o.amountMinor)}</span><ArrowUpRight size={14}/></button>)}{!results.length&&<Empty icon={Search} title="No matching records." text="Try an order reference, an alias or a region from this snapshot."/>}</div><p className="modal-footnote">Search is scoped to this workspace and the current time.</p></Modal>;
}

function SourceDialog({snapshot,capabilities,actor,onClose,onKnowledge}:{snapshot:Snapshot;capabilities:Capabilities;actor:Actor;onClose():void;onKnowledge(k?:string):void}){
  return <Modal wide eyebrow="SOURCE & CLOCK LEDGER" title="Know what you are looking at." returnFocusKey="workspace-sources" onClose={onClose}><div className="source-explainer">{[['sample','Sample payments','Deterministic commerce records. No provider transaction is implied.'],['fixture_shipping','Fixture shipping','Explicit narrative scans for the incident. Independent from payment state.'],['sandbox','Live · Sandbox','Only recorded provider responses can use this source label.'],['modelled','Modelled','A counterfactual or estimate. Never a booked payment.']].map(([s,t,d])=><div key={s}><span className={'source-chip source-'+s}>{t}</span><p>{d}</p></div>)}</div><div className="clock-facts"><div><span>As of · business time T</span><strong>{dateLabel(snapshot.context.asOf)} UTC</strong></div><div><span>Known at · evidence cutoff K</span><strong>{dateLabel(snapshot.context.knownAt)} UTC</strong></div><div><span>Clock domain</span><strong>{snapshot.context.clockDomain.replaceAll('_',' ')}</strong></div><div><span>Snapshot</span><code>{snapshot.hash.slice(0,24)}</code></div></div><div className="knowledge-actions"><span className="eyebrow">RECONSTRUCT WHAT WAS KNOWN</span><button className="button" onClick={()=>onKnowledge('2026-11-06T10:00:00.000Z')}>Before delivery updates</button><button className="button" onClick={()=>onKnowledge('2026-11-06T10:05:00.000Z')}>After delivery updates</button><button className="button" onClick={()=>onKnowledge()}>Latest known evidence</button></div><div className="connection-details"><h3>Workspace connections</h3>{[['Storage',capabilities.storage.type,true],['AG Studio',`v${capabilities.studio.version} · 6 custom instruments`,true],['Live AI',capabilities.ai.model,capabilities.ai.available],['PayPal Sandbox',capabilities.paypal.reason,capabilities.paypal.available],['Refund execution',capabilities.refunds.reason,capabilities.refunds.available],['Tracking assignments',capabilities.tracking.reason,capabilities.tracking.available],['Dispute responses',capabilities.disputes.reason,capabilities.disputes.available]].map(([a,b,c])=><div key={String(a)}><span><i className={c?'live':'pending'}/>{a}</span><small>{b}</small></div>)}</div><ObservationHealth/><ReportingStatus/><p className="modal-footnote">Access: {actor.role} · isolated session · data belongs to your workspace. Provider timestamps are preserved separately from the story clock.</p></Modal>;
}

function HelpDialog({onClose,onBegin}:{onClose():void;onBegin():void}){return <Modal eyebrow="A FIELD GUIDE" title="Look closer. Decide better." onClose={onClose}><div className="help-steps">{[['01','Follow the river','Click a fulfillment state or region. Studio highlights that same selection across the evidence, map and recovery instruments.'],['02','Turn back the clock','The Time Dial reconstructs payment, shipping, remediation and dispute state at one shared point in time.'],['03','Let evidence change the story','Ingest the nine delivery updates in the Evidence Lens. Source changes update findings and hold affected, unstarted recovery manifests.'],['04','Choose an exact response','Compare fixed policy branches. Review every action and exclusion before approving. Sample actions show their unmet provider requirements.'],['05','Ask the agents','The Coordinator delegates real work to the Investigator, Planner and Studio Widget agent. Their actual tool outcomes and workspace edits are saved.']].map(([n,t,d])=><div key={n}><span>{n}</span><div><h3>{t}</h3><p>{d}</p></div></div>)}</div><div className="help-shortcuts"><span><kbd>⌘ K</kbd> Find an order</span><span><kbd>ESC</kbd> Close a dialog</span><span><kbd>Tab</kbd> Explore every control</span></div><button className="button primary full-width" onClick={onBegin}>Enter the incident room<ArrowRight size={15}/></button></Modal>;}

function OrderDrawer({id,snapshot,onClose}:{id:string;snapshot:Snapshot;onClose():void}){
  const [detail,setDetail]=useState<OrderDetail|null>(null);
  const [error,setError]=useState<string|null>(null),[retry,setRetry]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null),titleId=useId();
  useDialogFocus(dialog,{returnFocusKey:'order-'+id,initialFocus:'native'});
  useEffect(()=>{
    const controller=new AbortController();let active=true;setDetail(null);setError(null);
    void api<OrderDetail>('orders/'+encodeURIComponent(id)+'?snapshotHash='+encodeURIComponent(snapshot.hash),undefined,undefined,controller.signal)
      .then(value=>{if(!active)return;if(value.snapshotHash!==snapshot.hash||value.order.id!==id)throw new Error('The evidence does not match this investigation snapshot.');setDetail(value);})
      .catch(error=>{if(active&&error instanceof Error&&error.name!=='AbortError')setError(error.message);});
    return()=>{active=false;controller.abort();};
  },[id,snapshot.hash,retry]);
  const order=snapshot.orders.find(order=>order.id===id);
  return <dialog ref={dialog} aria-labelledby={titleId} className="order-drawer" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="drawer-content">
      <header><button className="text-action" onClick={onClose}><ArrowLeft size={15}/>Back to the story</button><button className="icon-button" aria-label="Close order" onClick={onClose}><X size={19}/></button></header>
      <span className="eyebrow">THE SOURCE RECORD</span><h2 id={titleId}>{order?.reference||'Order outside this snapshot'}</h2><p className="drawer-subtitle">{order?.customerAlias}{order?' · ':''}{order?.region}</p>
      {error&&<div className="inline-error" role="alert"><p>{error}</p><button className="button" onClick={()=>setRetry(value=>value+1)}>Retry evidence read<RefreshCw size={15}/></button></div>}
      {!detail&&!error&&<div className="drawer-loading" role="status"><LoaderCircle className="spin" size={20}/>Reading evidence at this exact cutoff…</div>}
      {detail&&<OrderRecord key={detail.snapshotHash+':'+id} detail={detail} snapshot={snapshot}/>}
      <footer><code>{id}</code><span>Snapshot {snapshot.hash.slice(0,10)}</span></footer>
    </div>
  </dialog>;
}

export function BranchDialog({branch,snapshot,onClose,onPrepare,onPrepared,onOrder,readOnly}:{readOnly:boolean;branch:RecoveryBranch;snapshot:Snapshot;onClose():void;onPrepare(b:string,budget:number,findings?:FindingReference[]):Promise<RecoveryPlan>;onPrepared(plan:RecoveryPlan):void;onOrder(id:string):void}){
  const [cap,setCap]=useState('300');const [selectedFindings,setSelectedFindings]=useState<FindingReference[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [tab,setTab]=useState('actions');
  const lock=useRef<object|null>(null),begin=useDialogRequestBoundary((branch?.id??'')+':'+snapshot.hash);
  useEffect(()=>{lock.current=null;setBusy(false);setError(null);},[branch?.id,snapshot.hash]);
  if(!branch)return null;
  const capMinor=Math.round(Number(cap)*100);const within=Number.isFinite(capMinor)&&capMinor>=branch.refundTotalMinor;
  const prepare=async()=>{if(lock.current||readOnly||!within)return;const current=begin();if(!current())return;const request={};lock.current=request;setBusy(true);setError(null);try{const plan=await onPrepare(branch.id,capMinor,selectedFindings);if(current()&&lock.current===request)onPrepared(plan);}catch(e){if(current()&&lock.current===request)setError((e as Error).message);}finally{if(lock.current===request){lock.current=null;if(current())setBusy(false);}}};
  return <Modal eyebrow={`PROPOSED RECOVERY · SOURCE COHORT v${snapshot.context.cohortVersion}`} title={branch.id==='targeted'?'A targeted gesture.':'A broader gesture.'} returnFocusKey={'branch-'+branch.id} onClose={onClose} wide><div className="review-intro"><div><span className="eyebrow">PROPOSED REFUND TOTAL</span><strong>{money(branch.refundTotalMinor)}</strong><span>{branch.eligibleCount} refunds × $5.00 USD</span></div><div><span className="eyebrow">COMPANION ACTIONS</span><strong>{branch.trackingCount+branch.disputeCount}</strong><span>{branch.trackingCount} tracking · {branch.disputeCount} dispute responses</span></div><label className="budget-input">Refund cap<span>$<input type="number" min="0" max="1000" step="5" value={cap} onChange={e=>setCap(e.target.value)}/><em>USD</em></span><small className={within?'mint-text':'rose-text'}>{within?money(capMinor-branch.refundTotalMinor)+' below cap':'This branch exceeds the cap'}</small></label></div><div className="review-source-note"><ShieldCheck size={17}/><p>This is a proposed manifest. Source labels and provider requirements are preserved for every action. Preparing it does not approve or execute money.</p></div><FindingSelector value={selectedFindings} onChange={setSelectedFindings} disabled={readOnly||busy}/><div className="drawer-tabs"><button className={tab==='actions'?'active':''} onClick={()=>setTab('actions')}>Exact actions ({branch.actions.length})</button><button className={tab==='eligibility'?'active':''} onClick={()=>setTab('eligibility')}>Policy conditions ({branch.rows.length})</button></div>{tab==='actions'?<ActionTable actions={branch.actions} onOrder={onOrder}/>:<EligibilityTable branch={branch} snapshot={snapshot} onOrder={onOrder}/>}{error&&<div className="inline-error">{error}</div>}<div className="modal-actions"><span>{branch.policyId} · expires 30 minutes after preparation</span><button className="button primary" disabled={readOnly||!within} aria-disabled={busy||undefined} onClick={prepare}>{busy?<LoaderCircle className="spin" size={15}/>:<FileText size={15}/>}Prepare exact manifest<ArrowRight size={14}/></button></div></Modal>;
}

export function PlanDialog({plan:initialPlan,operations,onClose,onApprove,onExecute,onOrder,onRefresh,onLatestEvidence,canAuthorize}:{canAuthorize:boolean;plan:RecoveryPlan;operations:Operation[];onClose():void;onApprove(p:RecoveryPlan,fixtureAcknowledged:boolean):Promise<RecoveryPlan>;onExecute(p:RecoveryPlan):Promise<void>;onOrder(id:string):void;onRefresh():Promise<void>;onLatestEvidence():Promise<void>}){
  const [ack,setAck]=useState(false),[fixtureAck,setFixtureAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [review,setReview]=useState<{plan:RecoveryPlan;dependencies:PlanDependencyReview}|null>(null),[checking,setChecking]=useState(true);
  const begin=useDialogRequestBoundary(initialPlan.id+':'+initialPlan.hash),readGeneration=useRef(0),reading=useRef<number|null>(null),actionLock=useRef(false);
  const loadReview=useCallback(async()=>{const current=begin(),generation=++readGeneration.current;if(!current())return;reading.current=generation;setChecking(true);setError(null);try{const value=await api<{plan:RecoveryPlan;dependencies:PlanDependencyReview}>('plans/'+initialPlan.id+'/review');if(current()&&generation===readGeneration.current)setReview(value);return value;}catch(error){if(current()&&generation===readGeneration.current){setReview(null);setError(error instanceof Error?error.message:'The current dependency review could not complete.');}throw error;}finally{if(current()&&generation===readGeneration.current){reading.current=null;setChecking(false);}}},[begin,initialPlan.id,initialPlan.hash,initialPlan.status]);
  useEffect(()=>{void loadReview().catch(()=>{});return()=>{readGeneration.current++;};},[loadReview]);
  const plan=review?.plan??initialPlan,currentDependencies=!!review?.dependencies.valid&&!checking;

  const run=async(kind:'approve'|'execute')=>{if(actionLock.current||!canAuthorize||!currentDependencies)return;const current=begin();if(!current())return;actionLock.current=true;setBusy(true);setError(null);try{kind==='approve'?await onApprove(plan,fixtureAck):await onExecute(plan);}catch(e){if(current())setError((e as Error).message);}finally{actionLock.current=false;if(current())setBusy(false);}};
  const stale=['stale','expired'].includes(plan.status),sandbox=plan.executionMode==='sandbox';
  const verified=operations.filter(operation=>operation.status==='provider_success').length;
  const held=operations.filter(operation=>['blocked','provider_failed','unknown_outcome'].includes(operation.status)).length;
  const verifiedMinor=operations.filter(operation=>operation.kind==='refund'&&operation.status==='provider_success').reduce((sum,operation)=>sum+operation.amountMinor,0);
  return <Modal eyebrow={`EXACT MANIFEST · ${sandbox?'SANDBOX':'REHEARSAL'}`} title={stale?'The evidence has moved on.':plan.status==='completed'?'Every result, independently verified.':plan.status==='blocked'?'Some actions need attention.':'A decision with a receipt.'} onClose={onClose} wide>
    <div className="manifest-summary"><span className={'status-label '+plan.status}>{plan.status.replaceAll('_',' ')}</span><span>Source cohort v{plan.cohortVersion}</span><span>{plan.branch.actions.length} independent actions</span><strong>{money(plan.branch.refundTotalMinor)} proposed refunds</strong><span>{money(plan.branch.budgetMinor)} refund cap</span></div>
    {stale&&<div className="inline-warning"><TriangleAlert size={18}/><p>{plan.staleReason||'This manifest expired. Create a fresh proposal against current evidence.'}</p></div>}
    <div className="manifest-identity"><span>MANIFEST HASH</span><code>{plan.hash}</code><a href={scopedApiUrl('manifest?planId='+encodeURIComponent(plan.id))} download><Download size={14}/>Export CSV</a></div>
    {operations.length>0&&<div className="recovery-progress" role="status" aria-live="polite"><div><strong>{verified} of {plan.branch.actions.length} verified</strong><span>{money(verifiedMinor)} refunded · {held} need attention</span></div><progress max={plan.branch.actions.length} value={verified} aria-label="Independently verified recovery actions"/><p>Progress is saved. An uncertain response is reconciled from the original operation. Evidence submission and tracking do not imply delivery or a resolved dispute.</p></div>}
    {sandbox&&operations.length>0&&<ReceiptStatus planId={plan.id} operations={operations} onRefresh={onRefresh} onLatestEvidence={onLatestEvidence}/>}
    <section className="finding-dependency-review" aria-busy={checking}>
      <h3><ShieldCheck size={16}/>Current finding dependency review</h3>
      {checking?<p role="status"><LoaderCircle className="spin" size={15}/>Checking current membership and exact selected finding versions…</p>:<>
        <p>{!review?'The current review has not completed.':!review.dependencies.valid?review.dependencies.reason:plan.contractVersion!==3?'This earlier manifest retains its original approval contract.':plan.findingDependencies?.length?'The exact selected finding versions remain shared, supported and current for their source scope.':'No interpreted finding was selected; there are no interpretation dependencies to verify.'}</p>
        {!!plan.findingDependencies?.length&&<ul>{plan.findingDependencies.map(ref=><li key={ref.findingId}>{ref.findingId}<code>{ref.revisionId} · {ref.hash}</code></li>)}</ul>}
      </>}
      <div className="finding-source-binding"><p><strong>Stored source binding</strong> · cohort v{plan.cohortVersion}</p><code>{plan.snapshotHash}</code><p>{stale?'This is the historical source snapshot. This manifest is '+plan.status+' and new approval is held. Review current sources before preparing a new manifest.':'This manifest retains its exact source snapshot. Source and action eligibility are checked separately when approving or starting new work.'}</p></div>
      <button className="button" aria-disabled={checking||undefined} onClick={()=>{if(reading.current===null)void loadReview().catch(()=>{});}}><RefreshCw size={14}/>Refresh current review</button>
    </section>
    <ActionTable actions={plan.branch.actions} operations={operations} onOrder={onOrder}/>
    <div className="manifest-clock"><Clock3 size={13}/><span>Prepared {dateLabel(plan.createdAt)} · approval expires {dateLabel(plan.expiresAt)} UTC</span></div>
    {plan.status==='ready_for_review'&&<>
      <label className="approval-ack"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/><span>{sandbox?<>I approve these exact {plan.branch.actions.length} sandbox action rows, including {money(plan.branch.refundTotalMinor)} in proposed refunds, within the {money(plan.branch.budgetMinor)} cap.</>:<>I reviewed the exact {plan.branch.actions.length} action rows and {money(plan.branch.refundTotalMinor)} total. This is a <strong>sample rehearsal</strong>; provider operations require verified sandbox resources.</>}</span></label>
      {sandbox&&<label className="approval-ack"><input type="checkbox" checked={fixtureAck} onChange={e=>setFixtureAck(e.target.checked)}/><span>I reviewed the exact tracking fields and dispute statements. Shipping is <strong>synthetic sandbox evidence</strong>; these submissions make no claim that physical goods were shipped or delivered. Buyer tracking notifications are disabled.</span></label>}
    </>}
    {error&&<div className="inline-error" role="alert">{error}</div>}
    <div className="modal-actions"><span><LockKeyhole size={13}/>Approval binds to this exact hash, evidence and cohort.</span>{plan.status==='ready_for_review'?<button className="button primary" disabled={!canAuthorize||!currentDependencies||!ack||sandbox&&!fixtureAck} aria-disabled={busy||undefined} onClick={()=>run('approve')}>{busy?<LoaderCircle className="spin" size={15}/>:<ShieldCheck size={15}/>}Approve {sandbox?'exact manifest':'rehearsal'}</button>:plan.status==='approved'?<button className="button primary" disabled={!canAuthorize||!currentDependencies} aria-disabled={busy||undefined} onClick={()=>run('execute')}>{busy?<LoaderCircle className="spin" size={15}/>:<Workflow size={15}/>} {sandbox?'Start approved recovery':'Check rehearsal requirements'}</button>:<button className="button" onClick={onClose}>Return to recovery<ArrowRight size={14}/></button>}</div>
  </Modal>;
}

function ActionEvidence({action}:{action:ActionRow}){
  if(action.kind==='refund')return null;
  return <details className="manifest-evidence"><summary>{action.kind==='dispute_response'?'Read exact evidence statement':'Read exact tracking fields'}</summary><div><p><strong>Synthetic shipping.</strong> No physical delivery is asserted.</p><dl><div><dt>Tracking</dt><dd>{String(action.payload.trackingNumber??'Unavailable')}</dd></div><div><dt>Carrier</dt><dd>{String(action.payload.carrier??'Unavailable')}</dd></div>{action.resourceId&&<div><dt>Provider resource</dt><dd><code>{action.resourceId}</code></dd></div>}</dl>{action.kind==='dispute_response'?<p>{String(action.payload.statement??'No statement has been prepared.')}</p>:<p>Assign tracking as shipped; buyer notification is disabled. This does not change the physical delivery status.</p>}</div></details>;
}

function ActionTable({actions,operations=[],onOrder}:{actions:ActionRow[];operations?:Operation[];onOrder(id:string):void}) {
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const visible=actions.filter(a=>(filter==='all'||a.kind===filter)&&a.reference.toLowerCase().includes(query.toLowerCase()));
  const byAction=new Map(operations.map(operation=>[operation.actionId,operation]));
  const label=(action:ActionRow)=>action.kind==='dispute_response'?'Dispute response':action.kind==='tracking'?'Tracking update':'Partial refund';
  const outcome=(action:ActionRow)=>{
    const operation=byAction.get(action.id);
    return {
      status:operation?operation.status.replaceAll('_',' '):action.eligibility==='blocked'?'Requires verification':'Eligible proposal',
      reason:operation?.reason||action.blockedReason||'Revalidated against current state at approval',
      providerId:operation?.providerId,
      succeeded:operation?.status==='provider_success',
    };
  };
  return <>
    <div className="action-table-toolbar">
      <div aria-label="Action type">{[['all','All actions'],['refund','Refunds'],['tracking','Tracking'],['dispute_response','Disputes']].map(([value,title])=><button key={value} aria-pressed={filter===value} className={filter===value?'active':''} onClick={()=>setFilter(value)}>{title}<span>{value==='all'?actions.length:actions.filter(a=>a.kind===value).length}</span></button>)}</div>
      <label><Search size={16}/><input placeholder="Find order…" value={query} onChange={e=>setQuery(e.target.value)} aria-label="Filter action manifest by order"/></label>
    </div>
    <p className="manifest-row-count" role="status">{visible.length} of {actions.length} exact action rows</p>
    <div className="review-table manifest-action-table"><table><thead><tr><th>Order</th><th>Action</th><th>Amount</th><th>Source</th><th>{operations.length?'Observed outcome':'Provider requirement'}</th></tr></thead><tbody>{visible.map(action=>{
      const result=outcome(action);
      return <tr key={action.id}><td><button data-focus-return={'order-'+action.orderId} onClick={event=>{event.currentTarget.focus({preventScroll:true});onOrder(action.orderId);}}>{action.reference}<ArrowUpRight size={14}/></button></td><td>{label(action)}<ActionEvidence action={action}/></td><td>{action.kind==='refund'?money(action.amountMinor,action.currency):'—'}</td><td><span className="source-chip">{sourceLabel(action.sourceClass)}</span></td><td><span className={result.succeeded?'mint-text':'amber-text'}>{result.status}</span><small>{result.reason}</small>{result.providerId&&<code>{result.providerId}</code>}</td></tr>;
    })}</tbody></table></div>
    <ol className="manifest-action-cards" aria-label="Exact action manifest">{visible.map(action=>{
      const result=outcome(action);
      return <li key={action.id}><header><button data-focus-return={'order-'+action.orderId} onClick={event=>{event.currentTarget.focus({preventScroll:true});onOrder(action.orderId);}}>{action.reference}<ArrowUpRight size={16}/></button><span className="source-chip">{sourceLabel(action.sourceClass)}</span></header><div className="action-card-value"><strong>{label(action)}</strong><span>{action.kind==='refund'?money(action.amountMinor,action.currency):'No refund amount'}</span></div><dl><div><dt>{operations.length?'Observed outcome':'Provider requirement'}</dt><dd className={result.succeeded?'mint-text':'amber-text'}>{result.status}</dd></div><div><dt>Details</dt><dd>{result.reason}</dd></div>{result.providerId&&<div><dt>Provider reference</dt><dd><code>{result.providerId}</code></dd></div>}</dl><ActionEvidence action={action}/></li>;
    })}</ol>
    {!visible.length&&<p className="table-empty">No action rows match these filters.</p>}
  </>;
}

function EligibilityTable({branch,snapshot,onOrder}:{branch:RecoveryBranch;snapshot:Snapshot;onOrder(id:string):void}) {
  const references=new Map(snapshot.orders.map(order=>[order.id,order.reference]));
  return <>
    <div className="review-table manifest-action-table"><table><thead><tr><th>Order</th><th>Undelivered</th><th>Grace</th><th>No dispute</th><th>No prior remedy</th><th>Balance</th><th>Result</th></tr></thead><tbody>{branch.rows.map(row=><tr key={row.orderId}><td><button data-focus-return={'order-'+row.orderId} onClick={event=>{event.currentTarget.focus({preventScroll:true});onOrder(row.orderId);}}>{references.get(row.orderId)}</button></td>{row.conditions.map(condition=><td key={condition.key}><span className={condition.passed?'condition-pass':'condition-fail'} title={condition.label}>{condition.passed?'✓':'—'}<span className="sr-only">{condition.label}: {condition.passed?'Pass':'Excluded'}</span></span></td>)}<td><span className={row.eligible?'mint-text':'amber-text'}>{row.eligible?'Eligible':'Excluded'}</span></td></tr>)}</tbody></table></div>
    <ol className="manifest-action-cards eligibility-cards" aria-label="Policy conditions by order">{branch.rows.map(row=><li key={row.orderId}><header><button data-focus-return={'order-'+row.orderId} onClick={event=>{event.currentTarget.focus({preventScroll:true});onOrder(row.orderId);}}>{references.get(row.orderId)}<ArrowUpRight size={16}/></button><strong className={row.eligible?'mint-text':'amber-text'}>{row.eligible?'Eligible':'Excluded'}</strong></header><ul>{row.conditions.map(condition=><li key={condition.key}>{condition.passed?<Check className="mint-text" size={17}/>:<X className="amber-text" size={17}/>}<span>{condition.label}</span><span className="sr-only">{condition.passed?'Pass':'Excluded'}</span></li>)}</ul></li>)}</ol>
  </>;
}
