import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSnapshot} from '../packages/domain';
import {COMMERCE_SEMANTICS} from '../packages/domain/commerce-resources';
import {CARRIER_BASELINE_AT} from '../packages/domain/detectors';
import {appendStateObservation} from '../packages/domain/seed';
import {instrumentResult,type InstrumentRegionalStats} from '../packages/studio/instrument-model';
import type {QueryContext,SourceEvent} from '../packages/domain/types';
import {agentHarness} from './helpers/agents';
import {instrumentCorpus,times,plus} from './reference/instrument-corpus';
import {referenceLedger} from './reference/instrument-sql';

type ReferenceRow=Awaited<ReturnType<typeof referenceLedger>>[number];
const region=(row:ReferenceRow)=>row.region_code||'UNKNOWN';

test('v3 model daily and baseline original/selected stats match raw PostgreSQL across clocks, K, denominations and scoped IDs',async t=>{
  const h=await agentHarness();t.after(h.dispose);const dataset=instrumentCorpus(h.who.tenantId);
  const firstShipment=dataset.commerceFacts!.find(row=>row.resourceId==='sample:ship-a-0'&&row.state==='delayed')!;
  dataset.commerceFacts!.push({...firstShipment,id:'sample:model-baseline-correction',state:'delivered',narrativeTime:plus(times.one,30),occurredAt:plus(times.one,90),ingestedAt:times.late,revision:9});
  // A newly visible order has current facts but no historical baseline row.
  // Its earlier days must remain zero orders / unknown ratio, not borrow a total.
  dataset.orders.push({...dataset.orders.find(row=>row.id==='b')!,id:'z',reference:'REF-Z',regionCode:'NE',region:'Northeast',createdAt:plus(times.four,60),narrativeCreatedAt:times.four,promisedAt:times.four});
  const created:SourceEvent={...dataset.events.find(row=>row.orderId==='b'&&row.type==='order.created')!,id:'sample:model-late-order-created',orderId:'z',narrativeTime:times.four,occurredAt:plus(times.four,60),ingestedAt:plus(times.four,61)};
  dataset.events.push(created);appendStateObservation(dataset.intervals,created);
  for(const kind of ['capture','line','shipment'] as const){
    const original=dataset.commerceFacts!.find(row=>row.orderId==='b'&&row.kind===kind)!;
    dataset.commerceFacts!.push({...original,id:'sample:model-late-order-'+kind,orderId:'z',resourceId:'sample:'+kind+'-z',parentResourceId:kind==='shipment'?'sample:line-z':null,state:kind==='capture'?'pending':kind==='line'?'ordered':'delayed',narrativeTime:times.four,occurredAt:plus(times.four,60),ingestedAt:plus(times.four,61),revision:2});
  }
  const contexts:Partial<QueryContext>[]=[
    {asOf:plus(times.start,-1)}, {asOf:times.start}, {asOf:times.one},
    {asOf:times.three,knownAt:times.four}, {asOf:times.three,knownAt:times.late},
    {asOf:times.end,knownAt:times.four}, {asOf:times.end,knownAt:times.late}, {asOf:times.end},
    {asOf:times.end,currency:'EUR'}, {asOf:times.end,currency:'GBP'},
    {asOf:plus(times.one,59),clockDomain:'observed'}, {asOf:plus(times.one,60),clockDomain:'observed'},
  ];
  const scopes=[
    {original:undefined,selected:undefined},
    {original:['a','b','d','h','z'],selected:['a','z']},
    {original:['c','g'],selected:['c']},
    {original:['a','b','d'],selected:[]},
    {original:['z'],selected:['z']},
  ];
  let modelComparisons=0,sqlReads=0;const correctedBaseline=new Map<string,number>();
  const raw=async(context:QueryContext,ids?:string[])=>{sqlReads++;return referenceLedger(h.db,dataset,context,ids);};
  for(const options of contexts){
    const snapshot=buildSnapshot(dataset,{knownAt:times.known,currency:'USD',clockDomain:'narrative_replay',...options,semanticModelVersion:COMMERCE_SEMANTICS}),context=snapshot.context;
    const current=await raw(context),baselineAt=new Date(Math.min(Date.parse(CARRIER_BASELINE_AT),Date.parse(context.asOf))).toISOString();
    const days:string[]=[];for(let at=Date.parse('2026-11-02T00:00:00.000Z');at<=Date.parse(context.asOf);at+=86_400_000)days.push(new Date(at).toISOString().slice(0,10));
    for(const scope of scopes){
      const originalIds=current.filter(row=>scope.original===undefined||scope.original.includes(row.id)).map(row=>row.id),selectedIds=originalIds.filter(id=>scope.selected===undefined||scope.selected.includes(id));
      const original=snapshot.orders.filter(order=>originalIds.includes(order.id)).map(order=>({orderId:order.id,category:order.regionCode,value:order.amountMinor,time:null}));
      const subset=scope.selected===undefined?null:original.filter(row=>selectedIds.includes(row.orderId));
      const originalBaseline=await raw({...context,asOf:baselineAt},originalIds),selectedBaseline=await raw({...context,asOf:baselineAt},selectedIds);
      const daily=new Map<string,{original:ReferenceRow[];selected:ReferenceRow[]}>();
      if(originalIds.length)for(const day of days){
        const asOf=new Date(Math.min(Date.parse(day+'T23:59:59.999Z'),Date.parse(context.asOf))).toISOString();
        daily.set(day,{original:await raw({...context,asOf},originalIds),selected:await raw({...context,asOf},selectedIds)});
      }
      for(const measure of ['late-share','count'] as const){
        const model=instrumentResult({snapshot,kind:'impact-map',format:{displayMode:'small-multiples',measure},mapping:{orderId:'order_snapshot.id',category:'order_snapshot.regionCode'},original,subset},times.now);
        assert.equal(model.error,undefined,JSON.stringify({options,scope,measure}));assert.equal(model.scope,originalIds.length);assert.equal(model.selected,selectedIds.length);
        assert.deepEqual(model.groups.map(group=>group.key).sort(),[...new Set(current.filter(row=>originalIds.includes(row.id)).map(region))].sort());
        const expectedStats=(original:ReferenceRow[],selected:ReferenceRow[],code:string):InstrumentRegionalStats=>{
          const a=original.filter(row=>region(row)===code),b=selected.filter(row=>region(row)===code);
          const an=a.reduce((n,row)=>n+row.late,0),ad=a.reduce((n,row)=>n+row.due,0),bn=b.reduce((n,row)=>n+row.late,0),bd=b.reduce((n,row)=>n+row.due,0);
          return {originalValue:measure==='count'?a.length:ad?an/ad:null,selectedValue:measure==='count'?b.length:bd?bn/bd:null,originalOrderCount:a.length,selectedOrderCount:b.length,originalNumerator:an,originalDenominator:ad,selectedNumerator:bn,selectedDenominator:bd};
        };
        for(const group of model.groups){
          const baseline=expectedStats(originalBaseline,selectedBaseline,group.key);
          assert.deepEqual(group.baseline,{at:baselineAt,...baseline},JSON.stringify({options,scope,measure,region:group.key,period:'baseline'}));
          assert.deepEqual(group.daily!.map(row=>row.day),days);
          for(const day of group.daily!){
            const reference=daily.get(day.day)!,stats=expectedStats(reference.original,reference.selected,group.key);
            assert.deepEqual(day,{day:day.day,value:stats.selectedValue,numerator:stats.selectedNumerator,denominator:stats.selectedDenominator,...stats},JSON.stringify({options,scope,measure,region:group.key,day:day.day}));
            const exported=model.rows.find(row=>row.Region===group.label&&row.Period==='Daily'&&row.Time===day.day)!;
            assert.equal(exported['Original value'],stats.originalValue);assert.equal(exported['Selected value'],stats.selectedValue);assert.equal(exported['Original orders'],stats.originalOrderCount);assert.equal(exported['Selected orders'],stats.selectedOrderCount);assert.equal(exported['Original late'],stats.originalNumerator);assert.equal(exported['Original due'],stats.originalDenominator);assert.equal(exported['Selected late'],stats.selectedNumerator);assert.equal(exported['Selected due'],stats.selectedDenominator);modelComparisons++;
          }
          const exported=model.rows.find(row=>row.Region===group.label&&row.Period==='Historical baseline')!;
          assert.equal(exported.Time,baselineAt);assert.equal(exported['Original value'],baseline.originalValue);assert.equal(exported['Selected value'],baseline.selectedValue);assert.equal(exported['Original orders'],baseline.originalOrderCount);assert.equal(exported['Selected orders'],baseline.selectedOrderCount);assert.equal(exported['Original late'],baseline.originalNumerator);assert.equal(exported['Original due'],baseline.originalDenominator);assert.equal(exported['Selected late'],baseline.selectedNumerator);assert.equal(exported['Selected due'],baseline.selectedDenominator);modelComparisons++;
          if(measure==='late-share'&&context.asOf===times.end&&context.currency==='USD'&&context.clockDomain==='narrative_replay'&&scope.original===undefined&&group.key==='PNW')correctedBaseline.set(context.knownAt,group.baseline!.originalNumerator);
        }
        if(!originalIds.length)assert.deepEqual(model.rows,[]);
      }
    }
  }
  assert.equal(correctedBaseline.get(times.four),2);assert.equal(correctedBaseline.get(times.late),1);assert.equal(correctedBaseline.get(times.known),1);
  t.diagnostic(JSON.stringify({actualPostgreSQL:process.env.GLASSHOUSE_AGENTS_TEST_PG==='true',contexts:contexts.length,scopePairs:scopes.length,metrics:2,modelDayAndBaselineComparisons:modelComparisons,rawSqlReads:sqlReads,fixedFixtureWrites:0,providerCalls:0,modelCalls:0}));
});
