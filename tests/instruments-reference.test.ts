import test from 'node:test';
import assert from 'node:assert/strict';
import {agentHarness} from './helpers/agents';
import {instrumentCorpus,times,plus} from './reference/instrument-corpus';
import {referenceLedger,referenceResources} from './reference/instrument-sql';
import {buildSnapshot,createSeedDataset} from '../packages/domain';
import {COMMERCE_SEMANTICS,resourcesAt} from '../packages/domain/commerce-resources';
import {nativePrint} from '../packages/studio/native-print';
import {initialState} from '../packages/studio/registry';
import {instrumentResult,normalizeInstrumentRows} from '../packages/studio/instrument-model';
import type {Currency,QueryContext,Snapshot} from '../packages/domain/types';
import type {InstrumentData} from '../packages/studio/types';
const cut=(asOf=times.end,knownAt=times.known,currency:Currency='USD',clockDomain:QueryContext['clockDomain']='narrative_replay')=>({asOf,knownAt,currency,clockDomain,semanticModelVersion:COMMERCE_SEMANTICS});
const total=(rows:Record<string,unknown>[],key:string)=>rows.reduce((n,row)=>n+Number(row[key]),0);
const formatted=(snapshot:Snapshot,kind:InstrumentData['type'],format:InstrumentData['format'],ids=snapshot.orders.map(order=>order.id))=>{
 const category=kind==='impact-map'?'regionCode':kind==='evidence-lens'?'paymentSource':kind==='recovery-branches'?'seedGroup':kind==='deadline-strip'?'disputeState':'fulfillmentState',value=kind==='recovery-branches'?'refundableMinor':kind==='evidence-lens'?'supportContacts':kind==='deadline-strip'?'amountMinor':'capturedMinor';
 const keys={orderId:'id',category,value,...kind==='time-dial'?{time:'narrativeCreatedAt'}:{}};
 return instrumentResult({snapshot,kind,format:format??{},mapping:{orderId:'order_snapshot.id',category:'order_snapshot.'+category,value:'order_snapshot.'+value,...kind==='time-dial'?{time:'order_snapshot.narrativeCreatedAt'}:{}},original:normalizeInstrumentRows(snapshot.tables.order_snapshot,keys),subset:normalizeInstrumentRows(snapshot.tables.order_snapshot.filter(row=>ids.includes(String(row.id))),keys)},times.now);
};

test('independent PostgreSQL corpus agrees with all six actual native static views across T, K, scope and denomination',async t=>{
 const h=await agentHarness();t.after(h.dispose);const dataset=instrumentCorpus(h.who.tenantId);
 const contexts=[cut(plus(times.start,-1)),cut(times.start),cut(plus(times.one,-1)),cut(times.one),cut(times.two),cut(times.three,times.four),cut(times.three,times.late),cut(times.four),cut(times.end,times.known,'EUR'),cut(times.end,times.known,'GBP'),cut(plus(times.one,59),times.known,'USD','observed'),cut(plus(times.one,60),times.known,'USD','observed')];
 let comparisons=0;
 for(const context of contexts){
  const snapshot=buildSnapshot(dataset,context),reference=await referenceLedger(h.db,dataset,context),resources=await referenceResources(h.db,dataset,context);
  assert.deepEqual(snapshot.orders.map(row=>({id:row.id,captured:row.capturedMinor,captures:row.captureCount,refunded:row.refundedMinor,lines:row.lineCount,ships:row.shipmentCount,due:row.dueShipmentCount,late:row.lateShipmentCount,state:row.fulfillmentState})),reference.map(row=>({id:row.id,captured:row.captured_minor,captures:row.captures,refunded:row.refunded_minor,lines:row.lines,ships:row.shipments,due:row.due,late:row.late,state:row.fulfillment})),JSON.stringify(context));
  assert.equal(snapshot.totals.capturedMinor,total(reference,'captured_minor'));assert.equal(snapshot.totals.captures,total(reference,'captures'));assert.equal(snapshot.totals.refundMinor,total(reference,'refunded_minor'));
  for(const scope of [undefined,[],['a'],['b','d'],['c','g']]){
   const selected=reference.filter(row=>scope===undefined||scope.includes(row.id)),state=structuredClone(initialState),page=state.pages[0];
   (page.widgets!.river as InstrumentData).dataMapping!.value=[{id:'order_snapshot.capturedMinor',aggregation:'sum'}];(page.widgets!.river as InstrumentData).format={crossFilter:'highlight',measure:'value'};
   (page.widgets!.map as InstrumentData).format={crossFilter:'highlight',measure:'late-share'};
   if(scope)page.crossFilter={values:{corpus:[{type:'value',field:{id:'order_snapshot.id'},group:0,values:scope}]}};
   const print=await nativePrint(snapshot,state,times.now);
   for(const widget of print.widgets)assert.equal(widget.status,'exact',`${context.asOf}/${context.knownAt}/${context.currency}/${scope}: ${widget.widgetId}: ${widget.reason}`);
   const byId=new Map(print.widgets.map(widget=>[widget.widgetId,widget]));
   const river=byId.get('river')!.instrument!;assert.equal(river.scope,reference.length);assert.equal(river.selected,selected.length);assert.equal(river.groups.reduce((n,g)=>n+g.value,0),total(reference,'captured_minor'));assert.equal(river.groups.reduce((n,g)=>n+g.selected,0),total(selected,'captured_minor'));
   for(const group of river.groups)assert.equal(group.selected,selected.filter(row=>row.fulfillment===group.category).reduce((n,row)=>n+row.captured_minor,0));
   const dial=byId.get('dial')!.rows[0];assert.equal(dial['Event cutoff T'],context.asOf);assert.equal(dial['Knowledge cutoff K'],context.knownAt);assert.equal(dial.Orders,reference.length);
   const branches=byId.get('branches')!.instrument!.branches!;for(const branch of branches)assert.deepEqual(branch.rows.filter(row=>row.eligible).map(row=>row.orderId),selected.filter(row=>branch.id==='targeted'?row.targeted===true:row.comprehensive===true).map(row=>row.id));
   for(const group of byId.get('map')!.instrument!.groups){const rows=selected.filter(row=>(row.region_code||'UNKNOWN')===group.key);assert.equal(group.numerator,total(rows,'late'));assert.equal(group.denominator,total(rows,'due'));const table=byId.get('map')!.rows.find(row=>row.Region===group.label)!;assert.equal(table.Selected,total(rows,'due')?total(rows,'late')/total(rows,'due'):null);}
   const cases=selected.filter(row=>!['none','unknown','resolved','closed','cancelled'].includes(row.dispute_state));const deadlines=byId.get('deadlines')!.rows;assert.equal(deadlines.length,cases.length);for(const row of deadlines){const expected=cases.find(value=>value.id===row.Order)!;assert.equal(row.Deadline,expected.dispute_source==='sandbox'?expected.deadline:null);assert.equal(row['Remaining seconds'],expected.dispute_source==='sandbox'&&expected.deadline?Math.floor((Date.parse(expected.deadline)-Date.parse(times.now))/1000):null);}
   const selectedIds=new Set(selected.map(row=>row.id));
   const expectedEvidence=[...selected.flatMap(row=>['evidence-payment-'+row.id,'evidence-shipment-'+row.id]),...resources.filter(row=>selectedIds.has(String(row.fact.orderId))).map(row=>'evidence-resource:'+row.fact.id),...dataset.evidence.filter(row=>row.orderId&&selectedIds.has(row.orderId)&&Date.parse(row.occurredAt)<=Date.parse(context.asOf)&&Date.parse(row.ingestedAt)<=Date.parse(context.knownAt)).map(row=>row.id)].sort();
   assert.deepEqual(byId.get('evidence')!.rows.map(row=>String(row.Evidence)).sort(),expectedEvidence);
   assert.equal(byId.get('records')!.rows.length,selected.length);comparisons++;
  }
 }
 t.diagnostic(JSON.stringify({actualPostgreSQL:process.env.GLASSHOUSE_AGENTS_TEST_PG==='true',nativeEngine:'AG Studio 3.1.0',contexts:contexts.length,nativeReports:comparisons,widgetsCompared:comparisons*7,providerCalls:0,modelCalls:0}));
});

test('resource state, transfers and knowledge have distinct boundaries; duplicate transports never mint money',()=>{
 const dataset=instrumentCorpus(),before=buildSnapshot(dataset,cut(times.three,times.four)),late=buildSnapshot(dataset,cut(times.three,times.late)),full=buildSnapshot(dataset,cut());
 assert.equal(before.orders.find(row=>row.id==='a')!.refundedMinor,300);assert.equal(late.orders.find(row=>row.id==='a')!.refundedMinor,1000);
 assert.equal(before.orders.find(row=>row.id==='a')!.lateShipmentCount,1);assert.equal(late.orders.find(row=>row.id==='a')!.lateShipmentCount,2);assert.equal(full.orders.find(row=>row.id==='a')!.lateShipmentCount,1);
 assert.equal(full.totals.capturedMinor,18800);assert.equal(full.totals.captures,7);assert.equal(full.orders.find(row=>row.id==='a')!.refundableMinor,8800);assert.equal(full.orders.find(row=>row.id==='a')!.fulfillmentState,'in_transit');
 const captures=full.tables.transition_snapshot.filter(row=>row.dimension==='payment'&&String(row.transitionTime)>=times.one&&String(row.transitionTime)<times.two);
 assert.equal(total(captures,'amountMinor'),12800);assert.equal(total(captures,'captureCount'),6);
 const range=instrumentResult({snapshot:full,kind:'commerce-river',format:{displayMode:'transitions',measure:'value',rangeStart:times.one,rangeEnd:times.two},mapping:{orderId:'order_snapshot.id',category:'order_snapshot.paymentState',value:'order_snapshot.amountMinor'},original:normalizeInstrumentRows(full.tables.order_snapshot,{orderId:'id',category:'paymentState',value:'amountMinor'}),subset:null});
 assert.equal(range.error,undefined);assert.equal(range.groups.reduce((n,row)=>n+row.value,0),12800);
 assert.equal(resourcesAt(dataset,full.context).find(row=>row.resourceId==='sample:cap-a-0')!.state,'completed');
 const corrupted=structuredClone(dataset);corrupted.commerceFacts!.push({...corrupted.commerceFacts![0],amountMinor:1});assert.throws(()=>buildSnapshot(corrupted,cut()),/identity cannot be rewritten/);
 const foreign=structuredClone(dataset);foreign.commerceFacts![0].tenantId='foreign';assert.throws(()=>buildSnapshot(foreign,cut()),/tenant and order scope/);
 const over=structuredClone(dataset);over.commerceFacts!.find(row=>row.resourceId==='sample:refund-a-0')!.amountMinor=5000;assert.throws(()=>buildSnapshot(over,cut()),/refunds exceed their capture/);
});

test('every form result is operative: zero cap, excluded orders, evidence controls, precise ranges and unknown ratios',()=>{
 const snapshot=buildSnapshot(instrumentCorpus(),cut());
 const all=formatted(snapshot,'recovery-branches',{budgetMinor:0}),one=formatted(snapshot,'recovery-branches',{budgetMinor:500,gracePolicy:'targeted',showBlocked:false});
 assert.equal(all.branches![0].eligibleCount,1);assert.equal(all.branches![0].withinBudget,false);assert.equal(one.branches!.length,1);assert.equal(one.branches![0].withinBudget,true);assert.equal(one.rows.length,1);assert.equal(one.rows[0].Order,'h');
 const excluded=formatted(snapshot,'recovery-branches',{budgetMinor:0},['d']);assert.equal(excluded.branches![0].eligibleCount,0);assert.equal(excluded.branches![0].rows[0].conditions.find(condition=>condition.key==='dispute')!.passed,false);
 const evidence=formatted(snapshot,'evidence-lens',{evidenceKind:'contradiction',evidenceSource:'sample',redactExcerpts:true});assert.equal(evidence.rows.length,1);assert.equal(evidence.rows[0].Excerpt,'Excerpt hidden in this view.');assert.equal(formatted(snapshot,'evidence-lens',{evidenceKind:'contradiction',showContradictions:false}).rows.length,0);
 const oldest=formatted(snapshot,'evidence-lens',{evidenceOrder:'oldest'});assert.ok(oldest.rows.every((row,index)=>!index||String(oldest.rows[index-1]['Known at'])<=String(row['Known at'])));
 const unknown=formatted(snapshot,'impact-map',{measure:'late-share'},['c','g']);const row=unknown.rows.find(row=>row.Region==='Unknown region')!;assert.equal(row.Due,0);assert.equal(row.Selected,null);
 assert.match(formatted(snapshot,'commerce-river',{displayMode:'transitions',rangeStart:'not a timestamp'}).error!,/ISO timestamp/);
 assert.match(formatted(snapshot,'impact-map',{displayMode:'small-multiples',measure:'value'}).error!,/Daily mapped money/);
 const money=formatted(snapshot,'commerce-river',{measure:'value'},['a']);assert.equal(money.groups.reduce((sum,row)=>sum+row.selected,0),10000);
 const known=formatted(snapshot,'deadline-strip',{showUnknown:false});assert.equal(known.rows.length,1);assert.equal(known.rows[0].Order,'d');assert.equal(formatted(snapshot,'deadline-strip',{deadlineOwner:'buyer'}).rows.length,0);
});

test('an appended resource representation cannot rewrite a prior known-at edition or enlarge provider balance',()=>{
 const old=createSeedDataset('legacy-resource-boundary'),context=cut(),before=buildSnapshot(old,context),order=old.orders[0];
 old.commerceFacts=[{id:'sample:new-capture-observation',tenantId:old.tenantId,orderId:order.id,kind:'capture',resourceId:'sample:new-capture',parentResourceId:null,state:'completed',amountMinor:100,quantity:null,currency:'USD',occurredAt:order.createdAt,narrativeTime:order.narrativeCreatedAt,ingestedAt:'2026-11-10T00:00:00.000Z',revision:2,sourceClass:'sample',sourceRef:'fixture://new-source'}];
 assert.equal(buildSnapshot(old,context).hash,before.hash);
 const future=buildSnapshot(old,{...context,knownAt:'2026-11-10T00:00:00.000Z'});assert.equal(future.orders[0].capturedMinor,100);assert.ok(future.orders[0].refundableMinor<=before.orders[0].refundableMinor);
});
