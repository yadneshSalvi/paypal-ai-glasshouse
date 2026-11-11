'use client';
import {use,useEffect,useState} from 'react';
import type {AgWidgetParams,AgWidgetField} from 'ag-studio';
import {ArrowRight,ArrowUpRight,Clock3,FileText,GitBranch,Globe2,Layers3,ScanLine,ShieldCheck,SlidersHorizontal,Truck,TriangleAlert,Check,ChevronRight,RotateCcw,Table2} from 'lucide-react';
import type {SnapshotOrder} from '../domain/types';
import type {InstrumentData,StudioBridge} from './types';
import {money,dateLabel,sourceLabel} from '@/lib/client';

type Props=AgWidgetParams<InstrumentData,unknown,StudioBridge>;
const color={mint:'#7fbbab',cyan:'#72b9c4',amber:'#e5b77d',rose:'#ee897c',dim:'#546777'};
function mapped(row:Record<string,unknown>,field:AgWidgetField|undefined):unknown{return field?row[field.key]:undefined;}
function useOrders(p:Props,highlight=false,ignoreFilter=false){
  const fields=Object.values(p.dataMapping).flat().filter(Boolean) as AgWidgetField[];
  const response=use(p.widgetApi.getData({fields},{queryId:p.widgetId+'-orders',crossFilter:ignoreFilter?'none':highlight?'highlight':'filter'}));
  const snap=p.context.getSnapshot();
  const ids=new Set(response.results.rows.map(r=>String(mapped(r,p.dataMapping.orderId?.[0]))));
  const subsetIds=response.crossFilter?new Set(response.crossFilter.rows.map(r=>String(mapped(r,p.dataMapping.orderId?.[0])))):null;
  const all=snap.orders.filter(o=>ids.has(o.id));
  const subset=subsetIds?all.filter(o=>subsetIds.has(o.id)):all;
  const queryHash=p.dataMapping.snapshot?.[0];
  const ready=!queryHash||response.results.rows.every(r=>mapped(r,queryHash)===snap.hash);
  useEffect(()=>{if(ready)p.context.onWidgetReady(p.widgetId,snap.hash,all.length,subset.length);},[snap.hash,all.length,subset.length,p.context,p.widgetId,ready]);
  return {all,subset,snap,highlighted:subsetIds!==null};
}
function WidgetHead({n,label,title,aside}:{n:string;label:string;title:string;aside?:React.ReactNode}){
  return <div className="widget-head"><div><div className="eyebrow"><span className="widget-number">{n}</span>{label}</div><h2>{title}</h2></div>{aside}</div>;
}
function Source({value}:{value:string}){return <span className={'source-chip source-'+value}>{sourceLabel(value)}</span>;}
function TableToggle({active,onClick}:{active:boolean;onClick:()=>void}){return <button className={'icon-button '+(active?'active':'')} aria-pressed={active} aria-label={active?'Show commerce flow':'Show precise order table'} title={active?'Show commerce flow':'Show precise order table'} onClick={onClick}><Table2 size={17}/></button>;}
function StateTable({orders,onOrder}:{orders:SnapshotOrder[];onOrder:(id:string)=>void}){
  return <div className="widget-table"><table><thead><tr><th>Order</th><th>Fulfillment</th><th>Payment</th><th>Amount</th></tr></thead><tbody>{orders.slice(0,150).map(o=><tr key={o.id}><td><button onClick={()=>onOrder(o.id)}>{o.reference}</button></td><td>{o.fulfillmentState}</td><td>{sourceLabel(o.paymentSource)}</td><td>{money(o.amountMinor)}</td></tr>)}</tbody></table>{orders.length>150&&<p>Showing 150 of {orders.length} selected orders.</p>}</div>;
}
function ribbon(x1:number,y1:number,x2:number,y2:number,w:number){const bend=(x2-x1)*.5;return `M${x1},${y1} C${x1+bend},${y1} ${x2-bend},${y2} ${x2},${y2} L${x2},${y2+w} C${x2-bend},${y2+w} ${x1+bend},${y1+w} ${x1},${y1+w} Z`;}
export function CommerceRiver(p:Props){
  const {all,subset,snap,highlighted}=useOrders(p,true);
  const [table,setTable]=useState(false);
  const selectedIds=new Set(subset.map(order=>order.id));
  const groups=[{key:'delivered',name:'Delivered',color:color.mint,y:82},{key:'in_transit',name:'In transit',color:color.cyan,y:184},{key:'delayed',name:'Delayed',color:color.rose,y:272},{key:'unknown',name:'Awaiting dispatch',color:color.dim,y:352}].map(g=>({...g,rows:all.filter(o=>g.key==='unknown'?!['delivered','in_transit','delayed'].includes(o.fulfillmentState.toLowerCase()):o.fulfillmentState.toLowerCase()===g.key)})).filter(g=>g.rows.length>0);
  let offset=107;
  const tracks=groups.map(g=>{const height=Math.max(10,g.rows.length/Math.max(1,all.length)*178);const result={...g,start:offset,height,selected:g.rows.filter(o=>selectedIds.has(o.id)).length};offset+=height+4;return result;});
  const choose=(state:string)=>{const f=p.dataMapping.category?.[0];if(f)p.widgetApi.toggleCrossFilter({type:'value',field:f,value:state,group:0});};
  return <section className="instrument river-instrument" data-widget="commerce-river" data-snapshot={snap.hash} data-total={all.length} data-selected={subset.length}>
    <WidgetHead n="01" label="COMMERCE RIVER" title="A business, in motion." aside={<div className="head-actions"><span className="quiet-label">Inventory at this moment</span><TableToggle active={table} onClick={()=>setTable(!table)}/></div>}/>
    {table||p.format?.showTable?<StateTable orders={subset} onOrder={p.context.onOrder}/>:<><div className="river-state-cards" aria-label="Commerce flow by fulfillment state"><p><strong>{all.length}</strong> orders in context · {subset.length} selected</p>{tracks.map(g=><button key={g.key} onClick={()=>choose(g.key)} aria-label={`Select ${g.rows.length} ${g.name.toLowerCase()} orders`} style={{'--state-color':g.color} as React.CSSProperties}><span className="river-card-title"><i/>{g.name}</span><strong>{g.rows.length}</strong><span className="river-card-bar" aria-hidden="true"><i style={{width:`${Math.max(2,g.rows.length/Math.max(1,all.length)*100)}%`}}/></span><small>{highlighted?`${g.selected} in shared selection`:'Select to inspect the same orders in every view'}</small><ArrowUpRight size={16}/></button>)}</div><div className="river-canvas">
      <svg viewBox="0 0 1000 425" role="img" aria-label={`Commerce river. ${all.length} orders, ${subset.length} selected. Click a state to highlight it across the workspace.`}>
        <defs><pattern id="river-dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".8" fill="#f5b6ab" opacity=".5"/></pattern><linearGradient id="river-wash"><stop stopColor="#72b9c4" stopOpacity=".05"/><stop offset="1" stopColor="#72b9c4" stopOpacity=".22"/></linearGradient></defs>
        {[78,294,538,824].map((x,i)=><g key={x}><line x1={x} x2={x} y1="40" y2="384" stroke="#40515d" strokeOpacity=".18" strokeDasharray="2 6"/><text x={x} y="24" className="river-step">{['01 / RECEIVED','02 / PAYMENT','03 / FULFILLMENT','04 / OUTCOME'][i]}</text></g>)}
        {tracks.map(g=><g key={g.key} className="river-band" onClick={()=>choose(g.key)} tabIndex={0} role="button" aria-label={`Select ${g.rows.length} ${g.name.toLowerCase()} orders`} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(g.key);}}}>
          <path d={ribbon(82,g.start,294,g.start-7,g.height)} fill={g.color} opacity=".13"/>
          <path d={ribbon(298,g.start-7,538,g.y,g.height)} fill={g.color} opacity=".19"/>
          <path d={ribbon(542,g.y,824,g.y,g.height)} fill={g.color} opacity=".18"/>
          {g.selected>0&&<><path d={ribbon(82,g.start+g.height*.18,294,g.start-7+g.height*.18,Math.max(3,g.height*g.selected/Math.max(1,g.rows.length)*.64))} fill={g.color} opacity={highlighted?.48:.28}/><path d={ribbon(298,g.start-7+g.height*.18,538,g.y+g.height*.18,Math.max(3,g.height*g.selected/Math.max(1,g.rows.length)*.64))} fill={g.color} opacity={highlighted?.6:.32}/><path d={ribbon(542,g.y+g.height*.18,824,g.y+g.height*.18,Math.max(3,g.height*g.selected/Math.max(1,g.rows.length)*.64))} fill={g.color} opacity={highlighted?.7:.4}/>{g.key==='delayed'&&<path d={ribbon(542,g.y,824,g.y,g.height)} fill="url(#river-dots)"/>}</>}
          <rect x="824" y={g.y} width="3" height={Math.max(7,g.height)} fill={g.color}/><text x="846" y={g.y+13} className="river-state-label" fill={g.color}>{g.name}</text><text x="846" y={g.y+38} className="river-state-value">{g.rows.length.toLocaleString()}</text>
          {g.key==='delayed'&&<><path d={`M687,${g.y+g.height+6}L687,382L574,382`} fill="none" stroke={color.rose} strokeOpacity=".55"/><circle cx="687" cy={g.y+g.height+6} r="3" fill={color.rose}/><text x="421" y="386" className="river-annotation">THE SIGNAL BEGINS HERE</text></>}
        </g>)}
        <rect x="76" y="100" width="4" height={offset-100} rx="2" fill={color.cyan}/><rect x="292" y="92" width="4" height={offset-100} rx="2" fill={color.cyan}/>
        <text x="78" y="69" className="river-node-value">{all.length.toLocaleString()}</text><text x="78" y="89" className="river-node-label">store orders</text><text x="294" y="62" className="river-node-value">{all.filter(o=>o.paymentState.toLowerCase()==='captured'||o.paymentState.toLowerCase()==='completed').length.toLocaleString()}</text><text x="294" y="82" className="river-node-label">payment records</text>
      </svg>
    </div></>}
    <div className="river-footer"><div className="legend"><span><i style={{background:color.mint}}/>Delivered</span><span><i style={{background:color.cyan}}/>In transit</span><span><i style={{background:color.rose}}/>Delayed</span></div><span>{highlighted?<><strong>{subset.length}</strong> selected · {all.length} in context</>:<>{all.length} orders in context</>}</span><Source value={snap.sourceCoverage.sandboxPayments?'sandbox':'sample'}/></div>
  </section>;
}

export function TimeDial(p:Props){
  const {snap,all}=useOrders(p,false,true);
  const start=Date.parse('2026-11-02T00:00:00Z'),end=Date.parse('2026-11-06T10:00:00Z');
  const progress=Math.max(0,Math.min(1,(Date.parse(snap.context.asOf)-start)/(end-start)));
  const [draft,setDraft]=useState(progress);useEffect(()=>setDraft(progress),[progress]);
  const [exact,setExact]=useState(snap.context.asOf.slice(0,16));useEffect(()=>setExact(snap.context.asOf.slice(0,16)),[snap.context.asOf]);
  const angle=(-128+draft*256)*Math.PI/180;
  const change=(v:number)=>{setDraft(v);p.context.onTime(new Date(start+v*(end-start)).toISOString());};
  return <section className="instrument dial-instrument" data-widget="time-dial" data-snapshot={snap.hash}>
    <WidgetHead n="02" label="TIME DIAL" title="Rewind the evidence."/>
    <div className="dial-face"><svg viewBox="0 0 280 230" aria-hidden="true"><defs><linearGradient id="dial-grad"><stop stopColor="#506170"/><stop offset="1" stopColor="#d8ba82"/></linearGradient></defs><path d="M57 190 A105 105 0 1 1 223 190" fill="none" stroke="#27323b" strokeWidth="1"/>{Array.from({length:49},(_,i)=>{const a=(-128+i/48*256)*Math.PI/180;const r=i%6===0?102:107;return <line key={i} x1={140+Math.sin(a)*r} y1={120-Math.cos(a)*r} x2={140+Math.sin(a)*114} y2={120-Math.cos(a)*114} stroke={i/48<=draft?'#e3c08a':'#34434d'} strokeWidth={i%6===0?1.5:1}/>;})}<path d="M75 174 A84 84 0 1 1 205 174" fill="none" stroke="#486369" strokeWidth="1" strokeDasharray="1 4"/><circle cx={140+Math.sin(angle)*105} cy={120-Math.cos(angle)*105} r="5" fill="#f0ce95"/><circle cx={140+Math.sin(angle)*105} cy={120-Math.cos(angle)*105} r="10" fill="#f0ce95" opacity=".12"/><text x="140" y="101" textAnchor="middle" className="dial-date">{new Date(snap.context.asOf).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'})}</text><text x="140" y="139" textAnchor="middle" className="dial-time">{new Date(snap.context.asOf).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'})}</text><text x="140" y="161" textAnchor="middle" className="dial-clock">STORY CLOCK · UTC</text><text x="48" y="216" className="dial-boundary">MON 02</text><text x="195" y="216" className="dial-boundary">FRI 06</text></svg></div>
    <label className="time-slider"><span className="sr-only">Reconstruct the business at this time</span><input type="range" min="0" max="1" step="0.001" value={draft} onChange={e=>setDraft(Number(e.target.value))} onPointerUp={()=>change(draft)} onKeyUp={e=>{if(e.key.startsWith('Arrow')||e.key==='Home'||e.key==='End')change(draft);}}/></label>
    <form className="exact-time" onSubmit={e=>{e.preventDefault();const value=Date.parse(exact+':00Z');if(Number.isFinite(value)&&value>=start&&value<=end)p.context.onTime(new Date(value).toISOString());}}><label>Exact story time · UTC<input type="datetime-local" min="2026-11-02T00:00" max="2026-11-06T10:00" value={exact} onChange={e=>setExact(e.target.value)} required/></label><button type="submit" aria-label="Apply exact story time">Apply<ArrowRight size={15}/></button></form>
    <div className="dial-bottom"><button onClick={()=>change(.35)}><RotateCcw size={13}/>Before the signal</button><button onClick={()=>change(1)}>Latest story time<ArrowRight size={13}/></button></div>
    <div className="knowledge-line"><Clock3 size={12}/><span>Known at {dateLabel(snap.context.knownAt)} · {all.length} orders</span></div>
  </section>;
}

export function EvidenceLens(p:Props){
  const {subset,snap}=useOrders(p);
  const [expanded,setExpanded]=useState<string|null>(null);
  const ids=new Set(subset.map(o=>o.id));
  const evidence=snap.evidence.filter(e=>(!e.orderId||ids.has(e.orderId))&&(p.format?.showContradictions!==false||e.kind!=='contradiction')).slice(0,7);
  return <section className="instrument evidence-instrument" data-widget="evidence-lens" data-snapshot={snap.hash}>
    <WidgetHead n="03" label="EVIDENCE LENS" title="Follow the facts." aside={<span className="count-chip">v{snap.context.cohortVersion}</span>}/>
    <div className="finding-callout"><span className="thin-line"/><div><strong>{snap.totals.affected} orders share a delivery delay.</strong><p>Pacific Northwest · regional carrier handoff</p></div></div>
    <div className="evidence-stack">{evidence.map((e,i)=><button key={e.id} className={'evidence-row '+(expanded===e.id?'expanded':'')} onClick={()=>setExpanded(expanded===e.id?null:e.id)}><span className="evidence-index">{String(i+1).padStart(2,'0')}</span><span className="evidence-body"><span className="evidence-meta">{e.kind.toUpperCase()}<span>↗</span></span><strong>{e.title}</strong>{expanded===e.id&&<><p>{e.excerpt}</p><small>{e.id} · received {dateLabel(e.ingestedAt)}</small>{e.untrusted&&<em>Quoted source text · cannot change agent authority</em>}</>}<span className="evidence-source">{sourceLabel(e.sourceClass)}</span></span></button>)}</div>
    <div className="evidence-note"><ScanLine size={15}/><p>A shared pattern supports a hypothesis.<br/>Open the source before drawing a conclusion.</p></div>
    {!snap.removedOrderIds.length?<button className="text-action revision-action" onClick={p.context.onRevision}>Ingest 9 delivery updates <ArrowUpRight size={15}/></button>:<div className="revision-receipt"><Check size={14}/>{snap.removedOrderIds.length} delivered records removed from scope</div>}
    {p.context.onFindings&&<button className="text-action finding-lens-link" data-focus-return="finding-library" onClick={p.context.onFindings}>Review interpretations & their history <ArrowUpRight size={15}/></button>}
  </section>;
}

export function RecoveryBranches(p:Props){
  const {subset,snap}=useOrders(p);
  const branch=snap.branches.find(b=>b.id==='targeted');const other=snap.branches.find(b=>b.id==='comprehensive');
  if(!branch||!other)return <section className="instrument"><p>Build a current snapshot to compare recovery.</p></section>;
  const selectGroup=(value:string)=>{const field=p.dataMapping.category?.[0];if(field)p.widgetApi.toggleCrossFilter({type:'value',field,value,group:0});};
  return <section className="instrument branches-instrument" data-widget="recovery-branches" data-snapshot={snap.hash}>
    <WidgetHead n="04" label="RECOVERY BRANCHES" title="A measured response." aside={<span className="budget-chip">CAP {money(p.format?.budgetMinor??30000)}</span>}/>
    <div className="policy-line"><ShieldCheck size={15}/><p>$5 for orders undelivered 48+ hours past promise.<br/>No open dispute. No earlier refund or credit.</p></div>
    <div className="branch-options">{[branch,other].map((b,i)=><button className={'branch-option '+(i===0?'recommended':'')} key={b.id} data-focus-return={'branch-'+b.id} onClick={()=>p.context.onBranch(b.id)}><div className="branch-caption"><span className="branch-letter">{i===0?'A':'B'}</span><span>{i===0?'Targeted goodwill':'No grace window'}</span>{i===0&&<span className="recommended-label">POLICY MATCH</span>}</div><div className="branch-amount">{money(b.refundTotalMinor)}<span>{b.eligibleCount} refunds × $5</span></div><div className="branch-bar"><span style={{width:Math.min(100,b.refundTotalMinor/(p.format?.budgetMinor??30000)*100)+'%'}}/></div><div className="branch-detail">{i===0?'48-hour grace window':'Same rule, no grace window'}<ArrowUpRight size={16}/></div></button>)}</div>
    <div className="exclusion-chips"><button onClick={()=>selectGroup('disputed')}>{branch.exclusionCounts.open_dispute??subset.filter(o=>o.disputeOpen).length} open disputes <ArrowUpRight size={12}/></button><button onClick={()=>selectGroup('grace')}>{branch.exclusionCounts.inside_grace_or_missing_promise??subset.filter(o=>o.seedGroup==='grace').length} inside grace <ArrowUpRight size={12}/></button></div>
    <div className="branch-footnote"><Truck size={14}/>{branch.trackingCount} tracking updates <span>+</span>{branch.disputeCount} dispute responses <span className="dim">· proposed</span></div>
    <div className="quiet-label branch-scope">{subset.length} orders in the shared selection · exact eligibility checked again at approval</div>
  </section>;
}

const regionTiles=[{code:'PNW',label:'Pacific NW',x:34,y:34,path:'M12 10 L85 18 L78 72 L25 64 Z'},{code:'SW',label:'Southwest',x:30,y:105,path:'M24 0 L83 8 L110 71 L80 94 L38 61 Z'},{code:'MW',label:'Midwest',x:125,y:50,path:'M0 0 L99 0 L97 83 L12 74 Z'},{code:'NE',label:'Northeast',x:240,y:28,path:'M0 44 L54 34 L91 0 L104 20 L76 68 L10 93 Z'},{code:'SE',label:'Southeast',x:222,y:130,path:'M0 0 L90 0 L63 39 L77 86 L67 94 L43 48 L3 40 Z'}];
export function ImpactMap(p:Props){
  const {all,subset,snap,highlighted}=useOrders(p,true);
  const [mode,setMode]=useState(p.format?.displayMode || 'map');useEffect(()=>setMode(p.format?.displayMode||'map'),[p.format?.displayMode]);
  const regions=regionTiles.map(r=>({...r,rows:all.filter(o=>o.regionCode===r.code),selected:subset.filter(o=>o.regionCode===r.code),daily:snap.tables.regional_snapshot.filter(row=>row.regionCode===r.code).sort((a,b)=>String(a.day).localeCompare(String(b.day)))}));
  const choose=(code:string)=>{const field=p.dataMapping.category?.[0];if(field)p.widgetApi.toggleCrossFilter({type:'value',field,value:code,group:0});};
  return <section className="instrument map-instrument" data-widget="impact-map" data-snapshot={snap.hash}>
    <WidgetHead n="05" label="IMPACT MAP" title="The pattern has a place." aside={<button className="icon-button" title="Switch map / regional comparisons" aria-label={mode==='map'?'Show regional daily comparisons':'Show region map'} onClick={()=>setMode(mode==='map'?'small-multiples':'map')}><Layers3 size={15}/></button>}/>
    {mode==='map'?<div className="map-layout"><svg viewBox="0 0 380 255" role="img" aria-label="Schematic United States commerce regions. Select a region to highlight its orders."><defs><pattern id="map-stipple" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".8" fill="#f5b6ab"/></pattern></defs>{regions.map(r=><g key={r.code} transform={`translate(${r.x} ${r.y})`} role="button" tabIndex={0} onClick={()=>choose(r.code)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(r.code);}}} aria-label={`Select ${r.label}, ${r.rows.length} orders`}><path d={r.path} fill={r.code==='PNW'?'#754d4c':'#1d3037'} stroke={r.code==='PNW'?'#ed9a89':'#496169'} strokeWidth="1" opacity={highlighted&&r.selected.length===0?.5:1}/>{r.code==='PNW'&&<path d={r.path} fill="url(#map-stipple)" opacity=".5"/>}<text x={r.code==='SW'?60:45} y={r.code==='NE'?55:38} textAnchor="middle" className="map-label">{r.code}</text>{r.code==='PNW'&&<circle cx="48" cy="53" r="4" fill={color.rose}/>}</g>)}<text x="20" y="246" className="map-disclaimer">COARSE REGIONS · SCHEMATIC</text></svg><div className="map-key"><span className="eyebrow">AFFECTED REGION</span><strong>Pacific<br/>Northwest</strong><div className="map-measure">{all.filter(o=>o.regionCode==='PNW'&&o.affected).length}<span>delayed orders</span></div></div></div>:<div className="small-multiples">{regions.map(r=><button onClick={()=>choose(r.code)} key={r.code}><span>{r.label}</span><svg viewBox="0 0 170 60" aria-label="Daily late share among due shipments"><line x1="0" y1="49" x2="170" y2="49" stroke="#32464e"/>{r.daily.map((day,d)=>{const share=typeof day.lateShare==='number'?day.lateShare:0;return <rect key={String(day.id)} x={8+d*33} y={50-share*45} width="19" height={Math.max(1,share*45)} fill={r.code==='PNW'?color.rose:color.cyan} opacity={.4+d*.12}><title>{String(day.day)}: {String(day.lateCount)} late / {String(day.eligibleShipmentCount)} due shipments</title></rect>;})}</svg><small>{r.rows.filter(o=>o.affected).length} late now · daily due shipments · 0–100% scale</small></button>)}</div>}
    <div className="region-rows">{regions.map(r=><button key={r.code} onClick={()=>choose(r.code)}><span><i style={{background:r.code==='PNW'?color.rose:color.cyan}}/>{r.label}</span><span>{r.rows.filter(o=>o.affected).length}<small> / {r.rows.length}</small><ArrowUpRight size={12}/></span></button>)}</div>
    <div className="quiet-label map-provenance">Order destinations are coarse fixture regions. Geography alone does not establish cause.</div>
  </section>;
}

export function DeadlineStrip(p:Props){
  const {subset,snap}=useOrders(p);const disputed=subset.filter(o=>o.disputeOpen);
  return <section className="instrument deadline-instrument" data-widget="deadline-strip" data-snapshot={snap.hash}>
    <WidgetHead n="06" label="DEADLINE STRIP" title="Keep every case in view." aside={<span className="count-chip">{disputed.length} open</span>}/>
    <div className="deadline-list">{disputed.length?disputed.map((o,i)=><button className="deadline-row" key={o.id} onClick={()=>p.context.onOrder(o.id)}><span className="case-icon"><FileText size={16}/></span><span className="case-detail"><strong>{o.reference}</strong><span>Item not received · {sourceLabel(o.disputeSource)}</span></span><span className="deadline-time">{o.disputeSource==='sandbox'?(o.disputeDueAt?dateLabel(o.disputeDueAt):o.disputeState==='waiting_for_buyer_response'?'Awaiting buyer response':'No seller deadline supplied'):'Due date unverified'}<small>{o.disputeSource==='sandbox'?o.disputeState?.replaceAll('_',' '):'Sample case'}</small></span><ChevronRight size={14}/></button>):<div className="widget-empty"><ShieldCheck size={24}/><strong>No open disputes in this selection.</strong><p>Clear the shared filter to return to the incident.</p></div>}</div>
    <div className="deadline-note"><TriangleAlert size={13}/><span>Evidence submitted, under review and resolved remain separate states.</span></div>
  </section>;
}
