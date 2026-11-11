'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, CheckCheck, Clock3, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Operation } from '@/packages/domain/types';
import type { ObservationOverview } from '@/packages/observations/types';
import { api, dateLabel } from '@/lib/client';

let pendingOverview: Promise<ObservationOverview>|null = null;
function readOverview() {
  pendingOverview ??= api<ObservationOverview>('observations',undefined,undefined,AbortSignal.timeout(20_000)).finally(() => {pendingOverview = null;});
  return pendingOverview;
}

function useObservations() {
  const [data,setData] = useState<ObservationOverview|null>(null), [error,setError] = useState<string|null>(null);
  const mounted = useRef(true), lastContinuation = useRef(0);
  const refresh = useCallback(async () => {
    try {
      const result = await readOverview();
      if (!mounted.current) return;
      setData(result);setError(null);
      if (result.jobs.queued+result.jobs.running+result.jobs.retry > 0 && Date.now()-lastContinuation.current > 25_000) {
        lastContinuation.current = Date.now();
        void api('observations',{action:'continue'}).catch(() => { /* SQL jobs remain available to the independent read worker. */ });
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error?failure.message:'The current provider checks could not be loaded.'); }
  },[]);
  useEffect(() => {
    mounted.current = true;void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); },5000);
    return () => {mounted.current = false;clearInterval(timer);};
  },[refresh]);
  return {data,error,refresh};
}

export function ReceiptStatus({planId,operations,onRefresh,onLatestEvidence}:{planId:string;operations:Operation[];onRefresh():Promise<void>;onLatestEvidence():Promise<void>}) {
  const {data,error,refresh} = useObservations();
  const [busy,setBusy] = useState(false), [requestError,setRequestError] = useState<string|null>(null);
  const [requested,setRequested] = useState(false), refreshed = useRef('');
  const ids = new Set(operations.map(operation=>operation.id));
  const checks = data?.checks.filter(check=>ids.has(check.operationId)) ?? [];
  const waiting = data?.pendingOperations.filter(id=>ids.has(id)).length ?? 0;
  const held = data?.heldOperations.filter(value=>ids.has(value.operationId)) ?? [];
  const verified = checks.filter(check=>check.outcome==='verified').length;
  const notCompleted = checks.filter(check=>check.outcome==='not_completed'||check.outcome==='not_dispatched').length;
  const latest = checks.map(check=>check.observedAt).sort().at(-1) ?? null;
  const cases = checks.filter(check=>check.evidenceSubmitted !== undefined);
  useEffect(() => {
    if (!latest || waiting || refreshed.current === latest) return;
    refreshed.current = latest;void onRefresh().catch(()=>undefined);
  },[latest,waiting,onRefresh]);
  const check = async () => {
    setBusy(true);setRequestError(null);
    try { await api('observations',{planId});setRequested(true);await refresh(); }
    catch (failure) { setRequestError(failure instanceof Error?failure.message:'The status check could not be saved.'); }
    finally {setBusy(false);}
  };
  return <section className="receipt-status" aria-label="Independent provider status checks">
    <header><div className="receipt-status-icon"><ShieldCheck size={21}/></div><div><span className="eyebrow">INDEPENDENT CHECKS · NOW</span><h3>{waiting?'Reading the original results.':held.length?'Some current reads need attention.':'Keep the receipt. Check what changed.'}</h3></div>
      <button className="button" disabled={busy||waiting>0} onClick={()=>void check()}>{busy||waiting?<LoaderCircle className="spin" size={15}/>:<RefreshCw size={15}/>}Check status</button></header>
    <p>Read the current state of these original actions. Every approved amount, expiry and original receipt stays on record.</p>
    <div className="receipt-status-summary" role="status" aria-live="polite">
      {waiting?<><span className="read-pulse"/><span>{waiting} original actions still being checked. You can leave this view.</span></>:
        held.length?<><TriangleAlert size={16}/><span>{held.length} current checks are held for review. The saved receipts remain available.</span></>:
        latest?<>{notCompleted?<TriangleAlert size={16}/>:<CheckCheck size={16}/>}<span>{verified} of {checks.length} recent checks verified{notCompleted?` · ${notCompleted} actions not completed`:''} · {dateLabel(latest)} UTC</span></>:
        <><Clock3 size={16}/><span>{requested?'Status checks saved. Reading the original resources…':'The original results above remain the recorded outcome.'}</span></>}
    </div>
    {held.length>0&&<details className="observation-attention"><summary>{held.length} current checks need attention</summary><ul>{held.slice(0,6).map(value=><li key={value.operationId}><p>{value.reason}</p><span>{dateLabel(value.updatedAt)} UTC · the original receipt remains recorded</span></li>)}</ul></details>}
    {cases.length>0&&<div className="receipt-case-list">{cases.map(value=><div key={value.operationId}><span><ShieldCheck size={14}/>{value.providerId}</span><strong>{value.providerStatus?.replaceAll('_',' ').toLowerCase()}</strong>
      <small>{value.evidenceSubmitted?'Original evidence is present.':'Original evidence is not yet confirmed.'} {value.caseResolved?'PayPal reports this case as resolved.':'No case resolution was reported.'}</small></div>)}</div>}
    {latest&&<button className="text-action receipt-latest" onClick={()=>void onLatestEvidence().catch(failure=>setRequestError(failure instanceof Error?failure.message:'The latest evidence could not be opened.'))}>Use latest evidence in the investigation<ArrowRight size={15}/></button>}
    {(requestError||error)&&<div className="observation-error" role="alert"><TriangleAlert size={15}/><span>{requestError||error}</span><button onClick={()=>void refresh()}>Retry connection</button></div>}
  </section>;
}

export function ObservationHealth() {
  const {data,error,refresh}=useObservations(),[busy,setBusy]=useState(false),[retryError,setRetryError]=useState<string|null>(null);
  const retry=async()=>{setBusy(true);setRetryError(null);try{await api('observations',{action:'retry'});await refresh();}catch(failure){setRetryError(failure instanceof Error?failure.message:'Held reads could not be requested.');}finally{setBusy(false);}};
  const active=data?data.jobs.queued+data.jobs.running+data.jobs.retry:0;
  const qualified=!error&&data?.connectorConfigured&&data.notifications.applied>0;
  const connectionLabel=error?'Connection unavailable':!data?'Checking connection':!data.connectorConfigured?'Awaiting connection':qualified?'Verified delivery':'Awaiting first delivery';
  const connectionDescription=error?'The current merchant connection could not be checked. Saved deliveries and completed checks remain on record.':
    !data?'Reading the saved notification receipts and current merchant connection.':
    !data.connectorConfigured?'The current merchant connection is unavailable. Earlier deliveries and completed checks remain on record. Restore the connection before new notification reads can resume.':
    qualified?'Authenticated notifications start independent reads of the owned payment or case. Those reads become new evidence.':
    'The merchant is bound. A signed provider event must arrive and pass an independent resource read before this connection is qualified.';
  return <section className="observation-health" aria-label="Provider notification health">
    <header><div><span className="eyebrow">THE EVIDENCE KEEPS MOVING</span><h3>PayPal notifications</h3></div><span className={'source-chip '+(qualified?'source-sandbox':'source-sample')}>{connectionLabel}</span></header>
    <p>{connectionDescription}</p>
    {data?<>
      <div className="observation-metrics">{[[data.notifications.verified,'Authenticated'],[data.notifications.applied,'Independently read'],[active,'Reads pending'],[data.jobs.attention,'Need attention']].map(([count,label])=><div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div>
      <div className="observation-note"><Activity size={14}/><span>{data.notifications.lastVerifiedAt?`Last authenticated delivery ${dateLabel(data.notifications.lastVerifiedAt)} UTC`:'No authenticated delivery has been received.'}</span></div>
      {(data.notifications.duplicates>0||data.notifications.rejected>0||data.notifications.conflicts>0)&&<p className="observation-receipt-counts">{data.notifications.duplicates} duplicate deliveries joined · {data.notifications.rejected} unverified deliveries excluded · {data.notifications.conflicts} identity or merchant conflicts held</p>}
      {data.recent.some(job=>job.state==='attention'||job.state==='retry')&&<details className="observation-attention"><summary>Inspect reads that need attention</summary><ul>{data.recent.filter(job=>job.state==='attention'||job.state==='retry').map(job=><li key={job.id}><strong>{job.kind==='recovery'?'Original action check':'Provider notification'} · {job.state==='retry'?'waiting for another read':'held for review'}</strong><p>{job.reason}</p><span>{job.attempts} read attempts · {dateLabel(job.updatedAt)} UTC</span></li>)}</ul></details>}
      {data.jobs.attention>0&&<button className="button" disabled={busy} onClick={()=>void retry()}>{busy?<LoaderCircle className="spin" size={15}/>:<RefreshCw size={15}/>}Recheck held sources</button>}
    </>:!error?<div className="observation-note" role="status"><LoaderCircle className="spin" size={16}/><span>Reading saved notification receipts…</span></div>:null}
    {(error||retryError)&&<div className="observation-error" role="alert"><TriangleAlert size={15}/><span>{retryError||error}</span><button onClick={()=>void refresh()}>Retry connection</button></div>}
  </section>;
}
