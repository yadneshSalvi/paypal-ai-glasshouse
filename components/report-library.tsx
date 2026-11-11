'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowRight,BookOpen,Check,FilePlus2,FileText,LoaderCircle,RefreshCw} from 'lucide-react';
import type {RecoveryPlan} from '@/packages/domain/types';
import type {ReportList,ReportRequest,ReportSummary,SavedReport} from '@/packages/reports/types';
import {reportMoney,reportTime} from '@/packages/reports/semantics';
import {api,ApiError} from '@/lib/client';
import {PrivateDialog} from './private-dialog';

type Prepared=Pick<ReportRequest,'snapshotHash'|'expectedLayoutVersion'|'expectedLayoutHash'>;
export function ReportLibrary({workspaceId,actorId,readOnly,plans,onClose,onPrepare}:{workspaceId:string;actorId:string;readOnly:boolean;plans:RecoveryPlan[];onClose():void;onPrepare():Promise<Prepared>}){
  const [list,setList]=useState<ReportSummary[]>([]),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [creating,setCreating]=useState(false),[title,setTitle]=useState('The Fernwood incident'),[description,setDescription]=useState(''),[selected,setSelected]=useState<string[]>([]),[parentId,setParentId]=useState('');
  const [saved,setSaved]=useState<ReportSummary|null>(null),[pending,setPending]=useState<ReportRequest|null>(null),pendingRef=useRef<ReportRequest|null>(null),lock=useRef(false);
  const storageKey='glasshouse-report-request:'+workspaceId+':'+actorId;
  const remember=(value:ReportRequest|null)=>{pendingRef.current=value;setPending(value);try{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}catch{/* This page still retains the exact command identity. */}};
  const refresh=async(after?:string)=>{const result=await api<ReportList>('reports'+(after?'?cursor='+encodeURIComponent(after):''));setList(old=>after?[...old,...result.reports]:result.reports);setCursor(result.nextCursor);};
  useEffect(()=>{let active=true;setList([]);setCursor(null);setSaved(null);try{const value=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(value?.requestId&&value?.snapshotHash){pendingRef.current=value;setPending(value);}}catch{/* Ignore malformed local recovery data. */}void refresh().catch(reason=>{if(active)setError(reason.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[storageKey]);
  const run=async(retry=false)=>{
    if(lock.current||readOnly)return;lock.current=true;setBusy(true);setError(null);
    try{
      let input=pendingRef.current;
      if(!retry){if(input)throw new Error('Recover the earlier report request before creating another edition.');const prepared=await onPrepare();input={requestId:crypto.randomUUID(),title,description,...prepared,planIds:selected,...(parentId?{parentId}:{})};remember(input);}
      if(!input)throw new Error('No earlier report request is waiting.');
      const result=await api<SavedReport>('reports',input);remember(null);setSaved(result.summary);setCreating(false);await refresh();
    }catch(reason){
      // Validation failures are definitive. Authority, concurrency and network
      // failures retain the request for exact reconciliation after recovery.
      if(reason instanceof ApiError&&[400,413,422].includes(reason.status))remember(null);
      setError(reason instanceof Error?reason.message:'The edition could not finish. Your investigation is preserved.');
    }finally{lock.current=false;setBusy(false);}
  };
  const holdRequest=()=>{
    const original=pendingRef.current;if(!original)return;
    try{sessionStorage.setItem(storageKey+':held:'+original.requestId,JSON.stringify(original));}catch{setError('The original request could not be retained. Recover it before continuing.');return;}
    remember(null);setCreating(false);setError('The earlier request remains held with its original identity. Check saved editions before deliberately creating a new one.');void refresh().catch(()=>{});
  };
  return <PrivateDialog wide eyebrow="SAVED EDITIONS" title="A record worth returning to." returnFocusKey="report-library" onClose={onClose}>
    <div className="report-library-intro"><BookOpen size={29}/><p>Freeze the evidence behind a decision. Each edition keeps its own clocks, exact native history, and selected recovery manifests.</p></div>
    {error&&<div className="workspace-message is-error" role="alert">{error}</div>}
    {saved&&<div className="report-created" role="status"><Check size={18}/><span><strong>{saved.title}</strong> is saved as a private immutable edition.</span><a className="button primary" href={'/reports/'+saved.id}>Read report<ArrowRight size={15}/></a></div>}
    {pending&&<div className="workspace-pending" role="status"><strong>An edition request is waiting for its saved result.</strong><p>{pending.title}. Recovering reuses its exact snapshot, history revision and request identity.</p><button className="button" disabled={busy||readOnly} onClick={()=>void run(true)}><RefreshCw size={15}/>Recover original edition</button><button className="button" disabled={busy} onClick={holdRequest}>Keep request held · return to editions</button></div>}
    {!creating&&<div className="report-library-actions"><p>Shared only with current members of this workspace.</p><button className="button primary" disabled={readOnly||busy||!!pending} onClick={()=>{setCreating(true);setSaved(null);}}><FilePlus2 size={16}/>Create an edition</button></div>}
    {readOnly&&<p className="report-read-only">Your current access can read saved editions. Creating a new one requires an active workspace and an investigator, operator, owner or judge role.</p>}
    {creating&&<form className="report-create-form" onSubmit={event=>{event.preventDefault();void run();}}>
      <label>Report title<input required minLength={2} maxLength={120} value={title} disabled={busy||!!pending} onChange={event=>setTitle(event.target.value)}/></label>
      <label>Why this edition matters<textarea maxLength={1200} value={description} rows={3} disabled={busy||!!pending} placeholder="What should a future reader understand?" onChange={event=>setDescription(event.target.value)}/></label>
      <label>Earlier edition<select value={parentId} onChange={event=>setParentId(event.target.value)} disabled={busy||!!pending}><option value="">Start an independent edition</option>{list.map(row=><option key={row.id} value={row.id}>{row.title} · {reportTime(row.createdAt)}</option>)}</select><small>A new edition preserves the earlier one exactly.</small></label>
      <fieldset disabled={busy||!!pending}><legend>Include exact saved recovery manifests <span>up to ten</span></legend>{plans.length?plans.map(plan=><label className="report-plan-option" key={plan.id}><input type="checkbox" checked={selected.includes(plan.id)} disabled={!selected.includes(plan.id)&&selected.length>=10} onChange={event=>setSelected(old=>event.target.checked?[...old,plan.id]:old.filter(id=>id!==plan.id))}/><span><strong>{plan.branch.name} · {reportMoney(plan.branch.refundTotalMinor,plan.branch.currency)}</strong><small>{plan.status.replaceAll('_',' ')} · {plan.branch.actions.length} actions · {plan.executionMode} · {plan.id}</small>{plan.branch.id==='comprehensive'&&<small>No-grace comparison; no policy override granted.</small>}</span></label>):<p>No saved proposals yet. You can create an edition of the current evidence without a manifest.</p>}</fieldset>
      <div className="report-create-disclosure"><FileText size={18}/><p>Creating saves the current native layout first, then freezes one admitted snapshot. The six static instruments cover that whole snapshot. Native filters and custom chart mappings remain exact in the JSON. Only your sourced findings for this snapshot are shared; private conversations and hidden reasoning are excluded.</p></div>
      <div className="report-form-actions"><button type="button" className="button" disabled={busy} onClick={()=>setCreating(false)}>Back to editions</button><button className="button primary" type="submit" disabled={busy||readOnly||!!pending||title.trim().length<2}>{busy?<LoaderCircle size={16} className="spin"/>:<FilePlus2 size={16}/>}Save private edition</button></div>
    </form>}
    {loading&&<div className="directory-loading"><LoaderCircle className="spin"/><p>Opening saved editions…</p></div>}
    {!creating&&!loading&&!list.length&&!error&&<div className="report-library-empty"><FileText size={36}/><h3>The first edition starts here.</h3><p>A living investigation changes. A saved edition keeps the evidence behind one moment.</p></div>}
    {!creating&&<div className="report-edition-list">{list.map((report,index)=><article className="report-edition-card" key={report.id}><span className="report-edition-mark">{String(index+1).padStart(2,'0')}</span><div><span className="eyebrow">{reportTime(report.createdAt)}</span><h3>{report.title}</h3><p>{report.description||report.merchantName+' · A saved investigation'}</p><div className="report-edition-meta"><span>Finding v{report.context.cohortVersion}</span><span>{report.planCount} manifests</span><span>{report.operationCount} observed operations</span><span>Layout v{report.layoutVersion}</span></div><small>Saved by {report.creatorName} · {report.documentHash.slice(0,16)}…</small></div><a className="button" href={'/reports/'+report.id}>Read edition<ArrowRight size={15}/></a></article>)}</div>}
    {!creating&&cursor&&<button className="button" disabled={busy} onClick={()=>{setBusy(true);void refresh(cursor).catch(reason=>setError(reason.message)).finally(()=>setBusy(false));}}>Load earlier editions</button>}
  </PrivateDialog>;
}
