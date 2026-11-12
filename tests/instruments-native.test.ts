import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgWidgetParams,AgWidgetField,AgReportState,AgWidgetState} from 'ag-studio';
import {nativeStudio} from './helpers/studio-native';
import {instrumentCorpus,times} from './reference/instrument-corpus';
import {buildSnapshot} from '../packages/domain';
import {initialState} from '../packages/studio/registry';
import {nativePrint,nativeOrderScope,orderIdDrillFilter} from '../packages/studio/native-print';
import {clearNativeSelection,setNativeOrderSelection,setNativeTransitionWindow} from '../packages/studio/native-selection';
import {inspectHistoryRestore} from '../packages/studio/history';
import type {GlasshouseRegistry,InstrumentData,InstrumentFormat} from '../packages/studio/types';
type Params=AgWidgetParams<InstrumentData>&{dataMapping:Record<string,AgWidgetField[]>};
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const source=()=>buildSnapshot(instrumentCorpus(),{asOf:times.end,knownAt:times.known,semanticModelVersion:'commerce-semantic-v2'});
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
const cross=(p:Params)=>p.format?.crossFilter??(['river','map'].includes(p.widgetId)?'highlight':p.widgetId==='dial'?'none':'filter');
async function read(p:Params,queryId:string){
 const fields=Object.entries(p.dataMapping).filter(([key])=>p.widgetId!=='river'||key!=='time').flatMap(([,value])=>value);
 const result=await p.widgetApi.getData({fields},{queryId,crossFilter:cross(p)});
 assert.equal(result.results.metadata?.error,undefined);assert.equal(result.crossFilter?.metadata?.error,undefined);assert.equal(result.replaced,undefined);
 return result;
}
const ids=(p:Params,rows:Record<string,unknown>[])=>rows.map(row=>String(row[p.dataMapping.orderId![0].key])).sort();

test('actual native multi-widget selections and cross-source ranges equal detached print and drill scopes without fanout',async t=>{
 const snapshot=source(),params=new Map<string,Params>(),fixture=await nativeStudio(t,initialState,{snapshot,onWidget:p=>params.set(p.widgetId,p as Params)});
 const check=async(expected:string[],name:string,dialIds=snapshot.orders.map(row=>row.id))=>{
  await settle();const print=await nativePrint(snapshot,fixture.api.getState(),times.now);
  for(const widget of print.widgets)assert.equal(widget.status,'exact',`${name}: ${widget.widgetId}: ${widget.reason}`);
  assert.deepEqual((await nativeOrderScope(snapshot,fixture.api.getState())).sort(),expected.slice().sort(),name);
  for(const id of ['river','map','evidence','branches','deadlines','dial']){
   const p=params.get(id)!,response=await read(p,name+'-'+id),selected=response.crossFilter?.rows??response.results.rows,want=id==='dial'?dialIds:expected;
   assert.deepEqual(ids(p,selected),want.slice().sort(),name+' '+id);
   const table=print.widgets.find(widget=>widget.widgetId===id)!.instrument!;
   assert.equal(table.selected,selected.length);assert.equal(table.scope,response.results.rows.length);
  }
  const p=params.get('records')!,response=await read(p,name+'-records'),printed=print.widgets.find(widget=>widget.widgetId==='records')!;
  assert.equal(response.results.rows.length,expected.length);assert.equal(printed.rows.length,expected.length);
  const sums=(rows:Record<string,unknown>[],key:string)=>rows.reduce((sum,row)=>sum+Number(row[key]),0);
  assert.equal(sums(printed.rows,'order_snapshot.amountMinor:sum'),sums(response.results.rows,'order_snapshot.amountMinor.sum'));
 };
 await check(['a','b','c','d','g','h'],'whole');
 let p=params.get('map')!;p.widgetApi.toggleCrossFilter({type:'value',field:p.dataMapping.category![0],value:'PNW',group:0});await check(['a','b','d'],'region');
 p=params.get('branches')!;setNativeOrderSelection(fixture.api,p.widgetId,String(p.dataMapping.orderId![0].fieldId),['d']);await check(['d'],'excluded-case');
 clearNativeSelection(fixture.api,'branches');await check(['a','b','d'],'clear-only-branch');clearNativeSelection(fixture.api,'map');
 p=params.get('river')!;p.widgetApi.toggleCrossFilter({type:'range',field:p.dataMapping.time![0],from:new Date(times.two),to:new Date(Date.parse(times.three)-1),group:1});await check(['a','c','d'],'resource-window');
 const state=fixture.api.getState();assert.equal(state.pages[0].crossFilter?.values?.river?.[0]?.type,'range');
 const report=await nativePrint(snapshot,state,times.now);const query=report.widgets.find(widget=>widget.widgetId==='records')!.query!;
 assert.equal(query.joins?.[0].joinType,'semi-left');assert.equal(query.joins?.[0].isFilterOnly,true);
 setNativeTransitionWindow(fixture.api,'river',times.two,times.three,'payment');await check(['a'],'payment-window');
 clearNativeSelection(fixture.api,'river');await check(['a','b','c','d','g','h'],'clear-window');
 const empty=copy(fixture.api.getState());empty.pages[0].filter={page:[{field:{id:'order_snapshot.id'},model:{operator:'isIn',value:[]}}]};fixture.api.setState(empty);await check([],'empty',[]);
 assert.deepEqual(fixture.errors,[]);
});

test('all six native configure forms save, reload and undo/redo complete settings and mappings',async t=>{
 const snapshot=source(),fixture=await nativeStudio(t,initialState,{snapshot});
 const settings:Record<string,InstrumentFormat>={
  river:{showTable:true,showLabels:false,displayMode:'transitions',measure:'value',rangeStart:times.one,rangeEnd:times.two,direction:'reverse',showMotion:false,crossFilter:'highlight'},
  dial:{showTable:true,showLabels:false,timezone:'Asia/Kolkata',rangeStart:times.start,rangeEnd:times.end,playbackStepMinutes:15},
  evidence:{showTable:true,showLabels:false,evidenceKind:'contradiction',evidenceSource:'sample',showContradictions:true,evidenceOrder:'oldest',redactExcerpts:true},
  branches:{showTable:true,showLabels:false,budgetMinor:0,gracePolicy:'targeted',showBlocked:false},
  map:{showTable:true,showLabels:false,displayMode:'small-multiples',measure:'late-share'},
  deadlines:{showTable:true,showLabels:false,deadlineOwner:'merchant',deadlineState:'waiting_for_seller_response',deadlineSort:'latest',showUnknown:false},
 };
 for(const [id,format] of Object.entries(settings)){
  const widget=fixture.api.getState().pages[0].widgets![id] as InstrumentData;
  const dataMapping=id==='river'?{...widget.dataMapping,category:[{id:'order_snapshot.paymentState'}],value:[{id:'order_snapshot.amountMinor',aggregation:'sum'}]}:id==='map'?{...widget.dataMapping,category:[{id:'order_snapshot.region'}]}:widget.dataMapping;
  const result=await fixture.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:widget.type}}).apply({widgetId:id,op:'patch',value:{format,dataMapping}});
  assert.equal(result.success,true,JSON.stringify(result));
 }
 const history=copy(fixture.api.getHistory());assert.equal(history.undo.length,6);fixture.api.undo();const undone=copy(fixture.api.getHistory());fixture.destroy();
 const restored=await nativeStudio(t,undone,{snapshot});assert.equal(inspectHistoryRestore(restored.api,undone).state,'restored');restored.api.redo();
 const admitted=copy(restored.api.getHistory());assert.deepEqual(admitted.current,history.current);assert.deepEqual(admitted.undo.map(({state,label,...identity})=>identity),history.undo.map(({state,label,...identity})=>identity));
 const print=await nativePrint(snapshot,admitted.current,times.now);for(const widget of print.widgets)assert.equal(widget.status,'exact',widget.widgetId+': '+widget.reason);
 assert.equal(print.widgets.find(widget=>widget.widgetId==='branches')!.rows[0]['Cap minor'],0);
 assert.equal(print.widgets.find(widget=>widget.widgetId==='dial')!.rows[0]['Display timezone'],'Asia/Kolkata');
 assert.equal(print.widgets.find(widget=>widget.widgetId==='evidence')!.rows[0].Excerpt,'Excerpt hidden in this view.');
 assert.deepEqual(restored.errors,[]);
});

test('a native read-only drill-through retains exact order scope and leaves parent history unchanged on return',async t=>{
 const snapshot=source(),params=new Map<string,Params>(),parent=await nativeStudio(t,initialState,{snapshot,onWidget:p=>params.set(p.widgetId,p as Params)});
 const map=params.get('map')!;map.widgetApi.toggleCrossFilter({type:'value',field:map.dataMapping.category![0],value:'PNW',group:0});await settle();
 const history=copy(parent.api.getHistory()),scope=await nativeOrderScope(snapshot,parent.api.getState(),{field:{key:'order_snapshot.disputeOpen',sourceId:'order_snapshot',fieldId:'order_snapshot.disputeOpen'},operator:'isTrue'});
 assert.deepEqual(scope,['d']);parent.destroy();
 const drillParams=new Map<string,Params>(),state:AgReportState<GlasshouseRegistry>={pages:[{id:'drill',layout:{type:'widget',columns:24,rowHeight:18,minWidth:320},widgetLayout:{proof:{xTrack:0,yTrack:0,xSpan:24,ySpan:30}},widgets:{proof:{type:'grid',dataMapping:{cols:[{id:'order_snapshot.id'},{id:'order_snapshot.capturedMinor',aggregation:'sum'}]}}}}],selectedPageId:'drill'};
 const drill=await nativeStudio(t,state,{snapshot,onWidget:p=>drillParams.set(p.widgetId,p as Params),drillThrough:{filter:orderIdDrillFilter(scope)}}),p=drillParams.get('proof')!;
 const rows=await p.widgetApi.getData({fields:p.dataMapping.cols},{queryId:'exact-drill',crossFilter:'none'});assert.deepEqual(rows.results.rows.map(row=>row['order_snapshot.id']),scope);assert.equal(rows.results.rows[0]['order_snapshot.capturedMinor.sum'],1000);
 const expanded=copy(drill.api.getState());expanded.pages[0].filter={page:[{field:{id:'order_snapshot.id'},model:{operator:'isIn',value:['a','d']}}]};drill.api.setState(expanded);await settle();
 const scoped=await drillParams.get('proof')!.widgetApi.getData({fields:drillParams.get('proof')!.dataMapping.cols},{queryId:'still-scoped',crossFilter:'none'});assert.deepEqual(scoped.results.rows.map(row=>row['order_snapshot.id']),scope);assert.deepEqual(drill.errors,[]);drill.destroy();
 const returned=await nativeStudio(t,history,{snapshot});assert.equal(inspectHistoryRestore(returned.api,history).state,'restored');assert.deepEqual(copy(returned.api.getHistory()),history);
 assert.deepEqual(returned.errors,[]);
});

test('authored native flat chart mappings retain aggregates; unsupported widgets or fanout mappings are explicit',async()=>{
 const snapshot=source(),state=copy(initialState),widgets=state.pages[0].widgets!;
 widgets['authored-chart']={type:'column-chart-grouped',dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.capturedMinor',aggregation:'sum'}],legendKey:[],tooltipKey:[]},format:{title:{enabled:true,text:'Exact capture resources by region'}}};
 widgets['resource-grid']={type:'grid',dataMapping:{cols:[{id:'capture_snapshot.orderId'},{id:'capture_snapshot.amountMinor',aggregation:'sum'}]}};
 widgets['unsupported-pivot']={type:'pivot',dataMapping:{}} as unknown as AgWidgetState<GlasshouseRegistry>;
 widgets['unsafe-fanout']={type:'grid',dataMapping:{cols:[{id:'order_snapshot.regionCode'},{id:'capture_snapshot.amountMinor',aggregation:'sum'}]}};
 const print=await nativePrint(snapshot,state,times.now),chart=print.widgets.find(widget=>widget.widgetId==='authored-chart')!;
 assert.equal(chart.status,'exact');assert.deepEqual(chart.rows.map(row=>[row['order_snapshot.regionCode'],row['order_snapshot.capturedMinor:sum']]).sort(),[['',1800],['PNW',16000],['SW',1000]].sort());
 assert.equal(print.widgets.find(widget=>widget.widgetId==='resource-grid')!.status,'exact');
 for(const id of ['unsupported-pivot','unsafe-fanout']){const widget=print.widgets.find(row=>row.widgetId===id)!;assert.equal(widget.status,'unsupported');assert.ok(widget.reason);assert.deepEqual(widget.rows,[]);}
});
