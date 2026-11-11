'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,CalendarDays,CheckCheck,Clock3,Database,LoaderCircle,RefreshCw,Square,TriangleAlert} from 'lucide-react';
import type {ReportingEvidencePage,ReportingOverview} from '@/packages/reporting/types';
import {api,dateLabel} from '@/lib/client';
const day=(date:Date)=>date.toISOString().slice(0,10);
const reportedMoney=(minor:number,currency:string)=>{const digits=['JPY','HUF','TWD'].includes(currency)?0:2;return new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:digits,maximumFractionDigits:digits}).format(minor/10**digits);};
export function ReportingStatus(){
 const [data,setData]=useState<ReportingOverview|null>(null),[start,setStart]=useState(()=>day(new Date(Date.now()-86400000))),[end,setEnd]=useState(()=>day(new Date()));
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),mounted=useRef(true),lastContinuation=useRef(0);
 const refresh=useCallback(async()=>{try{const next=await api<ReportingOverview>('reporting',undefined,undefined,AbortSignal.timeout(20000));if(mounted.current){setData(next);setError(null);}
  if(next.runs.some(r=>r.state==='active')&&Date.now()-lastContinuation.current>25000){lastContinuation.current=Date.now();void api('reporting',{action:'continue'}).catch(()=>undefined);}
 }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Reporting could not be reached.');}},[]);
 useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},8000);return()=>{mounted.current=false;clearInterval(timer);};},[refresh]);
 const [evidence,setEvidence]=useState<ReportingEvidencePage|null>(null),[evidenceBusy,setEvidenceBusy]=useState(false),[evidenceError,setEvidenceError]=useState<string|null>(null),evidenceRequest=useRef(0);
 const inspect=async(id:string,page=1)=>{const generation=++evidenceRequest.current;setEvidenceBusy(true);setEvidenceError(null);try{const result=await api<ReportingEvidencePage>(`reporting?runId=${encodeURIComponent(id)}&page=${page}`,undefined,undefined,AbortSignal.timeout(20000));if(mounted.current&&generation===evidenceRequest.current)setEvidence(result);}catch(e){if(mounted.current&&generation===evidenceRequest.current)setEvidenceError(e instanceof Error?e.message:'Saved evidence could not be opened.');}finally{if(mounted.current&&generation===evidenceRequest.current)setEvidenceBusy(false);}};
 const run=data?.runs[0],active=data?.runs.find(r=>r.state==='active'),waiting=run?.coverage.find(w=>w.state==='retry');
 const act=async(input:unknown)=>{setBusy(true);setError(null);try{await api('reporting',input);await refresh();}catch(e){setError(e instanceof Error?e.message:'This scan could not be saved.');}finally{setBusy(false);}};
 return <section className="reporting-status" aria-label="PayPal reporting coverage">
  <header><div className="reporting-title"><Database size={20}/><div><span className="eyebrow">REPORTING · READ ONLY</span><h3>Give every page a place.</h3></div></div><span className="source-chip source-sandbox">{active?'Reading pages':data?.configured?'Connected':'Awaiting connection'}</span></header>
  <p>Compare the merchant’s report with this workspace’s owned payments. Saved checkpoints let a scan continue after you leave.</p>
  <form className="reporting-form" onSubmit={e=>{e.preventDefault();if(start&&end)void act({action:'start',requestId:crypto.randomUUID(),start:start+'T00:00:00.000Z',end:end+'T00:00:00.000Z'});}}>
   <label><span>From · UTC</span><input type="date" required value={start} onChange={e=>setStart(e.target.value)} disabled={busy||!!active}/></label><ArrowRight size={15}/><label><span>Until · UTC</span><input type="date" required value={end} onChange={e=>setEnd(e.target.value)} disabled={busy||!!active}/></label>
   <button className="button" disabled={busy||!!active||!data?.configured}>{busy?<LoaderCircle className="spin" size={15}/>:<RefreshCw size={15}/>}Read report</button>
  </form>
  {run&&<div className="reporting-run"><div className="reporting-run-heading"><span>{run.state==='complete'?<CheckCheck size={17}/>:run.state==='attention'?<TriangleAlert size={17}/>:<Clock3 size={17}/>}<strong>{run.state==='complete'?'Pages collected':run.state==='attention'?'Coverage needs review':run.state==='cancelled'?'Stopped · evidence retained':waiting?'Read paused · checkpoint saved':'Collecting the original pages'}</strong></span><small>{dateLabel(run.createdAt)} UTC</small></div>
   <div className="reporting-metrics"><div><strong>{run.pages}</strong><span>pages saved</span></div><div><strong>{run.observedResources}<small> / {run.ownedResources}</small></strong><span>owned resources observed</span></div><div><strong>{run.completedWindows}<small> / {run.windows}</small></strong><span>daily windows collected</span></div></div>
   <div className="reporting-windows" aria-label="Daily report coverage">{run.coverage.map(w=><span key={w.index} className={'reporting-window '+w.state} title={`${w.start} to ${w.end}: ${w.state}, page ${w.nextPage}`}><CalendarDays size={12}/>{w.start.slice(5,10)}<span>{w.state==='complete'?'✓':w.state==='reading'?'…':w.state==='attention'?'!':'·'}</span></span>)}</div>
   <p className="reporting-freshness">{run.refreshedAt?`Provider refresh timestamp: ${dateLabel(run.refreshedAt)} UTC.`:'The provider has not supplied a refresh timestamp yet.'} Collection does not imply that every recent payment has reached reporting.</p>
   {(run.reason||waiting?.reason)&&<p className="observation-error" role="status"><TriangleAlert size={15}/>{run.reason||waiting?.reason}{waiting&&' This saved page will be read again automatically.'}</p>}
   <button className="text-action" disabled={evidenceBusy} onClick={()=>void inspect(run.id)}><Database size={13}/>Inspect collected evidence</button>
   {active&&<button className="text-action" disabled={busy} onClick={()=>void act({action:'cancel',id:active.id})}><Square size={13}/>Stop future reads</button>}
  </div>}
  {!run&&data&&<div className="observation-note"><Clock3 size={15}/><span>No reporting scan has run in this workspace.</span></div>}
  {error&&<div className="observation-error" role="alert"><TriangleAlert size={15}/><span>{error}</span><button onClick={()=>void refresh()}>Retry connection</button></div>}
  {evidenceError&&<p className="observation-error" role="alert">{evidenceError}</p>}
  {evidence&&<section className="reporting-evidence" aria-label="Collected reporting evidence" aria-busy={evidenceBusy}>
   <div className="reporting-run-heading"><strong>Original report observations</strong><button className="text-action" onClick={()=>{evidenceRequest.current++;setEvidence(null);setEvidenceBusy(false);}}>Close evidence</button></div>
   <p>Only resources already owned by this workspace are shown. Reporting status and signed amounts are provider observations, separate from verified payment receipts.</p>
   <div className="reporting-table-scroll" tabIndex={0} role="region" aria-label="Reporting observations table"><table><thead><tr><th>Resource / original order</th><th>Kind</th><th>Reported amount</th><th>Status</th><th>Updated · UTC</th></tr></thead><tbody>{evidence.rows.map(row=><tr key={row.transactionId+row.evidenceHash}><td><strong>{row.transactionId}</strong><small>{row.orderId}</small></td><td>{row.kind}</td><td>{reportedMoney(row.amountMinor,row.currency)}</td><td><span className="source-chip">{row.status}</span></td><td>{row.updatedAt.slice(0,19).replace('T',' ')}<small>Observed {row.observedAt.slice(0,19).replace('T',' ')}</small></td></tr>)}</tbody></table>{evidence.total===0&&<p>No owned reporting observations have been collected for this scan.</p>}</div>
   <div className="reporting-pagination"><span>{evidence.total?`${(evidence.page-1)*evidence.pageSize+1}–${Math.min(evidence.page*evidence.pageSize,evidence.total)} of ${evidence.total}`:'0 observations'}</span><button className="text-action" disabled={evidenceBusy||evidence.page<=1} onClick={()=>void inspect(evidence.runId,evidence.page-1)}>Previous</button><button className="text-action" disabled={evidenceBusy||evidence.page*evidence.pageSize>=evidence.total} onClick={()=>void inspect(evidence.runId,evidence.page+1)}>Next</button></div>
  </section>}
  <details className="reporting-history"><summary>Coverage &amp; earlier scans{data?.runs.length?` · ${data.runs.length}`:''}</summary><ul>{(data?.limitations??['Reporting can arrive later than a completed payment.']).map(text=><li key={text}>{text}</li>)}</ul>{data?.runs.slice(1).map(previous=><div key={previous.id}><span>{previous.start.slice(0,10)} → {previous.end.slice(0,10)}</span><strong>{previous.state}</strong><small>{previous.pages} pages · {previous.observedResources} owned matches</small><button className="text-action" disabled={evidenceBusy} onClick={()=>void inspect(previous.id)}>Inspect</button></div>)}</details>
 </section>;
}
