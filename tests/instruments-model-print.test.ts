import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgWidgetParams,AgWidgetField} from 'ag-studio';
import {buildSnapshot} from '../packages/domain';
import {COMMERCE_SEMANTICS,COMMERCE_SEMANTICS_V2} from '../packages/domain/commerce-resources';
import {instrumentResult,type InstrumentInput,type NativeInstrumentRow} from '../packages/studio/instrument-model';
import {nativePrint} from '../packages/studio/native-print';
import {clearNativeSelection,setNativeOrderSelection} from '../packages/studio/native-selection';
import {getWidgetCrossFilterConfig,type NativeCrossFilterMode} from '../packages/studio/widget-metadata';
import {initialState,widgets} from '../packages/studio/registry';
import type {InstrumentData} from '../packages/studio/types';
import {nativeStudio} from './helpers/studio-native';
import {instrumentCorpus,times} from './reference/instrument-corpus';

type Params=AgWidgetParams<InstrumentData>&{dataMapping:Record<string,AgWidgetField[]>};
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
const source=(version=COMMERCE_SEMANTICS_V2)=>buildSnapshot(instrumentCorpus(),{asOf:times.end,knownAt:times.known,semanticModelVersion:version});
const nativeRows=(snapshot:ReturnType<typeof source>,category:'regionCode'|'fulfillmentState'='regionCode'):NativeInstrumentRow[]=>snapshot.orders.map(order=>({orderId:order.id,category:order[category],value:order.amountMinor,time:null}));
const sorted=(rows:Record<string,unknown>[])=>rows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('print cross-filter capabilities match every actual registered React definition, including built-ins',()=>{
  let builtIns=0;
  for(const definition of widgets.widgets){
    const configured=definition.defaultState?.format?.crossFilter;
    const expected={supportsHighlight:definition.featureConfig?.crossFilter?.supportsHighlight===true,defaultMode:configured==='none'||configured==='highlight'?configured:'filter'};
    assert.deepEqual(getWidgetCrossFilterConfig(definition.id),expected,definition.id);
    if(!['commerce-river','time-dial','evidence-lens','recovery-branches','impact-map','deadline-strip'].includes(definition.id))builtIns++;
  }
  assert.ok(builtIns>10,'Built-in capabilities must be obtained from the installed registry, not a custom-only list.');
  assert.equal(getWidgetCrossFilterConfig('column-chart-grouped')?.supportsHighlight,true);
  assert.equal(getWidgetCrossFilterConfig('grid')?.supportsHighlight,true);
  assert.equal(getWidgetCrossFilterConfig('evidence-lens')?.supportsHighlight,false);
  assert.equal(getWidgetCrossFilterConfig('not-a-registered-widget'),undefined);
});

test('actual River, Map, built-in chart and Grid queries retain original/subset parity through own clear and peer clear',async t=>{
  const snapshot=source(),state=structuredClone(initialState),params=new Map<string,Params>();
  const page=state.pages[0];
  page.widgets!['chart']={type:'column-chart-grouped',dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.capturedMinor',aggregation:'sum'}],legendKey:[],tooltipKey:[]},format:{crossFilter:'filter'}};
  page.widgets!['scoped-grid']={type:'grid',dataMapping:{cols:[{id:'order_snapshot.id'},{id:'order_snapshot.regionCode'},{id:'order_snapshot.capturedMinor',aggregation:'sum'}]},format:{crossFilter:'filter'}};
  page.widgetLayout!['chart']={xTrack:0,yTrack:96,xSpan:12,ySpan:24};
  page.widgetLayout!['scoped-grid']={xTrack:12,yTrack:96,xSpan:12,ySpan:24};
  const fixture=await nativeStudio(t,state,{snapshot,onWidget:p=>params.set(p.widgetId,p as Params)});
  let comparisons=0;
  const cases=[
    {id:'river',peer:'map',peerIds:['a','b','d'],ownIds:['b','h'],ownCategory:'delayed',slot:'category'},
    {id:'map',peer:'river',peerIds:['b','h'],ownIds:['a','b','d'],ownCategory:'PNW',slot:'category'},
    {id:'chart',peer:'map',peerIds:['a','b','h'],ownIds:['a','b','d'],ownCategory:'PNW',slot:'categoryKey'},
    {id:'scoped-grid',peer:'map',peerIds:['a','d','h'],ownIds:['a','b'],ownCategory:null,slot:'cols'},
  ];
  const compare=async(id:string,mode:NativeCrossFilterMode,expectedOriginal:number,expectedSelected:number,label:string)=>{
    await settle();const p=params.get(id)!,fields=Object.entries(p.dataMapping).filter(([name])=>id!=='river'||name!=='time').flatMap(([,refs])=>refs);
    const response=await p.widgetApi.getData({fields},{queryId:'model-print-'+label,crossFilter:mode});
    assert.equal(response.results.metadata?.error,undefined,label);assert.equal(response.crossFilter?.metadata?.error,undefined,label);
    const printed=(await nativePrint(snapshot,fixture.api.getState(),times.now)).widgets.find(widget=>widget.widgetId===id)!;
    assert.equal(printed.status,'exact',printed.reason);
    if(printed.instrument){
      assert.equal(printed.instrument.scope,response.results.rows.length,label+' original');
      assert.equal(printed.instrument.selected,(response.crossFilter??response.results).rows.length,label+' selected');
      assert.equal(printed.instrument.highlighted,Boolean(response.crossFilter),label+' subset existence');
      assert.equal(printed.instrument.scope,expectedOriginal,label+' independently specified original scope');
      assert.equal(printed.instrument.selected,expectedSelected,label+' independently specified selected scope');
    }else{
      const saved=(fixture.api.getState().pages[0].widgets![id]!.dataMapping??{}) as Record<string,{id:string;aggregation?:string}[]>;
      const paired=Object.entries(p.dataMapping).flatMap(([slot,refs])=>refs.map((field,index)=>({field,saved:saved[slot][index]})));
      const normalize=(rows:Record<string,unknown>[])=>rows.map(row=>Object.fromEntries(paired.map(({field,saved})=>[saved.id+(saved.aggregation?':'+saved.aggregation:''),row[field.key]??null])));
      assert.deepEqual(sorted(printed.originalRows??printed.rows),sorted(normalize(response.results.rows)),label+' original rows');
      assert.deepEqual(sorted(printed.rows),sorted(normalize((response.crossFilter??response.results).rows)),label+' subset rows');
      assert.equal(Boolean(printed.originalRows),Boolean(response.crossFilter),label+' subset existence');
      if(id==='chart'&&label==='chart-both'){
        assert.deepEqual(sorted(printed.originalRows!),sorted([{'order_snapshot.regionCode':'PNW','order_snapshot.capturedMinor:sum':15000},{'order_snapshot.regionCode':'SW','order_snapshot.capturedMinor:sum':1000}]));
        assert.deepEqual(printed.rows,[{'order_snapshot.regionCode':'PNW','order_snapshot.capturedMinor:sum':15000}]);
      }
      if(id==='scoped-grid'){
        assert.equal(response.results.rows.length,expectedOriginal,label+' original orders');
        assert.equal((response.crossFilter??response.results).rows.length,expectedSelected,label+' selected orders');
      }
    }
    comparisons++;
  };
  for(const item of cases){
    const fresh=structuredClone(state);fresh.pages[0].widgets![item.id]!.format={...fresh.pages[0].widgets![item.id]!.format,crossFilter:'filter'};fixture.api.setState(fresh);await settle();
    const own=()=>{
      const p=params.get(item.id)!;
      if(item.ownCategory===null)setNativeOrderSelection(fixture.api,item.id,String(p.dataMapping.cols[0].fieldId),item.ownIds);
      else p.widgetApi.toggleCrossFilter({type:'value',field:p.dataMapping[item.slot][0],value:item.ownCategory,group:0,reset:false});
    };
    own();setNativeOrderSelection(fixture.api,item.peer,'order_snapshot.id',item.peerIds);await settle();
    const intersection=item.ownIds.filter(id=>item.peerIds.includes(id));
    await compare(item.id,'filter',item.peerIds.length,intersection.length,item.id+'-both');
    const outside=snapshot.orders.find(order=>!item.ownIds.includes(order.id))!.id;
    setNativeOrderSelection(fixture.api,item.peer,'order_snapshot.id',[outside]);await compare(item.id,'filter',1,0,item.id+'-empty-intersection');
    setNativeOrderSelection(fixture.api,item.peer,'order_snapshot.id',item.peerIds);await settle();
    const peerSelection=structuredClone(fixture.api.getState().pages[0].crossFilter!.values![item.peer]);
    clearNativeSelection(fixture.api,item.id);await compare(item.id,'filter',item.peerIds.length,item.peerIds.length,item.id+'-own-cleared');
    assert.deepEqual(fixture.api.getState().pages[0].crossFilter!.values![item.peer],peerSelection,'Clearing this widget preserves its peer.');
    own();clearNativeSelection(fixture.api,item.peer);await compare(item.id,'filter',snapshot.orders.length,item.ownIds.length,item.id+'-peer-cleared');
    setNativeOrderSelection(fixture.api,item.peer,'order_snapshot.id',item.peerIds);
    for(const mode of ['highlight','none'] as const){
      const changed=structuredClone(fixture.api.getState());changed.pages[0].widgets![item.id]!.format={...changed.pages[0].widgets![item.id]!.format,crossFilter:mode};fixture.api.setState(changed);
      await compare(item.id,mode,snapshot.orders.length,mode==='highlight'?intersection.length:snapshot.orders.length,item.id+'-'+mode);
    }
    const changed=structuredClone(fixture.api.getState());changed.pages[0].widgets![item.id]!.format={...changed.pages[0].widgets![item.id]!.format,crossFilter:'filter'};fixture.api.setState(changed);
    clearNativeSelection(fixture.api,item.id);clearNativeSelection(fixture.api,item.peer);await compare(item.id,'filter',snapshot.orders.length,snapshot.orders.length,item.id+'-all-cleared');
  }
  assert.deepEqual(fixture.errors,[]);t.diagnostic(JSON.stringify({actualInstalledEngine:true,nativePrintComparisons:comparisons,pixelAcceptance:false}));
});

test('a non-highlight-capable native Filter widget applies its own and peer selections to the original with no subset',async t=>{
  const snapshot=source(),params=new Map<string,Params>(),fixture=await nativeStudio(t,initialState,{snapshot,onWidget:p=>params.set(p.widgetId,p as Params)});
  setNativeOrderSelection(fixture.api,'evidence','order_snapshot.id',['a','b']);setNativeOrderSelection(fixture.api,'map','order_snapshot.id',['a','d']);await settle();
  const p=params.get('evidence')!,response=await p.widgetApi.getData({fields:Object.values(p.dataMapping).flat()},{queryId:'non-highlight-filter',crossFilter:'filter'});
  assert.equal(response.crossFilter,undefined);assert.deepEqual(response.results.rows.map(row=>row[p.dataMapping.orderId![0].key]),['a']);
  const printed=(await nativePrint(snapshot,fixture.api.getState(),times.now)).widgets.find(widget=>widget.widgetId==='evidence')!;
  assert.equal(printed.status,'exact',printed.reason);assert.equal(printed.instrument!.scope,1);assert.equal(printed.instrument!.selected,1);assert.equal(printed.instrument!.highlighted,false);
  clearNativeSelection(fixture.api,'evidence');await settle();
  const after=(await nativePrint(snapshot,fixture.api.getState(),times.now)).widgets.find(widget=>widget.widgetId==='evidence')!;
  assert.equal(after.instrument!.scope,2);assert.deepEqual(after.instrument!.orders.map(row=>row.id).sort(),['a','d']);assert.equal(after.instrument!.highlighted,false);assert.deepEqual(fixture.errors,[]);
});

test('v3 native Filter regional history and static rows preserve scoped original and selected daily and baseline values',async t=>{
  const snapshot=source(COMMERCE_SEMANTICS),state=structuredClone(initialState);
  state.pages[0].widgets!.map!.format={crossFilter:'filter',displayMode:'small-multiples',measure:'late-share' as const};
  const fixture=await nativeStudio(t,state,{snapshot});
  setNativeOrderSelection(fixture.api,'river','order_snapshot.id',['a','b','h']);setNativeOrderSelection(fixture.api,'map','order_snapshot.id',['a']);await settle();
  const printed=(await nativePrint(snapshot,fixture.api.getState(),times.now)).widgets.find(widget=>widget.widgetId==='map')!;
  assert.equal(printed.status,'exact',printed.reason);const model=printed.instrument!,pnw=model.groups.find(group=>group.key==='PNW')!,sw=model.groups.find(group=>group.key==='SW')!;
  assert.equal(model.scope,3);assert.equal(model.selected,1);
  assert.deepEqual(pnw.baseline,{at:'2026-11-03T07:59:59.999Z',originalValue:1,selectedValue:1,originalOrderCount:2,selectedOrderCount:1,originalNumerator:2,originalDenominator:2,selectedNumerator:2,selectedDenominator:2});
  assert.deepEqual(pnw.daily!.find(day=>day.day==='2026-11-06'),{day:'2026-11-06',value:0.5,numerator:1,denominator:2,originalValue:2/3,selectedValue:0.5,originalOrderCount:2,selectedOrderCount:1,originalNumerator:2,originalDenominator:3,selectedNumerator:1,selectedDenominator:2});
  assert.deepEqual(pnw.daily!.find(day=>day.day==='2026-11-02'),{day:'2026-11-02',value:null,numerator:0,denominator:0,originalValue:null,selectedValue:null,originalOrderCount:2,selectedOrderCount:1,originalNumerator:0,originalDenominator:0,selectedNumerator:0,selectedDenominator:0});
  assert.equal(sw.baseline!.originalValue,1);assert.equal(sw.baseline!.originalOrderCount,1);assert.equal(sw.baseline!.originalDenominator,1);assert.equal(sw.baseline!.selectedValue,null);assert.equal(sw.baseline!.selectedOrderCount,0);assert.equal(sw.baseline!.selectedDenominator,0);
  const baseline=printed.rows.find(row=>row.Region==='Pacific Northwest'&&row.Period==='Historical baseline')!;
  assert.deepEqual(baseline,{'Region':'Pacific Northwest','Period':'Historical baseline','Time':'2026-11-03T07:59:59.999Z','Original value':1,'Selected value':1,'Original orders':2,'Selected orders':1,'Original late':2,'Original due':2,'Selected late':2,'Selected due':2});
  const day=printed.rows.find(row=>row.Region==='Pacific Northwest'&&row.Period==='Daily'&&row.Time==='2026-11-06')!;
  assert.equal(day['Original value'],2/3);assert.equal(day['Selected value'],0.5);assert.equal(day['Original orders'],2);assert.equal(day['Selected orders'],1);assert.equal(day['Original due'],3);assert.equal(day['Selected due'],2);
  assert.ok(printed.columns.includes('Original late')&&printed.columns.includes('Selected due'));assert.match(model.notes.join(' '),/reference inventory/);assert.deepEqual(fixture.errors,[]);
});

test('v3 regional count, empty selections and unknown denominators are explicit; legacy editions acquire no baseline',()=>{
  const snapshot=source(COMMERCE_SEMANTICS),original=nativeRows(snapshot),selected=original.filter(row=>row.orderId==='c');
  const input:InstrumentInput={snapshot,kind:'impact-map',format:{displayMode:'small-multiples',measure:'late-share'},mapping:{orderId:'order_snapshot.id',category:'order_snapshot.regionCode'},original,subset:selected};
  const unknown=instrumentResult(input),group=unknown.groups.find(group=>group.key==='UNKNOWN')!;
  assert.equal(unknown.error,undefined);assert.equal(group.baseline!.originalOrderCount,2);assert.equal(group.baseline!.selectedOrderCount,1);assert.equal(group.baseline!.originalDenominator,0);assert.equal(group.baseline!.selectedDenominator,0);assert.equal(group.baseline!.originalValue,null);assert.equal(group.baseline!.selectedValue,null);
  const current=instrumentResult({...input,format:{measure:'late-share'}}).rows.find(row=>row.Region==='Unknown region')!;
  assert.equal(current.Selected,null);assert.equal(current.Due,0);assert.equal(current['Selected value'],null);assert.equal(current['Selected due'],0);
  const count=instrumentResult({...input,format:{displayMode:'small-multiples',measure:'count'}}).groups.find(group=>group.key==='UNKNOWN')!;
  assert.equal(count.baseline!.originalValue,2);assert.equal(count.baseline!.selectedValue,1);assert.equal(count.daily!.at(-1)!.originalValue,2);assert.equal(count.daily!.at(-1)!.selectedValue,1);
  const empty=instrumentResult({...input,subset:[]});assert.equal(empty.selected,0);assert.ok(empty.groups.every(group=>group.baseline!.selectedValue===null&&group.baseline!.selectedOrderCount===0&&group.daily!.every(day=>day.selectedValue===null&&day.selectedDenominator===0)));
  const emptyCount=instrumentResult({...input,subset:[],format:{displayMode:'small-multiples',measure:'count'}});assert.ok(emptyCount.groups.every(group=>group.baseline!.selectedValue===0&&group.daily!.every(day=>day.selectedValue===0)));
  const money=instrumentResult({...input,format:{displayMode:'small-multiples',measure:'value'},mapping:{...input.mapping,value:'order_snapshot.amountMinor'}});assert.match(money.error??'',/not an inventory history/);assert.deepEqual(money.rows,[]);
  for(const version of ['commerce-semantic-v1',COMMERCE_SEMANTICS_V2]){
    const old=source(version),legacy=instrumentResult({...input,snapshot:old,original:nativeRows(old),subset:null,format:{displayMode:'map',measure:'count'}});
    assert.equal(legacy.error,undefined);assert.ok(legacy.groups.every(group=>!Object.hasOwn(group,'baseline')));
    assert.ok(legacy.groups.flatMap(group=>group.daily??[]).every(day=>Object.keys(day).sort().join(',')==='day,denominator,numerator,value'));
    assert.deepEqual(legacy.columns,['Region','Original','Selected','Late','Due']);assert.ok(legacy.rows.every(row=>!Object.hasOwn(row,'Period')));
  }
});

test('deadline presentation uses admitted versioned ownership and only verified provider dates enable a countdown',()=>{
  const dataset=instrumentCorpus(),event=dataset.events.find(row=>row.orderId==='d'&&row.type==='dispute.observed')!;delete event.payload.sellerResponseDueAt;
  for(const [version,owner] of [[COMMERCE_SEMANTICS_V2,'unknown'],[COMMERCE_SEMANTICS,'merchant']]){
    const snapshot=buildSnapshot(dataset,{asOf:times.end,knownAt:times.known,semanticModelVersion:version});
    const result=instrumentResult({snapshot,kind:'deadline-strip',format:{showUnknown:true},mapping:{orderId:'order_snapshot.id'},original:nativeRows(snapshot),subset:null},times.now),row=result.rows.find(row=>row.Order==='d')!;
    assert.equal(row.Owner,owner);assert.equal(row.Deadline,null);assert.equal(row['Remaining seconds'],null);assert.equal(row.Clock,'unknown');
  }
  for(const state of ['waiting_for_seller_response','waiting_for_buyer_response','under_review','closed']){
    const current=instrumentCorpus(),event=current.events.find(row=>row.orderId==='d'&&row.type==='dispute.observed')!;event.state=state;
    for(const interval of current.intervals)if(interval.orderId==='d'&&interval.dimension==='dispute'&&interval.sourceEventId===event.id)interval.state=state;
    const snapshot=buildSnapshot(current,{asOf:times.end,knownAt:times.known,semanticModelVersion:COMMERCE_SEMANTICS});
    const result=instrumentResult({snapshot,kind:'deadline-strip',format:{},mapping:{orderId:'order_snapshot.id'},original:nativeRows(snapshot),subset:null},times.now),row=result.rows.find(row=>row.Order==='d')!,admitted=snapshot.tables.deadline_snapshot.find(row=>row.orderId==='d')!;
    assert.equal(row.Owner,admitted.owner);assert.equal(row.Owner,({waiting_for_seller_response:'merchant',waiting_for_buyer_response:'buyer',under_review:'provider',closed:'none'} as Record<string,string>)[state]);
    assert.equal(row['Remaining seconds'],state==='waiting_for_seller_response'?86400:null);
    const sample=structuredClone(snapshot);sample.tables.deadline_snapshot.find(row=>row.orderId==='d')!.dueDateVerified=false;
    const unverified=instrumentResult({snapshot:sample,kind:'deadline-strip',format:{},mapping:{orderId:'order_snapshot.id'},original:nativeRows(sample),subset:null},times.now).rows.find(row=>row.Order==='d')!;
    assert.equal(unverified.Owner,admitted.owner);assert.equal(unverified.Deadline,null);assert.equal(unverified['Remaining seconds'],null);
  }
});

test('River canonical transition clock is supported and alternate clocks return the same live model refusal as print',()=>{
  const snapshot=source(),input:InstrumentInput={snapshot,kind:'commerce-river',format:{displayMode:'transitions',rangeStart:times.one,rangeEnd:times.two},mapping:{orderId:'order_snapshot.id',category:'order_snapshot.fulfillmentState',time:'transition_snapshot.transitionTime'},original:nativeRows(snapshot,'fulfillmentState'),subset:null};
  const canonical=instrumentResult(input);assert.equal(canonical.error,undefined);assert.ok(canonical.rows.length);assert.match(canonical.notes.join(' '),/Pending captures and queued shipments/);
  for(const time of ['order_snapshot.promisedAt','order_snapshot.narrativeCreatedAt','shipment_snapshot.occurredAt']){
    const refused=instrumentResult({...input,mapping:{...input.mapping,time}});assert.match(refused.error??'',/transition_snapshot\.transitionTime/);assert.deepEqual(refused.rows,[]);assert.deepEqual(refused.groups,[]);
  }
});
