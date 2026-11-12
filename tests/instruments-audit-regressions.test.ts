import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgWidgetParams,AgWidgetField} from 'ag-studio';
import {nativeStudio} from './helpers/studio-native';
import {instrumentCorpus,times} from './reference/instrument-corpus';
import {buildSnapshot} from '../packages/domain';
import {COMMERCE_SEMANTICS} from '../packages/domain/commerce-resources';
import {initialState} from '../packages/studio/registry';
import {nativePrint} from '../packages/studio/native-print';
import {setNativeOrderSelection} from '../packages/studio/native-selection';
import type {InstrumentData} from '../packages/studio/types';

type Params=AgWidgetParams<InstrumentData>&{dataMapping:Record<string,AgWidgetField[]>};
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
const snapshot=()=>buildSnapshot(instrumentCorpus(),{asOf:times.end,knownAt:times.known,semanticModelVersion:'commerce-semantic-v2'});
const orderIds=(p:Params,rows:Record<string,unknown>[])=>rows.map(row=>String(row[p.dataMapping.orderId![0].key])).sort();

// The native engine/document is real. EmptyWidget deliberately excludes pixel and
// React interaction acceptance; the independent actual React bridge test is separate.
test('Filter-mode River exact export retains the native original and subset after another widget filters it',async t=>{
  const source=snapshot(),state=structuredClone(initialState),params=new Map<string,Params>();
  state.pages[0].widgets!.river!.format={crossFilter:'filter'};
  const fixture=await nativeStudio(t,state,{snapshot:source,onWidget:p=>params.set(p.widgetId,p as Params)});
  const river=params.get('river')!,map=params.get('map')!;
  river.widgetApi.toggleCrossFilter({type:'value',field:river.dataMapping.category![0],value:'delayed',group:0,reset:false});
  setNativeOrderSelection(fixture.api,'map',String(map.dataMapping.orderId![0].fieldId),['a','b','d']);
  await settle();
  const current=params.get('river')!,fields=Object.entries(current.dataMapping).filter(([name])=>name!=='time').flatMap(([,values])=>values);
  const response=await current.widgetApi.getData({fields},{queryId:'audit-filter-river',crossFilter:'filter'});
  assert.equal(response.results.metadata?.error,undefined);
  assert.equal(response.crossFilter?.metadata?.error,undefined);
  assert.deepEqual(orderIds(current,response.results.rows),['a','b','d']);
  assert.ok(response.crossFilter,'The installed highlight-capable Filter-mode contract returns its own subset.');
  assert.deepEqual(orderIds(current,response.crossFilter.rows),['b']);
  const printed=(await nativePrint(source,fixture.api.getState(),times.now)).widgets.find(widget=>widget.widgetId==='river')!;
  assert.equal(printed.status,'exact',printed.reason);
  t.diagnostic(JSON.stringify({nativeOriginal:response.results.rows.length,nativeSubset:response.crossFilter.rows.length,printedScope:printed.instrument!.scope,printedSelected:printed.instrument!.selected}));
  assert.equal(printed.instrument!.scope,response.results.rows.length,'Exact export must retain the original denominator returned by the live native widget.');
  assert.equal(printed.instrument!.selected,response.crossFilter.rows.length);
  assert.equal(printed.instrument!.highlighted,true);
  assert.equal(printed.instrument!.groups.reduce((sum,group)=>sum+group.value,0),3);
  assert.equal(printed.instrument!.groups.reduce((sum,group)=>sum+group.selected,0),1);
  assert.deepEqual(fixture.errors,[]);
});

test('Filter-mode Map exact export retains its native denominator after River selection',async t=>{
  const source=snapshot(),state=structuredClone(initialState),params=new Map<string,Params>();
  state.pages[0].widgets!.map!.format={crossFilter:'filter',displayMode:'map'};
  const fixture=await nativeStudio(t,state,{snapshot:source,onWidget:p=>params.set(p.widgetId,p as Params)});
  const river=params.get('river')!,map=params.get('map')!;
  setNativeOrderSelection(fixture.api,'map',String(map.dataMapping.orderId![0].fieldId),['a','b','d']);
  river.widgetApi.toggleCrossFilter({type:'value',field:river.dataMapping.category![0],value:'delayed',group:0,reset:false});
  await settle();
  const current=params.get('map')!,fields=Object.values(current.dataMapping).flat();
  const response=await current.widgetApi.getData({fields},{queryId:'audit-filter-map',crossFilter:'filter'});
  assert.equal(response.results.metadata?.error,undefined);
  assert.equal(response.crossFilter?.metadata?.error,undefined);
  assert.deepEqual(orderIds(current,response.results.rows),['b','h']);
  assert.ok(response.crossFilter);
  assert.deepEqual(orderIds(current,response.crossFilter.rows),['b']);
  const printed=(await nativePrint(source,fixture.api.getState(),times.now)).widgets.find(widget=>widget.widgetId==='map')!;
  assert.equal(printed.status,'exact',printed.reason);
  t.diagnostic(JSON.stringify({nativeOriginal:response.results.rows.length,nativeSubset:response.crossFilter.rows.length,printedScope:printed.instrument!.scope,printedSelected:printed.instrument!.selected}));
  assert.equal(printed.instrument!.scope,response.results.rows.length,'Map original scope must exclude its own selection and retain other native filters.');
  assert.equal(printed.instrument!.selected,response.crossFilter.rows.length);
  assert.equal(printed.instrument!.highlighted,true);
  assert.equal(printed.instrument!.groups.reduce((sum,group)=>sum+group.value,0),2);
  assert.equal(printed.instrument!.groups.reduce((sum,group)=>sum+group.selected,0),1);
  assert.deepEqual(fixture.errors,[]);
});

function sellerResponseWithoutDeadline(){
  const dataset=instrumentCorpus();
  const event=dataset.events.find(row=>row.orderId==='d'&&row.type==='dispute.observed')!;
  delete event.payload.sellerResponseDueAt;
  return buildSnapshot(dataset,{asOf:times.end,knownAt:times.known,semanticModelVersion:COMMERCE_SEMANTICS});
}

test('a source-confirmed seller-response owner stays merchant when the provider omits its due date',()=>{
  const source=sellerResponseWithoutDeadline(),order=source.orders.find(row=>row.id==='d')!;
  assert.equal(order.disputeState,'waiting_for_seller_response');
  assert.equal(order.disputeSource,'sandbox');
  assert.equal(order.disputeDueAt,null);
  const materialized=source.tables.deadline_snapshot.find(row=>row.orderId==='d')!;
  assert.equal(materialized.dueAt,null);
  assert.equal(materialized.dueDateVerified,false);
  assert.equal(materialized.owner,'merchant','Response owner comes from the known provider state, independently of deadline availability.');
});

test('native Merchant owner with Include unknown retains a seller-response case and invents no countdown',async()=>{
  const source=sellerResponseWithoutDeadline(),state=structuredClone(initialState);
  state.pages[0].widgets!.deadlines!.format={deadlineOwner:'merchant' as const,showUnknown:true};
  const result=await nativePrint(source,state,times.now),deadline=result.widgets.find(widget=>widget.widgetId==='deadlines')!;
  assert.equal(deadline.status,'exact',deadline.reason);
  assert.deepEqual(deadline.rows.map(row=>row.Order),['d'],'A missing provider date must not hide a case whose response owner is known.');
  assert.equal(deadline.rows[0].Owner,'merchant');
  assert.equal(deadline.rows[0].Deadline,null);
  assert.equal(deadline.rows[0]['Remaining seconds'],null);
  state.pages[0].widgets!.deadlines!.format={deadlineOwner:'merchant' as const,showUnknown:false};
  const withoutUnknown=(await nativePrint(source,state,times.now)).widgets.find(widget=>widget.widgetId==='deadlines')!;
  assert.equal(withoutUnknown.status,'exact',withoutUnknown.reason);
  assert.deepEqual(withoutUnknown.rows,[]);
});

test('a native alternate River clock is explicitly unsupported instead of silently exporting transition time',async t=>{
  const source=snapshot(),fixture=await nativeStudio(t,initialState,{snapshot:source});
  const river=fixture.api.getState().pages[0].widgets!.river! as InstrumentData;
  const configured=await fixture.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'commerce-river'}}).apply({
    widgetId:'river',op:'patch',value:{
      dataMapping:{...river.dataMapping,time:[{id:'order_snapshot.promisedAt'}],category:[{id:'order_snapshot.paymentState'}]},
      format:{displayMode:'transitions',rangeStart:times.one,rangeEnd:times.two},
    },
  });
  assert.equal(configured.success,true,JSON.stringify(configured));
  const printed=(await nativePrint(source,fixture.api.getState(),times.now)).widgets.find(widget=>widget.widgetId==='river')!;
  assert.equal(printed.status,'unsupported','An unsupported time mapping cannot be labelled exact while a different fixed clock is used.');
  assert.match(printed.reason??'',/time|transition/i);
  assert.deepEqual(printed.rows,[]);
  assert.deepEqual(fixture.errors,[]);
});
