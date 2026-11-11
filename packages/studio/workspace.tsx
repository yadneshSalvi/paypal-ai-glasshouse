'use client';
import {useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties} from 'react';
import {NativeStudio} from './native-studio';
import {AgStudioLicenseManager,AgStudioAiModule,type AgStudioApi,type AgReportState,type AgReportHistory,type AgAiHarness,type AgAiHarnessSetupParams} from 'ag-studio';
import {LoaderCircle} from 'lucide-react';
import type {Snapshot} from '../domain/types';
import type {GlasshouseRegistry,StudioBridge} from './types';
import {widgets,initialState,studioData,instrumentTheme} from './registry';
import {buildHarness} from '../agents/harness';
import {api} from '@/lib/client';
import {instrumentMinimumHeight,readableLayout,workspaceHeight} from './layout';
import {inspectHistoryRestore,type HistoryRestoreStatus} from './history';
import {SnapshotTransactions,widgetsAtSnapshot} from './snapshot-transactions';
import {HistorySaves,type ReportHistory} from './history-saves';
import type {AgentLayoutReceipt} from '../agents/contracts';

interface Props {
  snapshot:Snapshot; license:string; bridge:StudioBridge; editable:boolean;readOnly?:boolean;
  history:AgReportHistory<GlasshouseRegistry>|null;
  historyVersion:number;
  onSaveReady(actions:{save():Promise<void>;retry():Promise<void>}):void;
  onSaved(history:ReportHistory,version:number):void;
  onSaveError(message:string|null):void;
  onHarness(harness:AgAiHarness):void;
  onCommitted(hash:string):void;
  onHistoryStatus(status:HistoryRestoreStatus):void;
}
const studioModules=[AgStudioAiModule];
export default function StudioWorkspace(props:Props){
  const current=useRef(props);current.current=props;
  const snapshotRef=useRef(props.snapshot);
  const applied=useRef(props.snapshot);
  const apiRef=useRef<AgStudioApi<GlasshouseRegistry>|null>(null);
  const harnessRef=useRef<AgAiHarness|null>(null);
  const harnessApiRef=useRef<AgAiHarnessSetupParams['api']|null>(null);
  const acknowledgements=useRef(new Map<string,string>());
  const transactionDone=useRef(true);
  const saveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const agentMutation=useRef(false);
  const host=useRef<HTMLDivElement>(null);
  const transactions=useRef<SnapshotTransactions|null>(null);
  const reportReady=useRef(false);
  const historyRestored=useRef(false);
  const saves=useRef<HistorySaves|null>(null);
  saves.current??=new HistorySaves(props.historyVersion,input=>api<{version:number}>('layout',input),(history,version)=>current.current.onSaved(history,version));
  const persist=async(history:ReportHistory,label:string,receipt?:AgentLayoutReceipt)=>{
    if(current.current.readOnly)throw new Error('This workspace is read-only. Its saved native report remains preserved.');
    if(saveTimer.current){clearTimeout(saveTimer.current);saveTimer.current=null;}
    try{await saves.current!.save(history,label,receipt);current.current.onSaveError(null);}
    catch(error){const message=error instanceof Error?error.message:'The workspace save could not be confirmed.';current.current.onSaveError(message);throw error;}
  };
  const [historyStatus,setHistoryStatus]=useState<HistoryRestoreStatus>({state:'checking',savedUndo:props.history?.undo.length??0,savedRedo:props.history?.redo.length??0,undo:0,redo:0,issues:[]});
  const [width,setWidth]=useState(1440);
  const [layoutState,setLayoutState]=useState<AgReportState<GlasshouseRegistry>>(()=>props.history?.current??initialState);
  const [ready,setReady]=useState(false);
  const [pending,setPending]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [seed]=useState(()=>{
    if(props.license)AgStudioLicenseManager.setLicenseKey(props.license);
    return {data:studioData(props.snapshot),history:props.history||initialState};
  });
  const finish=()=>{
    if(!reportReady.current)return;
    const state=apiRef.current?.getState()??layoutState;
    const page=state.pages.find(page=>page.id===state.selectedPageId);
    const required=Object.entries(page?.widgets??{}).filter(([,widget])=>widget&&widget.type in instrumentMinimumHeight).map(([id])=>id);
    if(transactionDone.current&&snapshotRef.current.hash===current.current.snapshot.hash&&widgetsAtSnapshot(required,acknowledgements.current,snapshotRef.current.hash)){
      setPending(false);
      current.current.onCommitted(snapshotRef.current.hash);
    }
  };
  const bridge=useMemo<StudioBridge>(()=>({
    getSnapshot:()=>snapshotRef.current,
    onTime:v=>current.current.bridge.onTime(v),onOrder:v=>current.current.bridge.onOrder(v),
    onBranch:v=>current.current.bridge.onBranch(v),onRevision:()=>current.current.bridge.onRevision(),
    onEvent:e=>current.current.bridge.onEvent(e),onApi:a=>current.current.bridge.onApi(a),
    onHistory:h=>current.current.bridge.onHistory(h),onError:e=>current.current.bridge.onError(e),
    onWidgetReady(id,hash,count,highlightCount){
      current.current.bridge.onWidgetReady(id,hash,count,highlightCount);
      if(hash===snapshotRef.current.hash){acknowledgements.current.set(id,hash);finish();}
    },
  }),[]);
  const ai=useMemo(()=>({api:studioApi}:AgAiHarnessSetupParams)=>{
    if(harnessApiRef.current!==studioApi){harnessRef.current?.dispose?.();harnessRef.current=null;harnessApiRef.current=studioApi;}
    if(!harnessRef.current){
      harnessRef.current=buildHarness(studioApi as AgStudioApi<GlasshouseRegistry>,bridge,{save:persist,mutation:active=>{agentMutation.current=active;if(active&&saveTimer.current){clearTimeout(saveTimer.current);saveTimer.current=null;}}});
      const harness=harnessRef.current;
      queueMicrotask(()=>current.current.onHarness(harness));
    }
    return harnessRef.current;
  },[bridge]);

  useEffect(()=>{
    if(!host.current)return;
    const observer=new ResizeObserver(entries=>{const next=entries[0]?.contentRect.width;if(next)setWidth(next);});
    observer.observe(host.current);
    return()=>observer.disconnect();
  },[]);

  useLayoutEffect(()=>{
    if(!ready)return;
    const studioApi=apiRef.current;
    const engine=studioApi?.getDataEngine();
    if(!engine?.applyTransaction){setError('The live data engine is not ready. Reload to restore the last saved investigation.');return;}
    setPending(true);
    transactionDone.current=false;
    transactions.current??=new SnapshotTransactions(applied.current,{
      prepare:incoming=>{snapshotRef.current=incoming;setError(null);},
      apply:batch=>engine.applyTransaction!(batch),
      applied:incoming=>{applied.current=incoming;},
      settled:()=>{transactionDone.current=true;finish();},
      failed:error=>{
        setError(error instanceof Error?error.message:'The snapshot could not be applied.');
        current.current.bridge.onError('The new snapshot is held until all instruments agree. Please reload the workspace.');
      },
    });
    void transactions.current.request(props.snapshot);
  },[props.snapshot,ready]);

  useEffect(()=>{saves.current?.admit(historyRestored.current);return()=>{if(saveTimer.current)clearTimeout(saveTimer.current);saves.current?.admit(false);harnessRef.current?.dispose?.();harnessRef.current=null;harnessApiRef.current=null;};},[]);
  const height=workspaceHeight(layoutState,Math.max(320,width-(props.editable?340:0)));
  return <div ref={host} style={{height,'--glasshouse-studio-height':`${height}px`} as CSSProperties} className={'studio-host '+(props.editable?'is-editable':'')} data-snapshot={applied.current.hash} data-ready={!pending} data-history-status={historyStatus.state} data-history-diagnostics={JSON.stringify(historyStatus)} aria-busy={pending}>
    <NativeStudio
      studioId="glasshouse-investigation" data={seed.data} initialState={seed.history} widgets={widgets}
      context={bridge} theme={instrumentTheme} mode={props.editable?'edit':'view'} ai={ai} modules={studioModules}
      loadThemeGoogleFonts={false} history={{onModeChange:'preserve'}}
      panels={{edit:{right:['edit','data','filters']},view:{right:[]}}}
      responsiveLayoutBreakpoints={[
        {maxWidth:760,layout:(items,layout)=>readableLayout(items,layout.columns,'single')},
        {maxWidth:1180,layout:(items,layout)=>readableLayout(items,layout.columns,'paired')},
        {layout:(items,layout)=>readableLayout(items,layout.columns,'authored')},
      ]}
      onApiReady={({api:studioApi})=>{apiRef.current=studioApi as AgStudioApi<GlasshouseRegistry>;bridge.onApi(apiRef.current);}}
      onStudioReady={()=>{
        // Studio emits this event immediately before admitting initial state. The
        // microtask observes the admitted document and the actual native stacks.
        queueMicrotask(()=>{
          const studioApi=apiRef.current;
          if(!studioApi)return;
          reportReady.current=true;setReady(true);
          const status=inspectHistoryRestore(studioApi,current.current.history);
          historyRestored.current=status.state==='restored';
          saves.current!.admit(historyRestored.current);
          current.current.onSaveReady({save:()=>persist(studioApi.getHistory(),'Investigation saved by reviewer'),retry:async()=>{try{await saves.current!.retry();current.current.onSaveError(null);}catch(error){current.current.onSaveError(error instanceof Error?error.message:'The saved workspace is still unresolved.');throw error;}}});
          setHistoryStatus(status);current.current.onHistoryStatus(status);
          bridge.onHistory(studioApi.getHistory());
          setLayoutState(studioApi.getState());
          // The custom rail uses the same native harness as Studio's own AI panel.
          ai({api:studioApi as unknown as AgAiHarnessSetupParams['api'],context:bridge});
          finish();
        });
      }}
      onRenderStateChanged={e=>{if(e.renderState==='rendered')finish();}}
      onStateUpdated={e=>{
        if(!apiRef.current)return;
        setLayoutState(e.state as AgReportState<GlasshouseRegistry>);
        const history=apiRef.current.getHistory();bridge.onHistory(history);
        setHistoryStatus(previous=>({...previous,undo:history.undo.length,redo:history.redo.length}));
        if(!e.durable||!historyRestored.current||agentMutation.current||current.current.readOnly)return;
        if(saveTimer.current)clearTimeout(saveTimer.current);
        saveTimer.current=setTimeout(()=>{void persist(history,e.change?.source.type==='ai'?'Agent workspace edit':'Workspace edited').catch(()=>{});},700);
      }}
      onErrorRaised={e=>{if(e.fatal){historyRestored.current=false;saves.current!.admit(false);if(saveTimer.current)clearTimeout(saveTimer.current);setError(e.errorDetails.join(' '));bridge.onError('Studio could not restore this report.');}}}
    />
    {pending&&<div className="snapshot-barrier" role="status"><div className="snapshot-spinner"><LoaderCircle size={24}/></div><span className="eyebrow">ONE MOMENT. ONE SHARED TRUTH.</span><h3>{error?'Snapshot held for review.':ready?'Reconstructing the evidence.':'Opening your incident room.'}</h3><p>{error||'All six instruments are joining the same time and knowledge cutoff.'}</p><div className="barrier-instruments"><span>River</span><span>Clock</span><span>Evidence</span><span>Recovery</span><span>Regions</span><span>Cases</span></div>{error&&<button className="button" onClick={()=>location.reload()}>Reload saved workspace</button>}</div>}
  </div>;
}
