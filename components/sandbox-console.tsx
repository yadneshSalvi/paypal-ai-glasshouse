'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, Download, ExternalLink, Leaf, LoaderCircle, LockKeyhole, Pause, RefreshCw, Search, ShieldCheck, Wallet } from 'lucide-react';
import type { SandboxStatus, SeedRun } from '@/packages/payments/types';
import { api, dateLabel, money } from '@/lib/client';
import {admitWorkspace,connectWorkspaceSignals,workspaceScope} from '@/lib/workspace-context';
import type {WorkspaceBootstrap} from '@/packages/workspaces/types';

let boot: Promise<SandboxStatus> | null = null;
const callbacks = new Map<string, Promise<SeedRun>>();
const label = (status: string) => ({queued:'Queued',creating:'Creating order',awaiting_buyer:'PayPal approval needed',capturing:'Capturing',verifying:'Verifying',captured:'Capture verified',unknown:'Reconciling',refused:'Provider refused',held:'Held',draft:'Draft',awaiting_consent:'Awaiting consent',ready:'Ready for approval',approved:'Approved',running:'Processing',complete:'Complete',revoked:'Authority revoked'}[status] ?? status.replaceAll('_',' '));

export function SandboxConsole() {
  useEffect(connectWorkspaceSignals,[]);
  const contextState=useSyncExternalStore(workspaceScope.subscribe,workspaceScope.snapshot,workspaceScope.snapshot);
  const [status,setStatus]=useState<SandboxStatus|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState('all');
  const [shown,setShown]=useState(50);
  const [accepted,setAccepted]=useState(false);
  const refresh=useCallback(async()=>{const value=await api<SandboxStatus>('sandbox');setStatus(value);return value;},[]);
  useEffect(()=>{
    let active=true;
    boot ??= api<{workspace:WorkspaceBootstrap}>('session',{}).then(value=>{admitWorkspace(value.workspace.identity.contextId,value.workspace.workspace.id);return api<SandboxStatus>('sandbox');}).catch(error=>{boot=null;throw error;});
    void boot.then(async value=>{
      if(!active)return;
      setStatus(value);
      const params=new URLSearchParams(window.location.search);
      const state=params.get('state');
      if(params.get('cancelled')){setNotice('PayPal approval was cancelled. This batch has not been approved.');window.history.replaceState({},'', '/sandbox');return;}
      if(state && value.run?.consent?.id===params.get('consent')) {
        setBusy('Verifying saved-payment consent');
        let pending=callbacks.get(state);
        if(!pending){pending=api<SeedRun>(`sandbox/runs/${value.run.id}/complete-consent`,{state});callbacks.set(state,pending);}
        try {const result=await pending;if(active){await refresh();if(result.consent?.status==='verified')setNotice('Your saved-payment consent is independently verified with PayPal.');else setError(result.consent?.reason??'PayPal consent verification is still pending. No batch payments are approved.');}}
        catch(error){if(active)setError((error as Error).message);}
        finally {window.history.replaceState({},'', '/sandbox');if(active)setBusy(null);}
      }
    }).catch(error=>{if(active)setError((error as Error).message);});
    return()=>{active=false;};
  },[refresh]);
  useEffect(()=>{
    if(!status?.run || !['approved','running'].includes(status.run.status))return;
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh().catch(()=>{});},5000);
    return()=>clearInterval(timer);
  },[status?.run?.status,refresh]);
  async function perform(name:string,work:()=>Promise<unknown>) {
    if(busy)return;
    setBusy(name);setError(null);setNotice(null);
    try{await work();await refresh();}
    catch(error){setError((error as Error).message);}
    finally{setBusy(null);}
  }
  const run=status?.run;
  const manifest=run?.manifest ?? status?.suggestedManifest;
  const entries=run?.items ?? manifest?.entries.map(entry=>({...entry,status:'queued',providerOrderId:null,providerCaptureId:null,reason:null,observedAt:null})) ?? [];
  const filtered=useMemo(()=>entries.filter(entry=>(filter==='all'||entry.status===filter)&&`${entry.reference} ${entry.product} ${entry.providerCaptureId??''}`.toLowerCase().includes(query.toLowerCase())),[entries,filter,query]);
  const productTotals=useMemo(()=>{
    const values=new Map<string,{count:number;minor:number}>();
    for(const entry of manifest?.entries ?? []){const prior=values.get(entry.product)??{count:0,minor:0};values.set(entry.product,{count:prior.count+1,minor:prior.minor+entry.amountMinor});}
    return [...values.entries()];
  },[manifest]);
  const consentReady=run?.consent?.status==='verified';
  const progress=run?.progress.captured ?? 0;
  function download() {
    if(!manifest)return;
    const cell=(value:unknown)=>'"'+String(value??'').replace(/^[=+@-]/,"'").replaceAll('"','""')+'"';
    const rows=[['Order','Product','Amount USD','Status','Provider order','Provider capture'],...entries.map(entry=>[entry.reference,entry.product,(entry.amountMinor/100).toFixed(2),label(entry.status),entry.providerOrderId,entry.providerCaptureId])];
    const blob=new Blob([rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='glasshouse-sandbox-600-orders.csv';link.click();URL.revokeObjectURL(url);
  }
  if(contextState.held)return <main className="workspace-held-view"><LockKeyhole size={28}/><h1>This workspace access changed.</h1><p>{contextState.reason}</p><Link className="button primary" href="/">Choose your current workspace<ArrowRight size={16}/></Link></main>;
  return <div className="sandbox-shell">
    <header className="sandbox-header"><Link href="/" className="sandbox-brand"><span><Leaf size={20}/></span>glasshouse<i> / </i><small>payment studio</small></Link><Link href="/" className="sandbox-back"><ArrowLeft size={15}/>Back to the incident room</Link></header>
    <main className="sandbox-main">
      <section className="sandbox-hero"><div><div className="sandbox-eyebrow"><i/>PAYPAL SANDBOX · FERNWOOD COFFEE</div><h1>Give the story<br/><em>real payment evidence.</em></h1><p>Connect a sandbox wallet, review every order, and bring independently verified captures into your investigation.</p></div><div className="sandbox-seal"><div><ShieldCheck size={35}/><span>EXACT BATCH</span><strong>600</strong><small>orders. one clear boundary.</small></div><i/><b/></div></section>
      {error&&<div className="sandbox-message error" role="alert"><span>{error}</span><button onClick={()=>setError(null)} aria-label="Dismiss error">Dismiss</button></div>}
      {notice&&<div className="sandbox-message" role="status">{notice}</div>}
      {busy&&<div className="sandbox-message" role="status"><LoaderCircle className="spin" size={18}/>{busy}…</div>}
      {!status&&!error&&<div className="sandbox-loading"><LoaderCircle className="spin"/>Opening your sandbox workspace…</div>}
      {manifest&&<>
        <section className="sandbox-metrics" aria-label="Exact batch limits">
          <div><span>Orders in this batch</span><strong>{manifest.entryCount}</strong><small>Every reference is listed below</small></div>
          <div><span>Exact sandbox total</span><strong>{money(manifest.totalMinor)}</strong><small>USD · sandbox funds</small></div>
          <div><span>Largest single order</span><strong>{money(manifest.maximumOrderMinor)}</strong><small>The per-order ceiling</small></div>
          <div className={progress?'verified':''}><span>Independently verified</span><strong>{progress}<i> / 600</i></strong><small>{money(run?.progress.capturedMinor??0)} captured</small></div>
        </section>
        <div className="sandbox-columns">
          <section className="sandbox-flow" aria-label="Sandbox setup and approval">
            <div className="sandbox-section-title"><span className="sandbox-kicker">A DELIBERATE START</span><h2>From review to receipt</h2><p>Each step leaves a saved record you can return to.</p></div>
            <article className={'sandbox-step '+(run?'done':'active')}><span className="step-number">{run?<Check size={17}/>:1}</span><div><h3>Review the exact 600 orders</h3><p>Five products, the original prices, and a fixed total of {money(manifest.totalMinor)}. This manifest defines the entire batch.</p>{run?<span className="step-complete"><CheckCheck size={15}/>Manifest saved</span>:<button className="sandbox-primary" disabled={!!busy||!status?.canApprove} onClick={()=>void perform('Preparing the exact manifest',()=>api('sandbox/runs',{manifestHash:manifest.hash}))}>Prepare exact batch<ArrowRight size={16}/></button>}</div></article>
            <article className={'sandbox-step '+(consentReady?'done':run?'active':'')}><span className="step-number">{consentReady?<Check size={17}/>:2}</span><div><h3>Connect your sandbox wallet</h3><p>Approve saved payments with PayPal for this Glasshouse batch. We verify the resulting consent directly with PayPal.</p>{consentReady?<span className="step-complete"><ShieldCheck size={15}/>Consent verified {run?.consent?.verifiedAt&&<time>{dateLabel(run.consent.verifiedAt)} UTC</time>}</span>:run?.consent?.approvalUrl?<a className="sandbox-paypal" href={run.consent.approvalUrl}>Continue to PayPal<ExternalLink size={16}/></a>:<button className="sandbox-paypal" disabled={!!busy||!run||!!run.consent||!status?.configured||!status.canApprove} onClick={()=>void perform('Preparing PayPal approval',()=>api(`sandbox/runs/${run!.id}/connect`,{manifestHash:manifest.hash}))}><Wallet size={17}/>Connect a sandbox wallet</button>}
              {run?.consent?.reason&&<p className="sandbox-held">{run.consent.reason}</p>}
              {run?.consent&&['unknown','exchanging','refused'].includes(run.consent.status)&&<button className="sandbox-text-button" disabled={!!busy} onClick={()=>void perform('Checking the saved-payment outcome',()=>api(`sandbox/runs/${run.id}/complete-consent`,{}))}><RefreshCw size={15}/>Resume original consent</button>}
            </div></article>
            <article className={'sandbox-step '+(run&&['approved','running','complete'].includes(run.status)?'done':consentReady?'active':'')}><span className="step-number">{run&&['approved','running','complete'].includes(run.status)?<Check size={17}/>:3}</span><div><h3>Approve the batch. Follow every result.</h3><p>The approval covers these 600 exact orders for 30 minutes. Captures appear in the incident room after their amounts and ownership are independently checked.</p>
              {run?.status==='ready'?<><label className="sandbox-accept"><input type="checkbox" checked={accepted} onChange={event=>setAccepted(event.target.checked)}/><span>I authorize this exact sandbox batch: 600 orders totaling {money(manifest.totalMinor)}, with no order above {money(manifest.maximumOrderMinor)}.</span></label><button className="sandbox-primary" disabled={!!busy||!accepted||!status?.canApprove} onClick={()=>void perform('Saving the exact batch approval',()=>api(`sandbox/runs/${run.id}/approve`,{manifestHash:manifest.hash}))}>Approve {money(manifest.totalMinor)} sandbox batch<ArrowRight size={16}/></button></>:run&&['approved','running'].includes(run.status)?<><span className="step-complete"><CheckCheck size={15}/>Approved until {dateLabel(run.approvalExpiresAt!)} UTC</span><button className="sandbox-primary" disabled={!!busy} onClick={()=>void perform('Processing approved orders',()=>api(`sandbox/runs/${run.id}/process`,{}))}>Continue processing<ArrowRight size={16}/></button><p className="sandbox-step-note">Your progress is saved. Closing this page preserves every original operation.</p></>:run?.status==='complete'?<Link className="sandbox-primary" href="/">Explore all 600 verified payments<ArrowRight size={16}/></Link>:<span className="sandbox-locked"><LockKeyhole size={14}/>{run?.status==='revoked'?'Batch authority has been revoked':'Available after verified consent'}</span>}
            </div></article>
          </section>
          <aside className="sandbox-summary"><div className="sandbox-kicker">THE BATCH, AT A GLANCE</div><h2>Fernwood’s order book</h2><div className="sandbox-product-list">{productTotals.map(([product,value])=><div key={product}><span>{product}<small>{value.count} orders</small></span><strong>{money(value.minor)}</strong></div>)}</div><div className="sandbox-summary-total"><span>Exact total</span><strong>{money(manifest.totalMinor)}</strong></div><div className="sandbox-proof"><ShieldCheck size={20}/><div><strong>{status?.isolated?'Isolated Glasshouse sandbox':'Sandbox connection pending'}</strong><p>{status?.configured?'PayPal order and capture evidence belongs to this workspace.':'The isolated provider connection must be configured before saved-payment setup.'}</p></div></div><div className="sandbox-manifest-hash"><span>MANIFEST FINGERPRINT</span><code title={manifest.hash}>{manifest.hash}</code></div><button className="sandbox-download" onClick={download}><Download size={16}/>Download all 600 entries</button></aside>
        </div>
        <section className="sandbox-ledger"><div className="sandbox-ledger-heading"><div><span className="sandbox-kicker">NOTHING HIDDEN IN THE TOTAL</span><h2>Every order. Every outcome.</h2></div><button className="sandbox-refresh" disabled={!!busy} onClick={()=>void perform('Refreshing saved progress',refresh)}><RefreshCw size={16}/>Refresh</button></div>
          {run&&<div className="sandbox-progress"><div><span>{label(run.status)}</span><strong>{progress} of 600 captures verified</strong></div><progress max={600} value={progress} aria-label="Verified sandbox captures"/>{(run.progress.unknown>0||run.progress.refused>0||run.progress.held>0)&&<p>{run.progress.unknown} reconciling · {run.progress.refused} refused · {run.progress.held} held. Unconfirmed outcomes keep their original operation.</p>}</div>}
          <div className="sandbox-filters"><label><Search size={17}/><input aria-label="Find an order in the sandbox manifest" placeholder="Find an order, product, or capture…" value={query} onChange={event=>{setQuery(event.target.value);setShown(50);}}/></label><label className="sandbox-filter-status"><span>Status</span><select value={filter} onChange={event=>{setFilter(event.target.value);setShown(50);}} aria-label="Filter sandbox orders by status"><option value="all">All outcomes</option><option value="captured">Verified captures</option><option value="queued">Queued</option><option value="unknown">Reconciling</option><option value="refused">Refused</option><option value="held">Held</option><option value="awaiting_buyer">PayPal approval needed</option></select><ChevronDown size={14}/></label></div>
          <div className="sandbox-ledger-columns" aria-hidden="true"><span>ORDER / PRODUCT</span><span>AMOUNT</span><span>OUTCOME</span><span>PROVIDER EVIDENCE</span></div>
          <div className="sandbox-entry-list">{filtered.slice(0,shown).map(entry=><article className="sandbox-entry" key={entry.orderId}><div><strong>{entry.reference}</strong><span>{entry.product}</span></div><div className="sandbox-entry-amount">{money(entry.amountMinor)}<small>USD</small></div><div><span className={'sandbox-outcome '+entry.status}>{entry.status==='captured'&&<Check size={13}/>} {label(entry.status)}</span>{entry.reason&&<small className="sandbox-entry-reason">{entry.reason}</small>}</div><div className="sandbox-entry-proof">{entry.providerCaptureId?<><span>Capture <code>{entry.providerCaptureId}</code></span><small>{entry.observedAt?dateLabel(entry.observedAt)+' UTC':'Provider read recorded'}</small></>:entry.providerOrderId?<span>Order <code>{entry.providerOrderId}</code></span>:<span className="sandbox-muted">Awaiting provider evidence</span>}</div></article>)}</div>
          {!filtered.length&&<p className="sandbox-empty">No orders match these filters.</p>}
          <div className="sandbox-ledger-footer"><span>Showing {Math.min(shown,filtered.length)} of {filtered.length} matching orders · {manifest.entryCount} in the full batch</span>{shown<filtered.length&&<button onClick={()=>setShown(value=>value+50)}>Show 50 more<ArrowRight size={15}/></button>}</div>
        </section>
        {run?.consent&&run.status!=='revoked'&&<div className="sandbox-revoke"><div><strong>Stay in control of future payments.</strong><p>Revoking this batch stops new submissions. Already submitted outcomes remain available to reconcile.</p></div><button disabled={!!busy} onClick={()=>void perform('Revoking future batch authority',()=>api(`sandbox/runs/${run.id}/revoke`,{}))}><Pause size={15}/>Revoke batch authority</button></div>}
      </>}
      <footer className="sandbox-footer"><span><Leaf size={14}/>Glasshouse</span><p>Clear sources. Exact approvals. Evidence you can follow.</p><Link href="/">Return to the incident room<ArrowRight size={14}/></Link></footer>
    </main>
  </div>;
}
