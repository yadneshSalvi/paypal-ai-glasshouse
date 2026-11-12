'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {createWidgets,type AgGridWidgetOptions,type AgWidgetCustomCellRendererProps} from 'ag-studio-react';
import type {AgReportState} from 'ag-studio';
import {ArrowLeft,ShieldCheck} from 'lucide-react';
import type {Snapshot} from '../domain/types';
import {NativeStudio} from './native-studio';
import {studioData} from './data';
import {instrumentTheme} from './registry';
import {orderIdDrillFilter} from './native-print';
import type {GlasshouseRegistry} from './types';

export interface DrillScope {title:string;snapshot:Snapshot;orderIds:string[];originLabel:string;scrollY:number;historyJson:string}
/** A separately mounted native report receives a read-only drillThrough property. The
 * original native workspace stays mounted; no layout command is applied to it. */
export default function DrillReport({scope,onBack,onOrder}:{scope:DrillScope;onBack():void;onOrder(id:string):void}){
  const heading=useRef<HTMLHeadingElement>(null),[error,setError]=useState<string|null>(null),[ready,setReady]=useState(false),order=useRef(onOrder);order.current=onOrder;
  const widgets=useMemo(()=>{
    const options:AgGridWidgetOptions={createCellRenderer:field=>{
      if(String(field.fieldId)!=='order_snapshot.id')return undefined;
      return function OrderProofCell(params:AgWidgetCustomCellRendererProps){
        const id=String(params.value),row=scope.snapshot.orders.find(row=>row.id===id);
        return <button className="native-proof-link" type="button" aria-label={'Open row evidence for '+(row?.reference??id)} disabled={!row||!scope.orderIds.includes(id)} onClick={()=>order.current(id)}>{row?row.reference+' · Open evidence':'Unknown order'}</button>;
      };
    }};
    return createWidgets({overrides:[{id:'grid',options}]});
  },[scope]);
  const state=useMemo<AgReportState>(()=>({selectedPageId:'scoped-records',pages:[{id:'scoped-records',layout:{type:'widget',columns:24,rowHeight:18,minWidth:320},widgets:{proof:{type:'grid',dataMapping:{cols:[{id:'order_snapshot.id'},{id:'order_snapshot.region'},{id:'order_snapshot.paymentState'},{id:'order_snapshot.fulfillmentState'},{id:'order_snapshot.remediationState'},{id:'order_snapshot.capturedMinor',aggregation:'sum'},{id:'order_snapshot.refundedMinor',aggregation:'sum'},{id:'order_snapshot.currency'},{id:'order_snapshot.paymentSource'}]},format:{title:{enabled:true,text:'The exact records behind '+scope.title},crossFilter:'none',drillThrough:'filter',style:{columnWidth:190,headerRow:{wrapText:true}}}}},widgetLayout:{proof:{xTrack:0,yTrack:0,xSpan:24,ySpan:33}}}],panels:{filters:{collapsed:false},data:{collapsed:true},edit:{collapsed:true},ai:{collapsed:true}}}),[scope]);
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
  useEffect(()=>{const timer=setTimeout(()=>{if(!ready)setError('This scoped report did not finish opening. Go Back restores the complete prior investigation.');},15_000);return()=>clearTimeout(timer);},[ready]);
  return <section className="native-drill-report" aria-labelledby="drill-title"><header><button className="button" onClick={onBack}><ArrowLeft size={15}/>Go Back</button><div><span className="eyebrow">EXACT NATIVE DRILL-THROUGH</span><h2 id="drill-title" ref={heading} tabIndex={-1}>{scope.title}</h2><p>{scope.orderIds.length} orders · {scope.snapshot.context.currency} · T {scope.snapshot.context.asOf} · K {scope.snapshot.context.knownAt}</p></div></header><p className="drill-scope-note"><ShieldCheck size={15}/>The native report uses a fixed order scope from the current filters. Open a row to inspect its source proof.</p>{error&&<div className="inline-error" role="alert">{error}</div>}<div style={{height:650}} className="drill-native-grid"><NativeStudio studioId="glasshouse-scoped-proof" data={studioData(scope.snapshot)} widgets={widgets as never} initialState={state as AgReportState<GlasshouseRegistry>} drillThrough={{filter:orderIdDrillFilter(scope.orderIds)}} theme={instrumentTheme} loadThemeGoogleFonts={false} mode="view" panels={{view:{right:['filters']},edit:{right:[]}}} onRenderStateChanged={event=>{if(event.renderState==='rendered'){setReady(true);setError(null);}}} onErrorRaised={event=>{if(event.fatal)setError(event.errorDetails.join(' '));}}/></div><details className="drill-proof-list"><summary>Accessible row evidence list ({scope.orderIds.length})</summary><p>This list uses the same exact native order IDs.</p><div>{scope.orderIds.map(id=><button key={id} onClick={()=>onOrder(id)}>{scope.snapshot.orders.find(row=>row.id===id)?.reference??id} · Open source proof</button>)}</div></details></section>;
}
