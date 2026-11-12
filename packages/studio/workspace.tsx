'use client';
import {useEffect,useMemo,useRef,useState,type CSSProperties} from 'react';
import {NativeStudio} from './native-studio';
import {AgStudioLicenseManager,AgStudioAiModule,type AgDataEngine,type AgStudioApi,type AgReportState,type AgReportHistory,type AgAiHarness,type AgAiHarnessSetupParams} from 'ag-studio';
import {LoaderCircle,RotateCcw} from 'lucide-react';
import type {Snapshot} from '../domain/types';
import type {GlasshouseRegistry,StudioBridge} from './types';
import {widgets,initialState,studioData,instrumentTheme} from './registry';
import {buildHarness} from '../agents/harness';
import {api} from '@/lib/client';
import {instrumentMinimumHeight,readableLayout,workspaceHeight} from './layout';
import {inspectHistoryRestore,type HistoryRestoreStatus} from './history';
import {widgetsAtSnapshot} from './snapshot-transactions';
import {prepareSnapshot,type PreparedSnapshot} from './atomic-snapshot';
import {HistorySaves,type ReportHistory} from './history-saves';
import type {AgentLayoutReceipt} from '../agents/contracts';

interface Props {
  snapshot:Snapshot;license:string;bridge:StudioBridge;editable:boolean;readOnly?:boolean;
  history:AgReportHistory<GlasshouseRegistry>|null;historyVersion:number;
  onSaveReady(actions:{save():Promise<void>;retry():Promise<void>}):void;
  onSaved(history:ReportHistory,version:number):void;onSaveError(message:string|null):void;
  onHarness(harness:AgAiHarness):void;onCommitted(hash:string):void;onHistoryStatus(status:HistoryRestoreStatus):void;
}
interface Slot {id:number;snapshot:Snapshot;history:ReportHistory|AgReportState<GlasshouseRegistry>;prepared?:PreparedSnapshot}
interface Live {api:AgStudioApi<GlasshouseRegistry>;harness:AgAiHarness;status:HistoryRestoreStatus}
const modules=[AgStudioAiModule];

export default function StudioWorkspace(props:Props){
  const current=useRef(props);current.current=props;
  const [active,setActive]=useState<Slot>(()=>({id:0,snapshot:props.snapshot,history:props.history??initialState})),activeRef=useRef(active);activeRef.current=active;
  const [candidate,setCandidate]=useState<Slot|null>(null),candidateRef=useRef<Slot|null>(null);
  const [phase,setPhase]=useState<'opening'|'ready'|'preparing'|'failed'>('opening'),[error,setError]=useState<string|null>(null),[attempt,setAttempt]=useState(0);
  const [layout,setLayout]=useState<AgReportState<GlasshouseRegistry>>(props.history?.current??initialState),[width,setWidth]=useState(1440);
  const live=useRef(new Map<number,Live>()),generation=useRef(0),host=useRef<HTMLDivElement>(null),statusElement=useRef<HTMLDivElement>(null),saveTimer=useRef<ReturnType<typeof setTimeout>|null>(null),agentMutation=useRef(false);
  const owned=useRef(new Set<PreparedSnapshot>()),focusReturn=useRef<{label:string|null;key:string|null;scroll:number}|null>(null);
  const saves=useRef<HistorySaves|null>(null);saves.current??=new HistorySaves(props.historyVersion,input=>api<{version:number}>('layout',input),(history,version)=>current.current.onSaved(history,version));
  const persist=async(history:ReportHistory,label:string,receipt?:AgentLayoutReceipt)=>{
    if(current.current.readOnly)throw new Error('This workspace is read-only.');
    if(saveTimer.current){clearTimeout(saveTimer.current);saveTimer.current=null;}
    try{await saves.current!.save(history,label,receipt);current.current.onSaveError(null);}catch(reason){current.current.onSaveError(reason instanceof Error?reason.message:'The workspace save is unresolved.');throw reason;}
  };
  const expose=(slot:Slot,instance:Live)=>{
    saves.current!.admit(instance.status.state==='restored');
    current.current.bridge.onApi(instance.api);current.current.bridge.onHistory(instance.api.getHistory());current.current.onHarness(instance.harness);current.current.onHistoryStatus(instance.status);
    current.current.onSaveReady({save:()=>persist(instance.api.getHistory(),'Investigation saved by reviewer'),retry:async()=>{try{await saves.current!.retry();current.current.onSaveError(null);}catch(reason){current.current.onSaveError(reason instanceof Error?reason.message:'The workspace save remains held.');throw reason;}}});
    setLayout(instance.api.getState());current.current.onCommitted(slot.snapshot.hash);
  };
  const discard=(slot:Slot|null)=>{if(!slot)return;const instance=live.current.get(slot.id);instance?.harness.dispose?.();live.current.delete(slot.id);if(slot.prepared){owned.current.delete(slot.prepared);setTimeout(()=>slot.prepared?.dispose(),0);}};
  const fail=(id:number,reason:string)=>{
    if(id!==activeRef.current.id&&id!==candidateRef.current?.id)return;
    if(id===candidateRef.current?.id){const failed=candidateRef.current;candidateRef.current=null;setCandidate(null);discard(failed);}
    setPhase('failed');setError(reason);current.current.bridge.onError('The new source revision could not be verified. Your complete previous report and selections are preserved. Retry reconstruction to open a fresh native engine.');
  };
  const admit=(slot:Slot,instance:Live)=>{
    if(slot.id!==activeRef.current.id&&current.current.bridge.canCommitSnapshot&&!current.current.bridge.canCommitSnapshot(slot.snapshot.hash)){if(slot.id===candidateRef.current?.id){candidateRef.current=null;setCandidate(null);setPhase('ready');}instance.harness.dispose?.();discard(slot);return;}
    live.current.set(slot.id,instance);
    if(slot.id===activeRef.current.id){expose(slot,instance);setPhase('ready');return;}
    if(slot.id!==candidateRef.current?.id||slot.id!==generation.current){discard(slot);return;}
    const old=activeRef.current,oldInstance=live.current.get(old.id);
    if(oldInstance&&JSON.stringify(oldInstance.api.getHistory())!==JSON.stringify(slot.history)){fail(slot.id,'The report changed while the next source revision was opening. The current history is preserved; retry to include that exact history.');return;}
    activeRef.current=slot;candidateRef.current=null;setActive(slot);setCandidate(null);setError(null);setPhase('ready');expose(slot,instance);
    requestAnimationFrame(()=>{discard(old);const restore=focusReturn.current;focusReturn.current=null;if(restore){window.scrollTo({top:restore.scroll,behavior:'instant'});const targets=host.current?.querySelectorAll<HTMLElement>('[data-focus-return],[aria-label]');const target=Array.from(targets??[]).find(element=>restore.key?element.dataset.focusReturn===restore.key:element.getAttribute('aria-label')===restore.label);(target??statusElement.current)?.focus({preventScroll:true});}});
  };
  useEffect(()=>{if(props.license)AgStudioLicenseManager.setLicenseKey(props.license);},[props.license]);
  useEffect(()=>{if(!host.current)return;const observer=new ResizeObserver(entries=>{if(entries[0]?.contentRect.width)setWidth(entries[0].contentRect.width);});observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    const previous=activeRef.current;
    const native=live.current.get(previous.id);
    if(props.snapshot.hash===previous.snapshot.hash&&(!attempt||native)){generation.current++;const obsolete=candidateRef.current;candidateRef.current=null;setCandidate(null);discard(obsolete);if(native){setPhase('ready');current.current.onCommitted(props.snapshot.hash);}return;}
    if(native&&native.status.state!=='restored'||!native&&!attempt)return;
    const request=++generation.current;
    const replaced=candidateRef.current;candidateRef.current=null;setCandidate(null);discard(replaced);
    const focused=document.activeElement as HTMLElement|null;
    if(focused&&host.current?.contains(focused)){focusReturn.current={label:focused.getAttribute('aria-label'),key:focused.dataset.focusReturn??null,scroll:window.scrollY};statusElement.current?.focus({preventScroll:true});}
    setPhase('preparing');setError(null);
    const history=structuredClone(native?.api.getHistory()??previous.history);
    let cancelled=false;
    void prepareSnapshot(previous.snapshot,props.snapshot).then(prepared=>{
      if(cancelled||request!==generation.current){prepared.dispose();return;}
      owned.current.add(prepared);const slot={id:request,snapshot:props.snapshot,history,prepared};candidateRef.current=slot;setCandidate(slot);
    }).catch(reason=>{if(!cancelled&&request===generation.current){setPhase('failed');setError(reason instanceof Error?reason.message:'The native source reconstruction failed.');}});
    return()=>{cancelled=true;};
  },[props.snapshot,attempt,phase==='opening']);
  useEffect(()=>()=>{generation.current++;if(saveTimer.current)clearTimeout(saveTimer.current);saves.current?.admit(false);for(const instance of live.current.values())instance.harness.dispose?.();setTimeout(()=>{for(const prepared of owned.current)prepared.dispose();owned.current.clear();},0);},[]);
  const changed=(slot:Slot,studioApi:AgStudioApi<GlasshouseRegistry>,state:AgReportState<GlasshouseRegistry>,durable:boolean,label:string)=>{
    if(slot.id!==activeRef.current.id)return;
    setLayout(state);const history=studioApi.getHistory();current.current.bridge.onHistory(history);
    const instance=live.current.get(slot.id);if(instance)current.current.onHistoryStatus({...instance.status,undo:history.undo.length,redo:history.redo.length});
    if(!durable||phase==='preparing'||agentMutation.current||current.current.readOnly||instance?.status.state!=='restored')return;
    if(saveTimer.current)clearTimeout(saveTimer.current);saveTimer.current=setTimeout(()=>{void persist(history,label).catch(()=>{});},700);
  };
  const height=workspaceHeight(layout,Math.max(320,width-(props.editable?340:0)));
  return <div className="atomic-report">
    <div ref={statusElement} tabIndex={-1} className={'snapshot-live-status '+(phase==='ready'?'sr-only':'')} role="status">{phase==='ready'?'All instruments share the committed source revision.':phase==='opening'?<><LoaderCircle size={18}/>Opening the incident room…</>:phase==='preparing'?<><LoaderCircle size={18}/>Reconstructing T and K. Your previous complete report is shown below.{props.bridge.playback?.getSnapshot()&&<button className="button" onClick={()=>props.bridge.playback?.pause()}>Pause replay</button>}</>:<><strong>Previous report preserved.</strong><span>{error}</span><button className="button" onClick={()=>setAttempt(value=>value+1)}><RotateCcw size={14}/>Retry reconstruction</button></>}</div>
    <div ref={host} className={'studio-host atomic-studio-host '+(props.editable?'is-editable':'')} style={{height,'--glasshouse-studio-height':`${height}px`} as CSSProperties} data-snapshot={active.snapshot.hash} data-ready={phase==='ready'} aria-busy={phase==='preparing'||phase==='opening'}>
    {[active,...candidate?[candidate]:[]].map(slot=><div key={slot.id} className={slot.id===active.id?'committed-native-report':'staged-native-report'} aria-hidden={slot.id!==active.id||undefined} inert={slot.id!==active.id||phase==='preparing'}><StudioInstance slot={slot} bridge={props.bridge} editable={slot.id===active.id&&props.editable&&phase==='ready'&&!props.readOnly} onReady={instance=>admit(slot,instance)} onError={reason=>fail(slot.id,reason)} onState={(api,state,durable,label)=>changed(slot,api,state,durable,label)} persist={slot.id===active.id?persist:async()=>{throw new Error('The next source revision is not committed.');}} onAgentMutation={value=>{if(slot.id===active.id)agentMutation.current=value;}}/></div>)}
  </div></div>;
}

function StudioInstance({slot,bridge:publicBridge,editable,onReady,onError,onState,persist,onAgentMutation}:{slot:Slot;bridge:StudioBridge;editable:boolean;onReady(instance:Live):void;onError(reason:string):void;onState(api:AgStudioApi<GlasshouseRegistry>,state:AgReportState<GlasshouseRegistry>,durable:boolean,label:string):void;persist(history:ReportHistory,label:string,receipt?:AgentLayoutReceipt):Promise<void>;onAgentMutation(active:boolean):void}){
  const callbacks=useRef({onReady,onError,onState,persist,onAgentMutation,publicBridge});callbacks.current={onReady,onError,onState,persist,onAgentMutation,publicBridge};
  const apiRef=useRef<AgStudioApi<GlasshouseRegistry>|null>(null),harness=useRef<AgAiHarness|null>(null),ready=useRef(false),rendered=useRef(false),acknowledgements=useRef(new Map<string,string>()),counts=useRef(new Map<string,{count:number;selected:number}>()),admitted=useRef(false),status=useRef<HistoryRestoreStatus|null>(null);
  const [data]=useState<AgDataEngine|ReturnType<typeof studioData>>(()=>slot.prepared?.engine??studioData(slot.snapshot));
  const finish=()=>{
    const studioApi=apiRef.current;if(!studioApi||!ready.current||!rendered.current||admitted.current||!harness.current||!status.current)return;
    const state=studioApi.getState(),page=state.pages.find(page=>page.id===state.selectedPageId),required=Object.entries(page?.widgets??{}).filter(([,widget])=>widget&&widget.type in instrumentMinimumHeight).map(([id])=>id);
    if(!widgetsAtSnapshot(required,acknowledgements.current,slot.snapshot.hash))return;
    if(status.current.state!=='restored'){callbacks.current.onError('The imported native history could not be verified. The previous workspace remains preserved.');return;}
    admitted.current=true;callbacks.current.onReady({api:studioApi,harness:harness.current,status:status.current});for(const [id,{count,selected}] of counts.current)callbacks.current.publicBridge.onWidgetReady(id,slot.snapshot.hash,count,selected);
  };
  const bridge=useMemo<StudioBridge>(()=>({playback:publicBridge.playback,getSnapshot:()=>slot.snapshot,onTime:(t,k,clock,currency)=>callbacks.current.publicBridge.onTime(t,k,clock,currency),onOrder:id=>callbacks.current.publicBridge.onOrder(id),onBranch:(id,scope)=>callbacks.current.publicBridge.onBranch(id,scope),onRevision:()=>callbacks.current.publicBridge.onRevision(),onFindings:()=>callbacks.current.publicBridge.onFindings?.(),onEvent:event=>callbacks.current.publicBridge.onEvent(event),onApi:()=>{},onHistory:()=>{},onError:reason=>callbacks.current.onError(reason),onWidgetReady(id,hash,count,selected){if(hash===slot.snapshot.hash){acknowledgements.current.set(id,hash);counts.current.set(id,{count,selected});if(admitted.current)callbacks.current.publicBridge.onWidgetReady(id,hash,count,selected);finish();}}}),[slot]);
  const ai=useMemo(()=>({api:studioApi}:AgAiHarnessSetupParams)=>{harness.current??=buildHarness(studioApi as AgStudioApi<GlasshouseRegistry>,bridge,{save:(history,label,receipt)=>callbacks.current.persist(history,label,receipt),mutation:value=>callbacks.current.onAgentMutation(value)});return harness.current;},[bridge]);
  useEffect(()=>{const timer=setTimeout(()=>{if(!admitted.current)callbacks.current.onError('The native instruments did not finish a consistent revision. Retry reconstruction to use a fresh engine.');},20_000);return()=>clearTimeout(timer);},[]);
  return <NativeStudio studioId={'glasshouse-investigation-'+slot.id} data={data} initialState={slot.history} widgets={widgets} context={bridge} theme={instrumentTheme} mode={editable?'edit':'view'} ai={ai} modules={modules} loadThemeGoogleFonts={false} history={{onModeChange:'preserve'}} panels={{edit:{right:['edit','data','filters']},view:{right:[]}}} responsiveLayoutBreakpoints={[{maxWidth:760,layout:(items,layout)=>readableLayout(items,layout.columns,'single')},{maxWidth:1180,layout:(items,layout)=>readableLayout(items,layout.columns,'paired')},{layout:(items,layout)=>readableLayout(items,layout.columns,'authored')}]} onApiReady={({api})=>{apiRef.current=api as AgStudioApi<GlasshouseRegistry>;}} onStudioReady={()=>queueMicrotask(()=>{const studioApi=apiRef.current;if(!studioApi)return;status.current=inspectHistoryRestore(studioApi,'current' in slot.history?slot.history:null);ready.current=true;ai({api:studioApi as unknown as AgAiHarnessSetupParams['api'],context:bridge});finish();})} onRenderStateChanged={event=>{rendered.current=event.renderState==='rendered';finish();}} onStateUpdated={event=>{if(apiRef.current)callbacks.current.onState(apiRef.current,event.state as AgReportState<GlasshouseRegistry>,event.durable,event.change?.source.type==='ai'?'Agent workspace edit':'Workspace edited');}} onErrorRaised={event=>{if(event.fatal)callbacks.current.onError(event.errorDetails.join(' '));}}/>;
}
