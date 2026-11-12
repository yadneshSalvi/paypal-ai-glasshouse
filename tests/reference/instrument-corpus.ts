import type {CommerceFact,Currency,Evidence,Order,SeedDataset,SourceEvent} from '../../packages/domain/types';
import {appendStateObservation} from '../../packages/domain/seed';

/** A hand-authored ledger, deliberately unrelated to Fernwood's 600-order fixture.
 * All identifiers and provider-shaped states here are fictional test data. */
export const times={start:'2026-11-02T00:00:00.000Z',one:'2026-11-03T00:00:00.000Z',two:'2026-11-04T00:00:00.000Z',three:'2026-11-05T00:00:00.000Z',four:'2026-11-06T00:00:00.000Z',end:'2026-11-06T10:00:00.000Z',late:'2026-11-07T00:00:00.000Z',known:'2026-11-08T00:00:00.000Z',now:'2026-11-12T12:00:00.000Z'};
export const plus=(iso:string,minutes:number)=>new Date(Date.parse(iso)+minutes*60_000).toISOString();
export function instrumentCorpus(tenantId='instrument-reference'):SeedDataset{
 const dataset:SeedDataset={version:'independent-resource-corpus-v1',tenantId,revision:8,orders:[],events:[],intervals:[],evidence:[],commerceFacts:[]};
 const specs:[string,Currency,number,string,string,string][]=[['a','USD',10000,'PNW','Pacific Northwest',times.one],['b','USD',5000,'PNW','Pacific Northwest',times.three],['c','USD',1000,'','',times.one],['d','USD',1000,'PNW','Pacific Northwest',times.one],['e','EUR',900,'NE','Northeast',times.one],['f','GBP',700,'MW','Midwest',times.one],['g','USD',800,'','', ''],['h','USD',1000,'SW','Southwest',times.one]];
 for(const [id,currency,amountMinor,regionCode,region,promisedAt] of specs){
  const order:Order={id,tenantId,reference:'REF-'+id.toUpperCase(),customerAlias:'Fictional '+id,product:'Synthetic multipart order',regionCode,region,amountMinor,currency,createdAt:plus(times.start,60),narrativeCreatedAt:times.start,promisedAt,captureId:null,paypalOrderId:null,providerOccurredAt:null,paymentSource:'sample',refundableMinor:amountMinor,refundedMinor:0,goodwillCreditMinor:0,shipmentRef:'legacy:'+id,carrier:'Synthetic carrier',trackingNumber:'SAMPLE-'+id,trackingInPayPal:false,disputeId:null,disputeOpen:false,disputeSource:'sample',disputeDueAt:null,disputeState:'none',incidentMember:true,seedGroup:'eligible',resourceVersion:1,costMinor:100,supportContacts:0};
  dataset.orders.push(order);
  source(id,'order.created','payment','pending',times.start,plus(times.start,61));
  source(id,'payment.captured','payment','captured',plus(times.start,1),plus(times.start,62),{amountMinor,currency});
  source(id,'fulfillment.queued','fulfillment','queued',times.start,plus(times.start,61));
  source(id,'remediation.none','remediation','none',times.start,plus(times.start,61));
  source(id,'dispute.none','dispute','none',times.start,plus(times.start,61));
  fact(id,'line','line-'+id,'ordered',amountMinor,times.start,plus(times.start,62),{quantity:1});
  const pieces=id==='a'?[4000,6000]:id==='e'?[300,600]:[amountMinor];
  for(let index=0;index<pieces.length;index++){
   const resourceId='cap-'+id+'-'+index;
   fact(id,'capture',resourceId,'pending',pieces[index],times.start,plus(times.start,62));
   if(id!=='f')fact(id,'capture',resourceId,'completed',pieces[index],index===0?times.one:times.two,plus(index===0?times.one:times.two,61));
  }
  fact(id,'shipment','ship-'+id+'-0',id==='c'?'unknown':id==='g'?'queued':id==='d'?'delivered':'delayed',null,times.one,plus(times.one,61),{parentResourceId:'sample:line-'+id});
 }
 // Two lines and two shipments share one order; joining them may not multiply captures.
 dataset.commerceFacts!.find(row=>row.kind==='line'&&row.orderId==='a')!.amountMinor=3500;
 fact('a','line','line-a-2','ordered',6500,times.start,plus(times.start,62),{quantity:2});
 fact('a','shipment','ship-a-1','in_transit',null,times.one,plus(times.one,61),{parentResourceId:'sample:line-a-2'});
 fact('a','shipment','ship-a-0','delivered',null,times.three,plus(times.three,61),{parentResourceId:'sample:line-a'});
 // Re-delivery of an identical event and a distinct webhook for one resource are not new money.
 const original=dataset.commerceFacts!.find(row=>row.resourceId==='sample:cap-a-0'&&row.state==='completed')!;
 dataset.commerceFacts!.push(structuredClone(original));
 dataset.commerceFacts!.push({...original,id:original.id+':duplicate-transport',ingestedAt:plus(original.ingestedAt,2),revision:3});
 // A stale pending observation arrives after completion and must not regress current state.
 fact('a','capture','cap-a-0','pending',4000,times.start,times.late,{revision:8,id:'sample:stale-pending-a'});
 // Backdated refund is invisible until K reaches its original ingestion.
 fact('a','refund','refund-a-0','completed',700,times.two,times.late,{parentResourceId:'sample:cap-a-0',revision:7});
 fact('a','refund','refund-a-1','completed',300,times.three,plus(times.three,61),{parentResourceId:'sample:cap-a-1',revision:5});
 fact('a','refund','refund-a-pending','pending',200,times.four,plus(times.four,61),{parentResourceId:'sample:cap-a-1',revision:6});
 // A false earlier delivery is corrected at the same valid time, then a later observation wins.
 fact('a','shipment','ship-a-0','in_transit',null,times.three,times.late,{parentResourceId:'sample:line-a',revision:7,id:'sample:delivery-correction-a'});
 fact('a','shipment','ship-a-0','delivered',null,times.four,times.known,{parentResourceId:'sample:line-a',revision:8,id:'sample:later-delivery-a'});
 source('c','dispute.open','dispute','open',times.two,plus(times.two,61),{simulated:true});
 source('d','dispute.observed','dispute','waiting_for_seller_response',times.two,plus(times.two,61),{disputeId:'FICTIONAL-CASE-D',sellerResponseDueAt:'2026-11-13T12:00:00.000Z',receiptHash:'synthetic-only'},'sandbox');
 source('h','support.message','fulfillment','delayed',times.three,plus(times.three,61),{contactCount:2,text:'Synthetic complaint'} ,'fixture_support');
 dataset.evidence.push({id:'reference-counter-evidence',tenantId,orderId:'a',kind:'contradiction',title:'Corrected source statement',excerpt:'A deliberately contradictory synthetic source.',sourceClass:'sample',sourceLabel:'Independent corpus',occurredAt:times.three,ingestedAt:times.late,supports:[],contradicts:['reference-source-a']});
 dataset.evidence.push({id:'reference-source-a',tenantId,orderId:'a',kind:'shipment',title:'Original shipment statement',excerpt:'Synthetic order a remains partly delayed.',sourceClass:'fixture_shipping',sourceLabel:'Independent corpus',occurredAt:times.one,ingestedAt:plus(times.one,61),supports:['sample:ship-a-1'],contradicts:[]});
 return dataset;
 function source(orderId:string,type:string,dimension:SourceEvent['dimension'],state:string,at:string,knownAt:string,payload:Record<string,unknown>={},sourceClass:SourceEvent['sourceClass']='sample'){
  const event:SourceEvent={id:`event:${orderId}:${type}`,tenantId,orderId,type,dimension,state,occurredAt:plus(at,60),narrativeTime:at,ingestedAt:knownAt,sourceClass,sourceLabel:'Fictional independent test source',sourceRef:'fixture://independent/'+orderId+'/'+type,payload,revision:type==='dispute.observed'||type==='dispute.open'?3:1};
  dataset.events.push(event);appendStateObservation(dataset.intervals,event);
 }
 function fact(orderId:string,kind:CommerceFact['kind'],resource:string,state:string,amountMinor:number|null,at:string,knownAt:string,extra:Partial<CommerceFact>={}){
  const row:CommerceFact={id:`sample:obs:${kind}:${resource}:${at}`,tenantId,orderId,kind,resourceId:'sample:'+resource,parentResourceId:null,state,amountMinor,currency:dataset.orders.find(row=>row.id===orderId)!.currency,quantity:null,occurredAt:plus(at,60),narrativeTime:at,ingestedAt:knownAt,revision:2,sourceClass:'sample',sourceRef:'fixture://independent/resources/'+resource,...extra};dataset.commerceFacts!.push(row);
 }
}
