import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgDataEngine,AgReportState,AgWidgetField,AgWidgetParams} from 'ag-studio';
import {buildSnapshot} from '../packages/domain';
import {buildOrderDetail} from '../packages/domain/order-detail';
import {COMMERCE_SEMANTICS,COMMERCE_SEMANTICS_V2} from '../packages/domain/commerce-resources';
import {prepareSnapshot} from '../packages/studio/atomic-snapshot';
import {fieldsFor,studioData} from '../packages/studio/data';
import {nativePrint,nativeOrderScope} from '../packages/studio/native-print';
import type {GlasshouseRegistry} from '../packages/studio/types';
import {nativeStudio} from './helpers/studio-native';
import {instrumentCorpus,times,plus} from './reference/instrument-corpus';

const context={asOf:times.end,knownAt:times.known,currency:'USD' as const};

test('current v3 proof retains every admitted resource, exact money and original knowledge boundary alongside v2',()=>{
  const dataset=instrumentCorpus();
  for(const semanticModelVersion of [COMMERCE_SEMANTICS_V2,COMMERCE_SEMANTICS]){
    const snapshot=buildSnapshot(dataset,{...context,semanticModelVersion});
    const proof=buildOrderDetail(dataset,snapshot,'a')!;
    assert.equal(proof.snapshotHash,snapshot.hash);
    assert.equal(proof.order.capturedMinor,10000);
    assert.equal(proof.order.refundedMinor,1000);
    assert.equal(proof.order.refundableMinor,8800);
    assert.deepEqual(proof.resources!.filter(row=>row.kind==='capture').map(row=>[row.resourceId,row.state,row.amountMinor]).sort(),[
      ['sample:cap-a-0','completed',4000],['sample:cap-a-1','completed',6000],
    ]);
    assert.equal(proof.resources!.filter(row=>row.kind==='line').length,2);
    assert.deepEqual(proof.resources!.filter(row=>row.kind==='shipment').map(row=>[row.resourceId,row.state]).sort(),[
      ['sample:ship-a-0','delivered'],['sample:ship-a-1','in_transit'],
    ]);
    assert.deepEqual(proof.resources!.filter(row=>row.kind==='refund').map(row=>[row.resourceId,row.state,row.amountMinor]).sort(),[
      ['sample:refund-a-0','completed',700],['sample:refund-a-1','completed',300],['sample:refund-a-pending','pending',200],
    ]);
    assert.ok(proof.resources!.every(row=>row.sourceClass==='sample'));
    assert.deepEqual(proof.providerReceipts,[],'Fictional resource rows cannot manufacture provider receipts.');
    const early=buildOrderDetail(dataset,buildSnapshot(dataset,{...context,knownAt:times.four,semanticModelVersion}),'a')!;
    assert.deepEqual(early.resources!.filter(row=>row.kind==='refund').map(row=>[row.resourceId,row.amountMinor]),[['sample:refund-a-1',300]]);
    assert.ok(!JSON.stringify(early).includes('sample:refund-a-0'));
    const sterling=buildOrderDetail(dataset,buildSnapshot(dataset,{...context,currency:'GBP',semanticModelVersion}),'f')!;
    assert.deepEqual(sterling.resources!.filter(row=>row.kind==='capture').map(row=>[row.state,row.amountMinor,row.currency]),[['pending',700,'GBP']]);
    assert.equal(sterling.order.capturedMinor,0,'A pending resource is not captured money.');
    assert.equal(buildOrderDetail(dataset,snapshot,'e'),null);
    assert.equal(buildOrderDetail(dataset,snapshot,'foreign'),null);
  }
  const legacy=buildOrderDetail(dataset,buildSnapshot(dataset,{...context,semanticModelVersion:'commerce-semantic-v1'}),'a')!;
  assert.equal(Object.hasOwn(legacy,'resources'),false);
});

async function nativeRows(engine:AgDataEngine,table:string,fields:string[]){
  const [result]=await engine.execute({query:{projection:fields.map(field=>({field:{key:field,sourceId:table,fieldId:field},as:field}))},options:{shape:'rows',strict:true}});
  assert.equal(result.metadata?.error,undefined);
  assert.equal(result.dataShape,'rows');
  return result.dataShape==='rows'?result.rows:[];
}

test('v2 to v3 admission adds the twelfth native source and retains its typed empty schema through exact rewinds',async t=>{
  const dataset=instrumentCorpus();
  const previous=buildSnapshot(dataset,{...context,semanticModelVersion:COMMERCE_SEMANTICS_V2});
  const current=buildSnapshot(dataset,{...context,semanticModelVersion:COMMERCE_SEMANTICS});
  const empty=buildSnapshot(dataset,{...context,asOf:plus(times.start,-1),semanticModelVersion:COMMERCE_SEMANTICS});
  const original=JSON.stringify(previous),measurements=[];
  for(const [before,after] of [[previous,current],[current,empty],[empty,current]]){
    const prepared=await prepareSnapshot(before,after);
    try{
      const rows=await nativeRows(prepared.engine,'regional_baseline_order_snapshot',['id','orderId','baselineAt','eligibleShipmentCount','lateCount','snapshotHash']);
      assert.equal(rows.length,after===empty?0:6);
      assert.ok(rows.every(row=>row.snapshotHash===after.hash));
      if(after!==empty)assert.deepEqual(rows.map(row=>[row.orderId,row.eligibleShipmentCount,row.lateCount]).sort(),[
        ['a',2,2],['b',0,0],['c',0,0],['d',1,0],['g',0,0],['h',1,1],
      ]);
      assert.equal(Object.keys(after.tables).length,12);
      measurements.push({from:before.context.semanticModelVersion,to:after.context.semanticModelVersion,asOf:after.context.asOf,tables:12,nativeReadbackMs:prepared.elapsedMs});
    }finally{prepared.dispose();}
  }
  assert.equal(JSON.stringify(previous),original);
  const fields=fieldsFor('regional_baseline_order_snapshot',[]);
  for(const id of ['orderCount','eligibleShipmentCount','lateCount'])assert.equal(fields?.find(field=>field.id===id)?.format,'integerFormat');
  assert.equal(fields?.find(field=>field.id==='baselineAt')?.format,'dateTimeFormat');
  const data=studioData(empty);
  assert.ok(data.relationships?.some(relation=>relation.source==='order_snapshot.id'&&relation.target==='regional_baseline_order_snapshot.orderId'));
  assert.equal(studioData(previous).sources.some(source=>source.id==='regional_baseline_order_snapshot'),false);
  t.diagnostic(JSON.stringify({actualNativeEngine:'AG Studio 3.1.0',measurements,originalFixtureWrites:0}));
});

test('a native baseline-source predicate scopes peer orders and exact print without multiplying capture money',async t=>{
  const snapshot=buildSnapshot(instrumentCorpus(),{...context,semanticModelVersion:COMMERCE_SEMANTICS});
  const state:AgReportState<GlasshouseRegistry>={selectedPageId:'baseline',pages:[{id:'baseline',
    layout:{type:'widget',minWidth:320,columns:24,rowHeight:16},
    widgets:{orders:{type:'grid',dataMapping:{cols:[{id:'order_snapshot.id'},{id:'order_snapshot.capturedMinor',aggregation:'sum'}]},format:{crossFilter:'filter'}}},
    widgetLayout:{orders:{xTrack:0,yTrack:0,xSpan:24,ySpan:20}},
    filter:{page:[{field:{id:'regional_baseline_order_snapshot.lateCount'},model:{operator:'greaterThan',value:0}}]},
  }]};
  let params:(AgWidgetParams&{dataMapping:{cols:AgWidgetField[]}})|undefined;
  const fixture=await nativeStudio(t,state,{snapshot,onWidget:p=>{if(p.widgetId==='orders')params=p as typeof params;}});
  assert.ok(params);
  const live=await params.widgetApi.getData({fields:params.dataMapping.cols},{queryId:'baseline-orders',crossFilter:'filter'});
  assert.equal(live.results.metadata?.error,undefined);
  assert.deepEqual(live.results.rows.map(row=>[row['order_snapshot.id'],row['order_snapshot.capturedMinor.sum']]).sort(),[['a',10000],['h',1000]]);
  assert.deepEqual((await nativeOrderScope(snapshot,fixture.api.getState())).sort(),['a','h']);
  const printed=(await nativePrint(snapshot,fixture.api.getState(),times.now)).widgets[0];
  assert.equal(printed.status,'exact',printed.reason);
  assert.deepEqual(printed.rows.map(row=>[row['order_snapshot.id'],row['order_snapshot.capturedMinor:sum']]).sort(),[['a',10000],['h',1000]]);
  assert.equal(printed.query?.joins?.[0].joinType,'semi-left');
  assert.equal(printed.query?.joins?.[0].isFilterOnly,true);
  assert.deepEqual(fixture.errors,[]);
});
