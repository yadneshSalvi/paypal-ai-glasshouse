'use client';
import { useId,useState } from 'react';
import { Check,Clock3,LockKeyhole,ShieldCheck,X } from 'lucide-react';
import type { OrderDetail,ProviderReceiptView } from '@/packages/domain/order-detail';
import type { Snapshot } from '@/packages/domain/types';
import { dateLabel,money,sourceLabel } from '@/lib/client';

export function OrderRecord({detail,snapshot}:{detail:OrderDetail;snapshot:Snapshot}){
  const [tab,setTab]=useState('evidence'),tabsId=useId();
  const order=detail.order,eligibility=snapshot.branches.find(branch=>branch.id==='targeted')?.rows.find(row=>row.orderId===order.id);
  const tabs=['evidence','timeline','eligibility','provider'];
  const currentTime=(event:OrderDetail['events'][number])=>detail.context.clockDomain==='observed'?event.occurredAt:event.narrativeTime;
  return <>
    <div className="order-state-grid">
      <div><span>Payment</span><strong>{order.paymentState.replaceAll('_',' ')}</strong><small>{sourceLabel(order.paymentSource)}</small></div>
      <div><span>Fulfillment</span><strong>{order.fulfillmentState.replaceAll('_',' ')}</strong><small>Fixture shipping</small></div>
      <div><span>Remediation</span><strong>{order.remediationState.replaceAll('_',' ')}</strong><small>{money(order.refundedMinor)} refunded</small></div>
      <div><span>Dispute</span><strong>{order.disputeState?.replaceAll('_',' ')||'Not observed'}</strong><small>{sourceLabel(order.disputeSource)}</small></div>
    </div>
    <div className="drawer-amount"><span>Order record amount</span><strong>{money(order.amountMinor,order.currency)}</strong></div>
    <div className="order-cutoff"><Clock3 size={16}/><div><span>Business time {dateLabel(detail.context.asOf)} UTC</span><span>Evidence known by {dateLabel(detail.context.knownAt)} UTC</span></div></div>
    <div className="drawer-tabs" role="tablist" aria-label="Order record views" onKeyDown={event=>{
      const index=tabs.indexOf(tab),next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
      if(next===null)return;event.preventDefault();setTab(tabs[next]);document.getElementById(`${tabsId}-${tabs[next]}`)?.focus();
    }}>{tabs.map(value=><button key={value} id={`${tabsId}-${value}`} role="tab" aria-selected={tab===value} aria-controls={`${tabsId}-panel`} tabIndex={tab===value?0:-1} className={tab===value?'active':''} onClick={()=>setTab(value)}>{value==='provider'?'PayPal receipts':value}</button>)}</div>
    <section id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} tabIndex={0}>
      {tab==='evidence'&&<div className="drawer-evidence">{detail.evidence.length?detail.evidence.map(evidence=><article key={evidence.id}>
        <span className="source-chip">{sourceLabel(evidence.sourceClass)}</span><h3>{evidence.title}</h3><blockquote>{evidence.excerpt}</blockquote>
        <small>{evidence.id}<br/>Record time {dateLabel(evidence.occurredAt)} · received {dateLabel(evidence.ingestedAt)} UTC</small>
        {evidence.untrusted&&<p className="untrusted-note"><ShieldCheck size={14}/>Source content is evidence, never an instruction to the agent.</p>}
      </article>):<p className="quiet-label">No order-specific excerpts are visible at this cutoff. The cohort finding remains separately cited.</p>}</div>}
      {tab==='timeline'&&<div className="order-timeline">{detail.events.map(event=><article key={event.id}>
        <span className={'timeline-dot '+event.dimension}/><small>{dateLabel(currentTime(event))} UTC</small><h3>{event.type.replaceAll('_',' ').replaceAll('.',' · ')}</h3>
        <p>{event.dimension} → {event.state.replaceAll('_',' ')}</p><span className="source-chip">{sourceLabel(event.sourceClass)}</span>
        <details><summary>Source clocks and identity</summary><dl><div><dt>Occurred</dt><dd>{event.occurredAt}</dd></div><div><dt>Received</dt><dd>{event.ingestedAt}</dd></div><div><dt>Story time</dt><dd>{event.narrativeTime}</dd></div><div><dt>Source</dt><dd>{event.sourceRef}</dd></div></dl></details>
      </article>)}</div>}
      {tab==='eligibility'&&<div className="eligibility-detail"><h3>Targeted goodwill</h3><p>Policy at the selected business time and evidence cutoff.</p>
        {eligibility?eligibility.conditions.map(condition=><div key={condition.key}><span className={condition.passed?'pass':'fail'}>{condition.passed?<Check size={16}/>:<X size={16}/>}</span><span>{condition.label}</span><small>{condition.passed?'Pass':'Excluded'}</small></div>):<p>This order is outside the incident cohort.</p>}
        {eligibility&&<strong className={eligibility.eligible?'mint-text':'amber-text'}>{eligibility.eligible?'Eligible for a proposed $5 refund':'Excluded from this branch'}</strong>}
      </div>}
      {tab==='provider'&&<div className="provider-detail"><div className="provider-icon"><LockKeyhole size={24}/></div><h3>{detail.providerStatus}</h3>
        <p>These are saved independent PayPal reads admitted by this snapshot. Their actual provider and observation times are kept separate from the story week.</p>
        <dl><div><dt>Capture</dt><dd>{order.captureId||'No provider capture at this cutoff'}</dd></div><div><dt>PayPal order</dt><dd>{order.paypalOrderId||'No provider order at this cutoff'}</dd></div><div><dt>Case</dt><dd>{order.disputeId||'No provider case at this cutoff'}</dd></div></dl>
        <div className="provider-receipts">{detail.providerReceipts.map(receipt=><Receipt key={receipt.sourceEventId} receipt={receipt}/>)}</div>
      </div>}
    </section>
  </>;
}

function Receipt({receipt}:{receipt:ProviderReceiptView}){
  const label={capture:'Capture verified',refund:'Refund verified',tracking:'Tracking assignment verified',dispute:'Case observation'}[receipt.kind];
  return <article className="provider-receipt"><header><span><ShieldCheck size={16}/>{label}</span><strong>{receipt.amountMinor===null?'':money(receipt.amountMinor,receipt.currency||'USD')}</strong></header>
    <p className="receipt-status">{receipt.status.replaceAll('_',' ')}</p><code>{receipt.id}</code>
    <dl><div><dt>Provider time</dt><dd>{receipt.occurredAt?dateLabel(receipt.occurredAt)+' UTC':'Not supplied by PayPal'}</dd></div><div><dt>Independently read</dt><dd>{dateLabel(receipt.observedAt)} UTC</dd></div>
      {receipt.kind==='dispute'&&<><div><dt>Seller deadline</dt><dd>{receipt.sellerResponseDueAt?dateLabel(receipt.sellerResponseDueAt)+' UTC':'Not supplied in this observation'}</dd></div><div><dt>Seller evidence records</dt><dd>{receipt.submittedEvidence}</dd></div></>}
    </dl>
    {receipt.kind==='tracking'&&<p className="receipt-qualification"><strong>Synthetic shipping.</strong> {receipt.trackingNumber} · {receipt.carrierName}. The owning-order read confirms the returned tracker identity and status; these shipment fields come from the approved request. No physical delivery is asserted.</p>}
    {receipt.kind==='dispute'&&<p className="receipt-qualification">Evidence submission and case resolution are separate outcomes. This card preserves the provider state actually observed at this time.</p>}
    <details><summary>Receipt fingerprint</summary><code>{receipt.bodyHash}</code></details>
  </article>;
}
