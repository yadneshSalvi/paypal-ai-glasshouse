'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {ArrowUpRight,Check,ChevronLeft,ChevronRight,Download,FileCheck2,Search,ShieldCheck,X} from 'lucide-react';
import type {proposalEvidence} from '@/lib/server/agents/proposal-evidence';
import {money} from '@/lib/client';

export type ProposalEvidence=ReturnType<typeof proposalEvidence>;
export function isProposalEvidence(value:unknown):value is ProposalEvidence {
  if(!value||typeof value!=='object')return false;
  const v=value as Partial<ProposalEvidence>;
  return v.evidenceSource==='saved_immutable_proposal'&&v.hashVerified===true&&typeof v.id==='string'&&typeof v.hash==='string'&&!!v.manifest&&[2,3].includes(v.manifest.contractVersion??0)&&!!v.manifest.context&&Array.isArray(v.manifest.branch?.actions)&&Array.isArray(v.manifest.branch?.rows)&&Array.isArray(v.eligibleOrderIds)&&Array.isArray(v.excludedOrders)&&!!v.policy&&!!v.approval;
}
export function proposalDownload(evidence:ProposalEvidence){return {filename:`glasshouse-${evidence.id}-evidence.json`,body:JSON.stringify(evidence,null,2)};}
function download(evidence:ProposalEvidence){
  const saved=proposalDownload(evidence),link=document.createElement('a'),url=URL.createObjectURL(new Blob([saved.body],{type:'application/json'}));
  link.href=url;link.download=saved.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function ProposalEvidenceCard({evidence,onReviewPlan}:{evidence:ProposalEvidence;onReviewPlan?:(id:string)=>void}){
  const [open,setOpen]=useState(false);
  return <div className="agent-proposal"><span className="eyebrow">SAVED PROPOSAL EVIDENCE</span><strong>{money(evidence.refundTotalMinor)}</strong><p>{evidence.eligibleCount} eligible refunds · {evidence.manifest.branch.actions.length} exact actions</p><p>Hash verified at this recorded read. No approval or execution was granted by the tool.</p><button className="button" onClick={()=>setOpen(true)}>Inspect complete manifest<ArrowUpRight size={13}/></button>{open&&<ProposalEvidenceDialog evidence={evidence} onClose={()=>setOpen(false)} onReviewPlan={onReviewPlan}/>}</div>;
}
function ProposalEvidenceDialog({evidence,onClose,onReviewPlan}:{evidence:ProposalEvidence;onClose():void;onReviewPlan?:(id:string)=>void}){
  const ref=useRef<HTMLDialogElement>(null),titleId=useId();
  useEffect(()=>{const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;ref.current?.showModal();return()=>{if(opener?.isConnected)opener.focus();};},[]);
  return <dialog ref={ref} className="proposal-evidence-dialog" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>event.stopPropagation()}>
    <header><div className="proposal-evidence-symbol"><FileCheck2 size={23}/></div><div><span className="eyebrow">THE COMPLETE SAVED RECORD</span><h2 id={titleId}>Every action. Every exclusion.</h2></div><button className="icon-button" onClick={onClose} aria-label="Close saved proposal evidence"><X size={19}/></button></header>
    <ProposalManifest evidence={evidence}/>
    <footer><span><ShieldCheck size={15}/>Recorded evidence only</span><button className="button" onClick={()=>download(evidence)}><Download size={15}/>Download complete JSON</button>{onReviewPlan&&<button className="button" onClick={()=>{onClose();onReviewPlan(evidence.id);}}>Open current review<ArrowUpRight size={14}/></button>}</footer>
  </dialog>;
}
const kinds={refund:'Refund',tracking:'Tracking',dispute_response:'Dispute evidence'};
const sources={sample:'Sample',fixture_shipping:'Fixture shipping',fixture_support:'Fixture support',sandbox:'Sandbox',replay:'Replay',modelled:'Modelled'};
const pageSize=25;
/** Renders the exact receipt, never an agent-authored reconstruction. */
export function ProposalManifest({evidence}:{evidence:ProposalEvidence}){
  const [tab,setTab]=useState<'actions'|'eligibility'>('actions'),[query,setQuery]=useState(''),[page,setPage]=useState(0);
  const {manifest}=evidence,{branch,context}=manifest,searchId=useId();
  const needle=query.trim().toLowerCase();
  const actions=branch.actions.filter(row=>!needle||[row.id,row.orderId,row.reference,row.kind,row.payload.operationId,row.sourceClass,row.eligibility,row.blockedReason].join(' ').toLowerCase().includes(needle));
  const eligibility=branch.rows.filter(row=>!needle||[row.orderId,row.eligible?'eligible':'excluded',...row.excludedReasons].join(' ').toLowerCase().includes(needle));
  const total=tab==='actions'?actions.length:eligibility.length,maxPage=Math.max(0,Math.ceil(total/pageSize)-1),currentPage=Math.min(page,maxPage),start=currentPage*pageSize;
  const changeTab=(next:typeof tab)=>{setTab(next);setPage(0);setQuery('');};
  return <div className="proposal-evidence-body">
    <div className="proposal-evidence-totals"><div><span>Refund proposal</span><strong>{money(evidence.refundTotalMinor)}</strong><small>of {money(evidence.budgetMinor)} cap</small></div><div><span>Eligible / excluded</span><strong>{evidence.eligibleOrderIds.length}<em> / {evidence.excludedOrders.length}</em></strong><small>{branch.rows.length} exact policy rows</small></div><div><span>Companion actions</span><strong>{evidence.trackingCount+evidence.disputeCount}</strong><small>{evidence.trackingCount} tracking · {evidence.disputeCount} dispute</small></div></div>
    <div className="proposal-evidence-note"><Check size={16}/><p>The server verified this complete manifest against its saved hash. The status below is from the recorded read; current review checks authority again.</p></div>
    <dl className="proposal-evidence-identity"><div><dt>Proposal</dt><dd><code>{evidence.id}</code></dd></div><div><dt>Manifest hash</dt><dd><code>{evidence.hash}</code></dd></div><div><dt>Snapshot</dt><dd><code>{evidence.snapshotHash}</code></dd></div><div><dt>Evidence clocks</dt><dd><span>T {context.asOf}</span><span>K {context.knownAt}</span><small>{context.clockDomain.replaceAll('_',' ')} · {context.sourceMode} · cohort v{context.cohortVersion}</small></dd></div><div><dt>Policy</dt><dd>{evidence.policy.id} · {evidence.policy.graceHours}-hour grace<small>{evidence.sourceClasses.map(source=>sources[source]).join(' · ')}</small></dd></div><div><dt>Recorded status</dt><dd>{evidence.status.replaceAll('_',' ')}<small>{evidence.approval.approvedAt?`Approved at ${evidence.approval.approvedAt}`:'No recorded approval'} · execution not started by this tool</small></dd></div></dl>
    <p className={'proposal-policy-note '+(evidence.policy.comparisonOnly?'comparison':'')}>{evidence.disclosure}</p>
    <div className="proposal-evidence-tabs" role="group" aria-label="Manifest table"><button aria-pressed={tab==='actions'} onClick={()=>changeTab('actions')}>Exact actions <span>{branch.actions.length}</span></button><button aria-pressed={tab==='eligibility'} onClick={()=>changeTab('eligibility')}>Policy rows <span>{branch.rows.length}</span></button></div>
    <label className="proposal-evidence-search" htmlFor={searchId}><Search size={15}/><span className="sr-only">Search exact manifest rows</span><input id={searchId} value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}} placeholder="Search order, action, operation or reason…"/></label>
    <div className="proposal-evidence-table" tabIndex={0} role="region" aria-label={tab==='actions'?'Exact saved actions, horizontally scrollable':'Exact policy eligibility, horizontally scrollable'}>
      {tab==='actions'?<table><caption className="sr-only">Saved action identities, amounts, sources and provider eligibility</caption><thead><tr><th scope="col">Order / action</th><th scope="col">Exact identities</th><th scope="col">Amount</th><th scope="col">Source / provider eligibility</th></tr></thead><tbody>{actions.slice(start,start+pageSize).map(row=><tr key={row.id}><td><strong>{row.reference}</strong><small>{kinds[row.kind]}</small><code>{row.orderId}</code></td><td><span>Action</span><code>{row.id}</code><span>Operation</span><code>{typeof row.payload.operationId==='string'?row.payload.operationId:'Not present in this saved receipt'}</code></td><td>{money(row.amountMinor,row.currency)}</td><td>{sources[row.sourceClass]}<small>{row.eligibility}</small>{row.blockedReason&&<p>{row.blockedReason}</p>}</td></tr>)}</tbody></table>:<table><caption className="sr-only">Exact eligible orders and excluded orders with policy conditions</caption><thead><tr><th scope="col">Order</th><th scope="col">Decision</th><th scope="col">Conditions</th></tr></thead><tbody>{eligibility.slice(start,start+pageSize).map(row=><tr key={row.orderId}><td><code>{row.orderId}</code></td><td><strong>{row.eligible?'Eligible':'Excluded'}</strong>{row.excludedReasons.map(reason=><p key={reason}>{reason}</p>)}</td><td>{row.conditions.map(condition=><small key={condition.key}>{condition.passed?'Passed':'Not met'} · {condition.label}</small>)}</td></tr>)}</tbody></table>}
      {total===0&&<p className="proposal-evidence-empty">No saved rows match this search.</p>}
    </div>
    <div className="proposal-evidence-pages"><span>{total?`${start+1}–${Math.min(start+pageSize,total)} of ${total}`:'0 matches'}{needle?' matching rows':' saved rows'}</span><button className="icon-button" aria-label="Previous manifest page" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={17}/></button><button className="icon-button" aria-label="Next manifest page" disabled={currentPage===maxPage} onClick={()=>setPage(currentPage+1)}><ChevronRight size={17}/></button></div>
  </div>;
}
