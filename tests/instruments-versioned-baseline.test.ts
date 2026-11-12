import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {agentHarness} from './helpers/agents';
import {instrumentCorpus,times,plus} from './reference/instrument-corpus';
import {referenceLedger} from './reference/instrument-sql';
import {buildSnapshot} from '../packages/domain';
import {COMMERCE_SEMANTICS,COMMERCE_SEMANTICS_V2,isCommerceResourceSemantics} from '../packages/domain/commerce-resources';
import {CARRIER_BASELINE_AT} from '../packages/domain/detectors';
import {snapshotContext} from '../lib/server/snapshots';
import type {Actor,QueryContext,Snapshot,TableRow} from '../packages/domain/types';

// Captured before the backend repair, independently retained in the private
// semantic-legacy-baselines.json receipt. These are not computed expectations.
const legacyCuts:Partial<QueryContext>[]=[
  {asOf:plus(times.start,-1),knownAt:times.known},
  {asOf:times.one,knownAt:times.known},
  {asOf:times.three,knownAt:times.four},
  {asOf:times.three,knownAt:times.late},
  {asOf:times.end,knownAt:times.known},
  {asOf:times.end,knownAt:times.known,currency:'EUR'},
  {asOf:times.end,knownAt:times.known,currency:'GBP'},
  {asOf:plus(times.one,60),knownAt:times.known,clockDomain:'observed'},
];
const legacyHashes:Record<string,string[]>={
  'commerce-semantic-v1':[
    'e789c082c8216f900e634145df1116ce29c11e444879941083509fad1c30d867',
    '9cb075d020baa319d152aa328aa419ca48546ba6e1e0261d489a341d0efcf373',
    '3a35c30db930c88280f58dbbfa00c6d64832b8b1b46bafd28a29296c08f7d61b',
    'c92d3e366c38d049e36f859129398e62e956faf6e6424013da2520be79991fb6',
    'c35a271b09aff8b560860407e99a14c4f7ad6c5dd5be24fe7f7b0c87545f348c',
    '8cd210120f49cf60aea5b906fb5437ec2f322c8058be29668a009fc86120985c',
    '93bd0e8114fa655f509caf9f78226766b4c1afd915a9963e718279ed34f58d4a',
    '64176785dcbc7d8333e20ccf40dfc93db3f1da49f9ff6e02dc94fe27c8fd4b88',
  ],
  'commerce-semantic-v2':[
    '05c7430fcedf9e5e774c55a4e0566a0620a66299e4734f6931c34a1a8f5ed39f',
    'dfcf774b8f9ec74c2bbb4f05df50185e7723075a4bf305c660748eb3e39fffd2',
    '59e0a0adf3994e784cc772eef270b6ec5e762aed793be73b00e75ce738ed52ac',
    'fe70ceddd78fdc12fb6ccadbc3c1f493620de1af5d77b1ff9884e942e6c2dbbe',
    '64d32d92f8c524278b0612bbf7390bf60e9f43c2a19a37f2d454d4ff781fcbfa',
    '9d5b98bf55fc37c1af3a9898b3778e2ebdbe95aa5c836486b3ed8560d1520b29',
    '29d4170fdd0b1229831089a07a73482602eb60cb12f88a3a88c44c607a8b30e0',
    'c5f5f496a3e680ce1bc0291dd89ac236b0815cfb93d3cc9b50875afcbccc3511',
  ],
};

test('v1 and v2 retain every captured reconstruction hash while new server intents use separately identified v3',()=>{
  for(const [semanticModelVersion,hashes] of Object.entries(legacyHashes))for(const [index,cut] of legacyCuts.entries()){
    const source=buildSnapshot(instrumentCorpus(),{...cut,semanticModelVersion});
    assert.equal(source.hash,hashes[index],JSON.stringify({semanticModelVersion,...cut}));
    assert.equal(Object.hasOwn(source.tables,'regional_baseline_order_snapshot'),false);
  }
  const dataset=instrumentCorpus(),actor:Actor={id:'baseline-reviewer',tenantId:dataset.tenantId,role:'investigator',membershipVersion:1};
  assert.equal(COMMERCE_SEMANTICS,'commerce-semantic-v3');
  assert.equal(COMMERCE_SEMANTICS_V2,'commerce-semantic-v2');
  const context=snapshotContext(actor,dataset);
  assert.equal(context.semanticModelVersion,COMMERCE_SEMANTICS);
  const current=buildSnapshot(dataset,context);
  assert.ok(current.tables.regional_baseline_order_snapshot);
  assert.notEqual(current.hash,buildSnapshot(dataset,{...context,semanticModelVersion:COMMERCE_SEMANTICS_V2}).hash);
  assert.equal(isCommerceResourceSemantics('commerce-semantic-v1'),false);
  assert.equal(isCommerceResourceSemantics(COMMERCE_SEMANTICS_V2),true);
  assert.equal(isCommerceResourceSemantics(COMMERCE_SEMANTICS),true);
});

test('the copied original v2 fixture reconstructs byte-equivalent content without relabelling or changing its authority',async t=>{
  const snapshotFile='.private/native-fixture/snapshot.json',datasetFile='.private/native-fixture/dataset.json';
  if(!existsSync(snapshotFile)||!existsSync(datasetFile)){t.skip('The original private frozen fixture is intentionally absent outside its qualification copy.');return;}
  const source=JSON.parse(await readFile(snapshotFile,'utf8')) as Snapshot,dataset=JSON.parse(await readFile(datasetFile,'utf8'));
  assert.equal(source.context.semanticModelVersion,COMMERCE_SEMANTICS_V2);
  assert.equal(source.hash,'cc4190e5e0d5f3e7a03a3a2cea1a719445f3b86b648b0927947efc525b927f20');
  const reconstructed=buildSnapshot(dataset,{...source.context,generationId:source.generationId});
  assert.deepEqual(JSON.parse(JSON.stringify(reconstructed)),source);
  const descriptor=JSON.parse(await readFile('.private/native-fixture/descriptor.json','utf8'));
  assert.equal(descriptor.originalExpiresAt,'2026-11-19T03:24:53.834Z');
});

test('v3 baseline order contributions match independent raw PostgreSQL at baseline T with pinned K, denomination and selected IDs',async t=>{
  const h=await agentHarness();t.after(h.dispose);
  const dataset=instrumentCorpus(h.who.tenantId);
  // A genuinely late knowledge correction changes the earlier historical baseline,
  // while later event-time observations still determine the current inventory.
  const shipment=dataset.commerceFacts!.find(row=>row.orderId==='a'&&row.resourceId==='sample:ship-a-0'&&row.state==='delayed')!;
  dataset.commerceFacts!.push({...shipment,id:'sample:baseline-delivery-correction',state:'delivered',narrativeTime:plus(times.one,30),occurredAt:plus(times.one,90),ingestedAt:times.late,revision:9});
  const contexts:Partial<QueryContext>[]=[
    {asOf:plus(times.start,-1)}, {asOf:times.start}, {asOf:plus(times.one,-1)}, {asOf:times.one},
    {asOf:CARRIER_BASELINE_AT,knownAt:times.four},
    {asOf:times.end,knownAt:times.four}, {asOf:times.end,knownAt:times.late}, {asOf:times.end},
    {asOf:times.end,currency:'EUR'}, {asOf:times.end,currency:'GBP'},
    {asOf:plus(times.one,59),clockDomain:'observed'}, {asOf:plus(times.one,60),clockDomain:'observed'},
  ];
  const scopes:(string[]|undefined)[]=[undefined,[],['a'],['b','d'],['c','g'],['h'],['outside-current-authority']];
  let comparisons=0;const lateCounts=new Map<string,number>();
  const numericTotal=(rows:TableRow[],key:string)=>rows.reduce((sum,row)=>sum+Number(row[key]),0);
  for(const options of contexts){
    const source=buildSnapshot(dataset,{knownAt:times.known,currency:'USD',clockDomain:'narrative_replay',...options,semanticModelVersion:COMMERCE_SEMANTICS});
    const baselineAt=new Date(Math.min(Date.parse(CARRIER_BASELINE_AT),Date.parse(source.context.asOf))).toISOString();
    const rows=source.tables.regional_baseline_order_snapshot;
    assert.equal(new Set(rows.map(row=>row.id)).size,rows.length,'Baseline IDs must never repeat across story days.');
    assert.ok(rows.every(row=>row.id==='region-baseline:'+row.orderId&&row.grain==='region_order_baseline'&&row.baselineAt===baselineAt&&row.snapshotHash===source.hash&&row.orderCount===1));
    const referenceContext={...source.context,asOf:baselineAt};
    const whole=await referenceLedger(h.db,dataset,referenceContext);
    assert.deepEqual(rows.map(row=>({id:String(row.orderId),regionCode:row.regionCode,due:Number(row.eligibleShipmentCount),late:Number(row.lateCount)})),whole.map(row=>({id:row.id,regionCode:row.region_code||'UNKNOWN',due:row.due,late:row.late})),JSON.stringify(source.context));
    for(const regional of source.tables.regional_snapshot){
      const baseline=whole.filter(row=>(row.region_code||'UNKNOWN')===regional.regionCode),denominator=baseline.reduce((sum,row)=>sum+row.due,0),numerator=baseline.reduce((sum,row)=>sum+row.late,0);
      assert.equal(regional.baselineAt,baselineAt);
      assert.equal(regional.baselineOrderCount,baseline.length);
      assert.equal(regional.baselineNumerator,numerator);
      assert.equal(regional.baselineDenominator,denominator);
      assert.equal(regional.baselineShare,denominator?numerator/denominator:null,'An empty historical denominator is unknown, never 0% late.');
    }
    for(const scope of scopes){
      const selected=scope===undefined?rows:rows.filter(row=>scope.includes(String(row.orderId)));
      // The oracle reads raw observations and applies the ID predicate in SQL;
      // it calls neither buildSnapshot nor the product resource projection.
      const reference=await referenceLedger(h.db,dataset,referenceContext,scope);
      assert.deepEqual(selected.map(row=>String(row.orderId)),reference.map(row=>row.id));
      assert.equal(numericTotal(selected,'eligibleShipmentCount'),reference.reduce((sum,row)=>sum+row.due,0));
      assert.equal(numericTotal(selected,'lateCount'),reference.reduce((sum,row)=>sum+row.late,0));
      comparisons++;
    }
    if(source.context.asOf===times.end&&source.context.currency==='USD'&&source.context.clockDomain==='narrative_replay')lateCounts.set(source.context.knownAt,Number(rows.find(row=>row.orderId==='a')!.lateCount));
  }
  assert.equal(lateCounts.get(times.four),2);
  assert.equal(lateCounts.get(times.late),1,'K alone must change the earlier baseline when late evidence actually corrects it.');
  t.diagnostic(JSON.stringify({actualPostgreSQL:process.env.GLASSHOUSE_AGENTS_TEST_PG==='true',semanticModelVersion:COMMERCE_SEMANTICS,contexts:contexts.length,independentSqlScopeComparisons:comparisons,fixedFixtureWrites:0,providerCalls:0,modelCalls:0}));
});
