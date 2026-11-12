import type {CommerceFact,CommerceResource,QueryContext,SeedDataset,Snapshot,SnapshotOrder,TableRow,Evidence,SourceEvent} from './types';
import {evaluateBranches,DEFAULT_BUDGET_MINOR} from './policy';
import {runDetectors,CARRIER_BASELINE_AT} from './detectors';
import {stableHash,withoutSnapshotHashes,projectOrders,intervalContains} from './temporal';

export const COMMERCE_SEMANTICS_V2 = 'commerce-semantic-v2';
export const COMMERCE_SEMANTICS = 'commerce-semantic-v3';
export const isCommerceResourceSemantics=(version:string|undefined)=>version===COMMERCE_SEMANTICS_V2||version===COMMERCE_SEMANTICS;
const kinds:CommerceResource[]=['line','capture','refund','shipment'];
const completed=(state:string)=>['captured','completed','succeeded','refunded'].includes(state);
const compare=(a:CommerceFact,b:CommerceFact)=>Date.parse(a.ingestedAt)-Date.parse(b.ingestedAt)||a.revision-b.revision||Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id);
const key=(fact:CommerceFact)=>`${fact.kind}:${fact.resourceId}`;
const minor=(value:number)=>{if(!Number.isSafeInteger(value)||value<0)throw new Error('Commerce money must be non-negative safe integer minor units.');return value;};
const sum=(values:number[])=>minor(values.reduce((a,b)=>minor(a+b),0));

/** Validate the source representation, including observations outside the current cutoffs. */
export function validateCommerceFacts(dataset:Pick<SeedDataset,'tenantId'|'orders'|'commerceFacts'>):void{
  const orders=new Map(dataset.orders.map(order=>[order.id,order])),ids=new Map<string,string>(),resources=new Map<string,string>();
  for(const fact of dataset.commerceFacts??[]){
    const order=orders.get(fact.orderId);
    if(!order||fact.tenantId!==dataset.tenantId||order.tenantId!==dataset.tenantId)throw new Error('Commerce fact is outside its tenant and order scope.');
    if(!kinds.includes(fact.kind)||!fact.id||!fact.resourceId||fact.currency!==order.currency)throw new Error('Commerce fact needs a known resource and the order denomination.');
    if(!['sample','fixture_shipping','fixture_support','sandbox','replay','modelled'].includes(fact.sourceClass)||typeof fact.sourceRef!=='string'||!fact.sourceRef||typeof fact.state!=='string'||!fact.state)throw new Error('Commerce fact needs explicit source provenance and a resource state.');
    if(![fact.occurredAt,fact.narrativeTime,fact.ingestedAt].every(value=>/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)&&Number.isFinite(Date.parse(value)))||!Number.isSafeInteger(fact.revision)||fact.revision<0)throw new Error('Commerce fact needs exact valid and knowledge clocks and a revision.');
    if(fact.amountMinor!==null)minor(fact.amountMinor);
    if(['capture','refund'].includes(fact.kind)&&fact.amountMinor===null)throw new Error('A financial resource needs an exact minor-unit amount.');
    if(fact.kind==='refund'&&!fact.parentResourceId)throw new Error('A refund must identify its capture.');
    if(fact.quantity!==null&&(!Number.isSafeInteger(fact.quantity)||fact.quantity<1))throw new Error('Resource quantity must be a positive integer.');
    if(fact.promisedAt!==undefined&&fact.promisedAt!==null&&!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(fact.promisedAt)||fact.promisedAt!=null&&!Number.isFinite(Date.parse(fact.promisedAt)))throw new Error('Shipment promises need an explicit valid timestamp or unknown.');
    const encoded=stableHash(fact),existing=ids.get(fact.id);
    if(existing&&existing!==encoded)throw new Error('A commerce observation identity cannot be rewritten.');
    ids.set(fact.id,encoded);
    const owner=resources.get(key(fact));
    if(owner&&owner!==fact.orderId)throw new Error('A resource identity cannot belong to two orders.');
    resources.set(key(fact),fact.orderId);
  }
  for(const fact of dataset.commerceFacts??[]){
    if(fact.parentResourceId===null)continue;
    if(fact.kind==='refund'){
      const owner=resources.get('capture:'+fact.parentResourceId),order=orders.get(fact.orderId)!;
      if(owner?owner!==fact.orderId:fact.parentResourceId!==order.captureId&&fact.parentResourceId!==`legacy-capture:${fact.orderId}`)throw new Error('A refund parent must be a capture owned by the same order.');
    }else if(fact.kind==='shipment'){
      if(resources.get('line:'+fact.parentResourceId)!==fact.orderId&&fact.parentResourceId!==`legacy-line:${fact.orderId}`)throw new Error('A shipment parent must be a line owned by the same order.');
    }else throw new Error('Only refunds and shipments may name parent resources.');
  }
}

/** Latest knowledge about a resource at T, never one row per webhook delivery. */
export function resourcesAt(dataset:SeedDataset,context:QueryContext):CommerceFact[]{
  validateCommerceFacts(dataset);
  const visible=new Map<string,CommerceFact>();
  for(const fact of dataset.commerceFacts??[]){
    const valid=context.clockDomain==='observed'?fact.occurredAt:fact.narrativeTime;
    if(fact.currency!==context.currency||Date.parse(valid)>Date.parse(context.asOf)||Date.parse(fact.ingestedAt)>Date.parse(context.knownAt))continue;
    const previous=visible.get(key(fact));
    const previousTime=previous&&(context.clockDomain==='observed'?previous.occurredAt:previous.narrativeTime);
    if(!previous||Date.parse(valid)>Date.parse(previousTime!)||Date.parse(valid)===Date.parse(previousTime!)&&compare(previous,fact)<0)visible.set(key(fact),fact);
  }
  return [...visible.values()].sort((a,b)=>key(a).localeCompare(key(b)));
}

function legacyFacts(order:SnapshotOrder,context:QueryContext,events:SourceEvent[],fulfillmentEvent:SourceEvent|undefined):CommerceFact[]{
  const base={tenantId:order.tenantId,orderId:order.id,currency:order.currency,occurredAt:order.providerOccurredAt??order.createdAt,narrativeTime:order.narrativeCreatedAt,ingestedAt:context.knownAt,revision:order.resourceVersion,sourceClass:order.paymentSource,sourceRef:order.captureId??`sample:${order.id}`,quantity:null,parentResourceId:null};
  const capture=order.captureId??`legacy-capture:${order.id}`;
  const clocks=(_dimension:'payment'|'fulfillment',type?:string)=>{const event=type?events.filter(event=>event.type===type).sort((a,b)=>Date.parse(b.ingestedAt)-Date.parse(a.ingestedAt)||b.revision-a.revision)[0]:fulfillmentEvent;return event?{occurredAt:event.occurredAt,narrativeTime:event.narrativeTime,ingestedAt:event.ingestedAt,revision:event.revision,sourceClass:event.sourceClass,sourceRef:event.sourceRef}:{};};
  const identifiedRefunds=new Map<string,CommerceFact>();
  const inventory=events.filter(event=>event.type==='payment.refund_balance_observed'&&event.payload.complete===true).sort((a,b)=>Date.parse(b.ingestedAt)-Date.parse(a.ingestedAt)||b.revision-a.revision)[0];
  if(inventory&&Array.isArray(inventory.payload.refunds))for(const value of inventory.payload.refunds){
    if(!value||typeof value!=='object'||!('id'in value)||typeof value.id!=='string'||!('amountMinor'in value)||!('status'in value)||typeof value.status!=='string')throw new Error('A complete refund inventory has an invalid resource record.');
    const amountMinor=minor(Number(value.amountMinor));
    const row:CommerceFact={...base,...clocks('payment','payment.refund_balance_observed'),id:'legacy-refund:'+value.id,resourceId:value.id,kind:'refund',parentResourceId:capture,state:value.status.toLowerCase(),amountMinor};
    const prior=identifiedRefunds.get(value.id);if(prior&&stableHash(prior)!==stableHash(row))throw new Error('A refund inventory repeats an identity with conflicting money.');identifiedRefunds.set(value.id,row);
  }
  for(const event of events.filter(event=>event.type==='remediation.refunded').sort((a,b)=>Date.parse(a.ingestedAt)-Date.parse(b.ingestedAt)||a.revision-b.revision||a.id.localeCompare(b.id))){
    const id=String(event.payload.refundId??event.payload.providerResourceId??event.id),raw=event.payload.amountMinor??event.payload.refundMinor;
    if(raw===undefined)throw new Error('A completed refund needs its exact source amount.');
    identifiedRefunds.set(id,{...base,id:'legacy-refund:'+id,resourceId:id,kind:'refund',parentResourceId:typeof event.payload.captureId==='string'?event.payload.captureId:capture,state:'completed',amountMinor:minor(Number(raw)),occurredAt:event.occurredAt,narrativeTime:event.narrativeTime,ingestedAt:event.ingestedAt,revision:event.revision,sourceClass:event.sourceClass,sourceRef:event.sourceRef});
  }
  return [
    {...base,...clocks('payment','order.created'),id:`legacy-line:${order.id}`,resourceId:`legacy-line:${order.id}`,kind:'line',state:'ordered',amountMinor:order.amountMinor,quantity:1},
    ...(['captured','completed'].includes(order.paymentState)?[{...base,...clocks('payment','payment.captured'),id:capture,resourceId:capture,kind:'capture' as const,state:order.paymentState,amountMinor:order.amountMinor}]:[]),
    ...(identifiedRefunds.size?[...identifiedRefunds.values()]:order.refundedMinor?[{...base,...clocks('payment','payment.refund_balance_observed'),id:`legacy-refund-total:${order.id}`,resourceId:`legacy-refund-total:${order.id}`,kind:'refund' as const,parentResourceId:capture,state:'completed',amountMinor:order.refundedMinor}]:[]),
    ...(order.shipmentRef?[{...base,...clocks('fulfillment'),id:`legacy-shipment:${order.id}`,resourceId:order.shipmentRef,kind:'shipment' as const,state:order.fulfillmentState,amountMinor:null,promisedAt:order.promisedAt,sourceClass:'fixture_shipping' as const}]:[]),
  ];
}

function projectResources(dataset:SeedDataset,context:QueryContext,orders:SnapshotOrder[]){
  const facts=resourcesAt(dataset,context),byOrder=new Map<string,CommerceFact[]>();
  const eventsByOrder=new Map<string,SourceEvent[]>(),eventsById=new Map<string,SourceEvent>();
  for(const event of dataset.events){if(Date.parse(event.ingestedAt)>Date.parse(context.knownAt)||Date.parse(context.clockDomain==='observed'?event.occurredAt:event.narrativeTime)>Date.parse(context.asOf))continue;const list=eventsByOrder.get(event.orderId)??[];list.push(event);eventsByOrder.set(event.orderId,list);eventsById.set(event.id,event);}
  const fulfillmentByOrder=new Map<string,SourceEvent|undefined>();
  for(const interval of dataset.intervals.filter(interval=>interval.dimension==='fulfillment'&&intervalContains(interval,context)).sort((a,b)=>b.revision-a.revision||Date.parse(b.knowledgeFrom)-Date.parse(a.knowledgeFrom)||Date.parse(b.validFrom)-Date.parse(a.validFrom)||b.sourceEventId.localeCompare(a.sourceEventId)))if(!fulfillmentByOrder.has(interval.orderId))fulfillmentByOrder.set(interval.orderId,eventsById.get(interval.sourceEventId));
  for(const fact of facts){const list=byOrder.get(fact.orderId)??[];list.push(fact);byOrder.set(fact.orderId,list);}
  const kindsByOrder=new Map<string,Set<CommerceResource>>();
  for(const fact of (dataset.commerceFacts??[]).filter(fact=>Date.parse(fact.ingestedAt)<=Date.parse(context.knownAt))){const set=kindsByOrder.get(fact.orderId)??new Set<CommerceResource>();set.add(fact.kind);kindsByOrder.set(fact.orderId,set);}
  const materialized:CommerceFact[]=[];
  const projected=orders.map(source=>{
    const explicit=byOrder.get(source.id)??[],legacy=legacyFacts(source,context,eventsByOrder.get(source.id)??[],fulfillmentByOrder.get(source.id));
    // An explicitly represented resource kind replaces only that kind. An empty current set
    // at a known K stays empty when its valid time is still in the future. Before the
    // representation was known, historical snapshots retain their original legacy facts.
    const represented=kindsByOrder.get(source.id)??new Set<CommerceResource>();
    const resources=[...legacy.filter(f=>!represented.has(f.kind)),...explicit];materialized.push(...resources);
    const captures=resources.filter(f=>f.kind==='capture'&&completed(f.state));
    const refunds=resources.filter(f=>f.kind==='refund'&&completed(f.state));
    const pendingRefunds=resources.filter(f=>f.kind==='refund'&&['pending','processing'].includes(f.state));
    const captureIds=new Set(captures.map(f=>f.resourceId));
    if([...refunds,...pendingRefunds].some(f=>!captureIds.has(f.parentResourceId!)))throw new Error(`A refund for ${source.reference} has no visible completed capture at these cutoffs.`);
    const capturedMinor=sum(captures.map(f=>f.amountMinor!)),refundedMinor=sum(refunds.map(f=>f.amountMinor!));
    const committedRefundMinor=sum([...refunds,...pendingRefunds].map(f=>f.amountMinor!));
    for(const capture of captures)if(sum([...refunds,...pendingRefunds].filter(f=>f.parentResourceId===capture.resourceId).map(f=>f.amountMinor!))>capture.amountMinor!)throw new Error('Observed completed and pending refunds exceed their capture.');
    const shipments=resources.filter(f=>f.kind==='shipment'),lines=resources.filter(f=>f.kind==='line');
    const due=shipments.filter(fact=>['queued','shipped','in_transit','delayed','delivered','lost'].includes(fact.state)&&Date.parse(fact.promisedAt===undefined?source.promisedAt:fact.promisedAt??'')<=Date.parse(context.asOf));
    const fulfillmentState=!represented.has('shipment')?source.fulfillmentState:!shipments.length?'unknown':shipments.every(f=>f.state==='delivered')?'delivered':shipments.some(f=>f.state==='delayed')?'delayed':shipments.some(f=>['shipped','in_transit','delivered'].includes(f.state))?'in_transit':'unknown';
    const captureId=represented.has('capture')?(captures.length===1&&captures[0].sourceClass==='sandbox'?captures[0].resourceId:null):source.captureId;
    const order:SnapshotOrder={...source,captureId,capturedMinor,captureCount:captures.length,refundCount:refunds.length,lineCount:lines.length,shipmentCount:shipments.length,dueShipmentCount:due.length,lateShipmentCount:due.filter(fact=>fact.state!=='delivered').length,
      resourceCoverage:represented.size?'observed':'legacy',refundedMinor,
      // Resource analytics never grants a larger execution balance than the provider
      // admission already proved. Pending refunds continue to consume that balance.
      refundableMinor:Math.min(source.refundableMinor,Math.max(0,capturedMinor-Math.max(committedRefundMinor,source.providerRefundConsumedMinor??0))),
      paymentState:represented.has('capture')?(captures.length?'captured':'unknown'):source.paymentState,
      fulfillmentState,remediationState:refundedMinor>0?'refunded':pendingRefunds.length?'refund_pending':represented.has('refund')&&source.remediationState==='refunded'?'none':source.remediationState,
      affected:source.incidentMember&&['in_transit','delayed','shipped'].includes(fulfillmentState)&&source.lateHours>=0};
    return order;
  });
  return {orders:projected,facts:materialized};
}

function resourceTransitions(dataset:SeedDataset,context:QueryContext):TableRow[]{
  const corrected=new Map<string,CommerceFact>();
  const time=(fact:CommerceFact)=>context.clockDomain==='observed'?fact.occurredAt:fact.narrativeTime;
  for(const fact of dataset.commerceFacts??[]){
    if(fact.kind==='line'||fact.currency!==context.currency||Date.parse(time(fact))>Date.parse(context.asOf)||Date.parse(fact.ingestedAt)>Date.parse(context.knownAt))continue;
    const identity=key(fact)+':'+new Date(time(fact)).toISOString(),prior=corrected.get(identity);if(!prior||compare(prior,fact)<0)corrected.set(identity,fact);
  }
  const previous=new Map<string,CommerceFact>(),transferred=new Set<string>(),result:TableRow[]=[];
  for(const fact of [...corrected.values()].sort((a,b)=>Date.parse(time(a))-Date.parse(time(b))||compare(a,b))){
    const prior=previous.get(key(fact));previous.set(key(fact),fact);if(prior?.state===fact.state)continue;
    const firstCompleted=['capture','refund'].includes(fact.kind)&&completed(fact.state)&&!transferred.has(key(fact));
    if(firstCompleted)transferred.add(key(fact));
    result.push({id:'resource-transition:'+fact.id,orderId:fact.orderId,resourceId:fact.resourceId,grain:'resource_state_transition',dimension:fact.kind==='capture'?'payment':fact.kind==='refund'?'remediation':'fulfillment',fromState:prior?.state??'unknown',toState:fact.state,
      transitionTime:new Date(time(fact)).toISOString(),occurredAt:fact.occurredAt,narrativeTime:fact.narrativeTime,ingestedAt:fact.ingestedAt,sourceClass:fact.sourceClass,sourceLabel:fact.sourceRef,sourceEventId:fact.id,
      transitionCount:1,captureCount:fact.kind==='capture'&&firstCompleted?1:0,amountMinor:firstCompleted?fact.amountMinor??0:0,currency:fact.currency,snapshotHash:''});
  }
  return result;
}

/** Additive semantic version: legacy contexts and immutable editions retain their original bytes. */
export function withCommerceResources(base:Snapshot,dataset:SeedDataset):Snapshot{
  const {context}=base,{orders,facts}=projectResources(dataset,context,base.orders);
  const currentSemantics=context.semanticModelVersion===COMMERCE_SEMANTICS;
  const explicitIds=new Set((dataset.commerceFacts??[]).map(fact=>fact.id));
  const evidence:Evidence[]=[...base.evidence,...facts.filter(fact=>explicitIds.has(fact.id)).map(fact=>({id:'evidence-resource:'+fact.id,tenantId:context.tenantId,orderId:fact.orderId,kind:fact.kind==='shipment'?'shipment' as const:'payment' as const,title:`${fact.kind} ${fact.resourceId} · ${fact.state}`,excerpt:`${fact.kind} resource ${fact.resourceId}: ${fact.state}. ${fact.amountMinor===null?'No monetary measure.':fact.amountMinor+' '+fact.currency+' minor units.'}${fact.quantity===null?'':' Quantity '+fact.quantity+'.'}${fact.parentResourceId?' Parent '+(fact.kind==='refund'?'capture ':'line ')+fact.parentResourceId+'.':''} Source reference: ${fact.sourceRef}.`,sourceClass:fact.sourceClass,sourceLabel:fact.sourceClass+' resource observation',occurredAt:fact.occurredAt,ingestedAt:fact.ingestedAt,supports:[fact.id],contradicts:[]}))];
  const branches=evaluateBranches(orders,DEFAULT_BUDGET_MINOR,'');
  const evidenceIds=new Set(evidence.map(e=>e.id));
  for(const branch of branches){branch.currency=context.currency;for(const action of branch.actions){const missing=action.evidenceIds.some(id=>!evidenceIds.has(id));action.evidenceIds=action.evidenceIds.filter(id=>evidenceIds.has(id));if(missing){action.eligibility='blocked';action.blockedReason+=' Required evidence is unavailable at these cutoffs.';}}}
  const byId=new Map(orders.map(order=>[order.id,order]));
  const baselineContext={...context,asOf:new Date(Math.min(Date.parse(CARRIER_BASELINE_AT),Date.parse(context.asOf))).toISOString()};
  const baselineOrders=projectResources(dataset,baselineContext,projectOrders(dataset,baselineContext)).orders;
  const detectors=runDetectors(orders,baselineOrders,dataset.events,context);
  const tables:Snapshot['tables']={...base.tables,order_snapshot:base.tables.order_snapshot.map(row=>{
    const order=byId.get(String(row.id))!;
    return {...row,createdAt:order.createdAt,fulfillmentState:order.fulfillmentState,paymentState:order.paymentState,remediationState:order.remediationState,affected:order.affected,
      captureId:order.captureId,providerCaptureCount:facts.filter(fact=>fact.orderId===order.id&&fact.kind==='capture'&&completed(fact.state)&&fact.sourceClass==='sandbox').length,captureCount:order.captureCount!,capturedMinor:order.capturedMinor!,refundedMinor:order.refundedMinor,refundableMinor:order.refundableMinor,
      refundCount:order.refundCount!,shipmentCount:order.shipmentCount!,dueShipmentCount:order.dueShipmentCount!,lateShipmentCount:order.lateShipmentCount!,lineCount:order.lineCount!,resourceCoverage:order.resourceCoverage!};
  })};
  const extraEvidence=evidence.slice(base.evidence.length);
  const detectorById=new Map(detectors.map(detector=>[detector.id,detector]));
  tables.finding_snapshot=[...base.tables.finding_snapshot.map(row=>{const detector=detectorById.get(String(row.id));return detector?{...row,...detector,snapshotHash:''}:row;}),...extraEvidence.map(row=>({...row,grain:'evidence_record',supports:JSON.stringify(row.supports),contradicts:JSON.stringify(row.contradicts),untrusted:false,snapshotHash:''}))];
  const represented=new Set((dataset.commerceFacts??[]).filter(fact=>Date.parse(fact.ingestedAt)<=Date.parse(context.knownAt)).map(fact=>fact.orderId+':'+fact.kind));
  const replaced=(row:TableRow)=>row.dimension==='payment'&&represented.has(row.orderId+':capture')||row.dimension==='fulfillment'&&represented.has(row.orderId+':shipment')||row.dimension==='remediation'&&row.toState==='refunded'&&represented.has(row.orderId+':refund');
  const sourceById=new Map(dataset.events.map(event=>[event.id,event])),seenTransfers=new Set<string>();
  const uniqueTransitions=new Map<string,TableRow>();
  for(const row of base.tables.transition_snapshot.filter(row=>!replaced(row))){
    const event=sourceById.get(String(row.sourceEventId));
    const resource=event?.type==='payment.captured'?event.payload.captureId??event.payload.providerResourceId??event.sourceRef:event?.type==='remediation.refunded'?event.payload.refundId:undefined;
    const identity=resource?`${row.dimension}:${resource}`:String(row.id);
    if(seenTransfers.has(identity))continue;seenTransfers.add(identity);uniqueTransitions.set(String(row.id),row);
  }
  tables.transition_snapshot=[...uniqueTransitions.values(),...resourceTransitions(dataset,context).filter(row=>byId.has(String(row.orderId)))].sort((a,b)=>String(a.transitionTime).localeCompare(String(b.transitionTime))||String(a.id).localeCompare(String(b.id)));
  tables.action_snapshot=branches[0].actions.map(action=>({id:action.id,orderId:action.orderId,grain:'proposed_action',branchId:'targeted',policyId:branches[0].policyId,reference:action.reference,kind:action.kind,amountMinor:action.amountMinor,currency:action.currency,resourceId:action.resourceId,resourceVersion:action.resourceVersion,sourceClass:action.sourceClass,eligibility:action.eligibility,blockedReason:action.blockedReason,payload:JSON.stringify(action.payload),evidenceIds:JSON.stringify(action.evidenceIds),snapshotHash:''}));
  for(const kind of kinds)tables[`${kind}_snapshot`]=facts.filter(f=>f.kind===kind).map(f=>({id:`${kind}:${f.resourceId}`,orderId:f.orderId,grain:kind,resourceId:f.resourceId,parentResourceId:f.parentResourceId,
    state:f.state,amountMinor:f.amountMinor,currency:f.currency,quantity:f.quantity,occurredAt:f.occurredAt,narrativeTime:f.narrativeTime,ingestedAt:f.ingestedAt,revision:f.revision,sourceClass:f.sourceClass,sourceRef:f.sourceRef,
    promisedAt:f.kind==='shipment'?(f.promisedAt===undefined?byId.get(f.orderId)?.promisedAt??null:f.promisedAt):null,resourceCount:1,snapshotHash:''}));
  // A regional day is first represented at order grain. Cohort queries can then aggregate
  // numerators and denominators without borrowing totals from an unrelated snapshot.
  const days=[...new Set(base.tables.regional_snapshot.map(row=>String(row.day)))];
  const regional:TableRow[]=[];
  for(const day of days){const at=new Date(Math.min(Date.parse(day+'T00:00:00.000Z')+86_400_000-1,Date.parse(context.asOf))).toISOString();
    for(const order of projectResources(dataset,{...context,asOf:at},projectOrders(dataset,{...context,asOf:at})).orders){
      regional.push({id:`region-order:${day}:${order.id}`,orderId:order.id,grain:'region_order_day',region:order.region||'Unknown region',regionCode:order.regionCode||'UNKNOWN',day,inventoryAt:at,orderCount:1,
        eligibleShipmentCount:order.dueShipmentCount??0,lateCount:order.lateShipmentCount??0,snapshotHash:''});}}
  tables.regional_order_snapshot=regional;
  // V2 is an immutable reconstruction contract. V3 exposes one contribution per
  // baseline-visible order, independent of day, so a native ID cohort can scope
  // historical shipment numerators and denominators without repeated-day fanout.
  const baselineByRegion=new Map<string,{orderCount:number;numerator:number;denominator:number}>();
  if(currentSemantics){
    tables.regional_baseline_order_snapshot=baselineOrders.map(order=>{
      const regionCode=order.regionCode||'UNKNOWN',previous=baselineByRegion.get(regionCode)??{orderCount:0,numerator:0,denominator:0};
      const denominator=order.dueShipmentCount??0,numerator=order.lateShipmentCount??0;
      baselineByRegion.set(regionCode,{orderCount:previous.orderCount+1,numerator:previous.numerator+numerator,denominator:previous.denominator+denominator});
      return {id:'region-baseline:'+order.id,orderId:order.id,grain:'region_order_baseline',region:order.region||'Unknown region',regionCode,
        baselineAt:baselineContext.asOf,orderCount:1,eligibleShipmentCount:denominator,lateCount:numerator,snapshotHash:''};
    });
  }
  tables.regional_snapshot=[];
  for(const day of days)for(const code of [...new Set(regional.filter(r=>r.day===day).map(r=>String(r.regionCode)))].sort()){
    const rows=regional.filter(r=>r.day===day&&r.regionCode===code),denominator=sum(rows.map(r=>Number(r.eligibleShipmentCount))),numerator=sum(rows.map(r=>Number(r.lateCount)));
    const baseline=baselineByRegion.get(code);
    tables.regional_snapshot.push({id:`region:${code}:${day}`,grain:'region_day_inventory',region:rows[0].region,regionCode:code,day,inventoryAt:rows[0].inventoryAt,orderCount:rows.length,eligibleShipmentCount:denominator,lateCount:numerator,lateShare:denominator?numerator/denominator:null,
      ...currentSemantics?{baselineAt:baselineContext.asOf,baselineOrderCount:baseline?.orderCount??0,baselineNumerator:baseline?.numerator??0,baselineDenominator:baseline?.denominator??0,baselineShare:baseline?.denominator?baseline.numerator/baseline.denominator:null}:{},snapshotHash:''});
  }
  tables.deadline_snapshot=orders.filter(order=>order.disputeState&&!['none','unknown'].includes(order.disputeState)).map(order=>{
    const closed=['resolved','closed','cancelled'].includes(order.disputeState!),verified=order.disputeSource==='sandbox'&&order.disputeDueAt!==null&&Number.isFinite(Date.parse(order.disputeDueAt));
    return {id:'deadline:'+order.id,orderId:order.id,grain:'dispute_case',reference:order.reference,disputeId:order.disputeId,state:order.disputeState!,sourceClass:order.disputeSource,dueAt:verified?order.disputeDueAt:null,dueDateVerified:verified,owner:closed?'none':order.disputeState==='waiting_for_buyer_response'?'buyer':order.disputeState==='under_review'?'provider':currentSemantics&&order.disputeState==='waiting_for_seller_response'?'merchant':verified?'merchant':'unknown',clockDomain:verified?'observed':'unknown',deadlineCount:1,snapshotHash:''};
  });
  const affectedOrderIds=orders.filter(o=>o.affected).map(o=>o.id),removedOrderIds=orders.filter(o=>o.incidentMember&&o.fulfillmentState==='delivered').map(o=>o.id);
  const totals={...base.totals,captures:sum(orders.map(o=>o.captureCount!)),capturedMinor:sum(orders.map(o=>o.capturedMinor!)),refundMinor:sum(orders.map(o=>o.refundedMinor)),affected:affectedOrderIds.length,delivered:orders.filter(o=>o.fulfillmentState==='delivered').length,inTransit:orders.filter(o=>['in_transit','delayed','shipped'].includes(o.fulfillmentState)).length};
  const tableHashes=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,stableHash(withoutSnapshotHashes(rows))]));
  const sourceCoverage={...base.sourceCoverage,samplePayments:facts.filter(fact=>fact.kind==='capture'&&completed(fact.state)&&fact.sourceClass==='sample').length,sandboxPayments:facts.filter(fact=>fact.kind==='capture'&&completed(fact.state)&&fact.sourceClass==='sandbox').length,fixtureShipments:facts.filter(fact=>fact.kind==='shipment'&&fact.sourceClass==='fixture_shipping').length,
    complete:base.sourceCoverage.complete&&orders.every(order=>order.captureCount!>0&&order.fulfillmentState!=='unknown')&&facts.filter(fact=>fact.kind==='capture'&&completed(fact.state)).every(fact=>fact.sourceClass==='sandbox')};
  const content={...base,orders,branches,tables,tableHashes,evidence,detectors,affectedOrderIds,removedOrderIds,totals,sourceCoverage};
  const hash=stableHash(withoutSnapshotHashes({context,tables,tableHashes,orders,evidence,affectedOrderIds,removedOrderIds,branches,detectors,totals,sourceCoverage}));
  for(const order of orders)order.snapshotHash=hash;for(const branch of branches)branch.snapshotHash=hash;for(const rows of Object.values(tables))for(const row of rows)row.snapshotHash=hash;
  return {...content,id:`snapshot-${hash.slice(0,28)}`,hash};
}
