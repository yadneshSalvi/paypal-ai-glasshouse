import type { Evidence, QueryContext, SeedDataset, Snapshot, SnapshotOrder, SourceEvent } from './types';

export type OrderTimelineEvent=Pick<SourceEvent,'id'|'type'|'dimension'|'state'|'occurredAt'|'ingestedAt'|'narrativeTime'|'sourceClass'|'sourceLabel'|'sourceRef'>;
export interface ProviderReceiptView {
  sourceEventId:string;kind:'capture'|'refund'|'tracking'|'dispute';id:string;status:string;
  observedAt:string;occurredAt:string|null;bodyHash:string;
  amountMinor:number|null;currency:string|null;captureId:string|null;providerOrderId:string|null;
  trackingNumber:string|null;carrierName:string|null;fixtureShipping:boolean;
  fieldVerification:string|null;sellerResponseDueAt:string|null;submittedEvidence:number;
}
export interface StoredProviderObservation {
  tenantId:string;orderId:string;resourceId:string;kind:string;bodyHash:string;observedAt:string;body:Record<string,unknown>;
}
export interface OrderDetail {
  snapshotHash:string;context:QueryContext;order:SnapshotOrder;evidence:Evidence[];events:OrderTimelineEvent[];
  providerReceipts:ProviderReceiptView[];providerStatus:string;
}
const text=(value:unknown,max=512)=>typeof value==='string'&&value.length<=max?value:null;
const time=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const eventTime=(event:SourceEvent,context:QueryContext)=>context.clockDomain==='observed'?event.occurredAt:event.narrativeTime;
const visible=(event:SourceEvent,context:QueryContext)=>event.tenantId===context.tenantId&&Date.parse(event.ingestedAt)<=Date.parse(context.knownAt)&&Date.parse(eventTime(event,context))<=Date.parse(context.asOf);

/** Only an already-authorized immutable snapshot can select an order or provider receipt. */
export function buildOrderDetail(dataset:SeedDataset,snapshot:Snapshot,orderId:string,observations:readonly StoredProviderObservation[]=[]):OrderDetail|null {
  if(dataset.tenantId!==snapshot.context.tenantId)throw new Error('The detail dataset does not belong to the snapshot.');
  const order=snapshot.orders.find(order=>order.id===orderId&&order.tenantId===snapshot.context.tenantId);
  if(!order)return null;
  const sources=dataset.events.filter(event=>event.orderId===orderId&&visible(event,snapshot.context))
    .sort((a,b)=>eventTime(a,snapshot.context).localeCompare(eventTime(b,snapshot.context))||a.ingestedAt.localeCompare(b.ingestedAt)||a.id.localeCompare(b.id));
  const sourceById=new Map(dataset.events.map(event=>[event.id,event]));
  const visibleIds=new Set(sources.map(event=>event.id));
  const evidence=snapshot.evidence.filter(row=>row.orderId===orderId&&row.tenantId===snapshot.context.tenantId&&
    row.supports.every(id=>!sourceById.has(id)||visibleIds.has(id))&&
    (row.sourceClass!=='sandbox'||row.supports.some(id=>visibleIds.has(id))));
  const providerReceipts:ProviderReceiptView[]=[];
  for(const event of sources.filter(event=>event.sourceClass==='sandbox'&&typeof event.payload.receiptHash==='string')){
    const resourceId=text(event.payload.providerResourceId)??text(event.payload.disputeId)??text(event.payload.captureId);
    const observation=observations.find(row=>row.tenantId===snapshot.context.tenantId&&row.orderId===orderId&&row.resourceId===resourceId&&
      row.bodyHash===event.payload.receiptHash&&Date.parse(row.observedAt)<=Date.parse(snapshot.context.knownAt));
    if(!observation||!['capture','refund','tracking','dispute'].includes(observation.kind)||observation.body.id!==resourceId||observation.body.bodyHash!==observation.bodyHash)continue;
    const body=observation.body,status=text(body.status,64),observedAt=time(observation.observedAt);
    if(!status||!observedAt||!resourceId)continue;
    const captureId=observation.kind==='capture'?resourceId:text(body.captureId,128);
    if(captureId!==order.captureId||observation.kind==='dispute'&&resourceId!==order.disputeId||
      observation.kind!=='dispute'&&body.orderId!==order.paypalOrderId)continue;
    const submitted=Array.isArray(body.evidence)?body.evidence.filter(value=>value&&typeof value==='object'&&(value as Record<string,unknown>).source==='SUBMITTED_BY_SELLER').length:0;
    providerReceipts.push({sourceEventId:event.id,kind:observation.kind as ProviderReceiptView['kind'],id:resourceId,status,observedAt,
      occurredAt:time(body.occurredAt)??time(body.updatedAt),bodyHash:observation.bodyHash,
      amountMinor:Number.isSafeInteger(body.amountMinor)&&Number(body.amountMinor)>=0?Number(body.amountMinor):null,currency:text(body.currency,3),
      captureId,providerOrderId:order.paypalOrderId,trackingNumber:text(body.trackingNumber),carrierName:text(body.carrierName),
      fixtureShipping:body.fixtureShipping===true,fieldVerification:text(body.fieldVerification),sellerResponseDueAt:time(body.sellerResponseDueAt),submittedEvidence:submitted});
  }
  return {snapshotHash:snapshot.hash,context:snapshot.context,order,evidence,
    events:sources.map(({id,type,dimension,state,occurredAt,ingestedAt,narrativeTime,sourceClass,sourceLabel,sourceRef})=>({id,type,dimension,state,occurredAt,ingestedAt,narrativeTime,sourceClass,sourceLabel,sourceRef})),
    providerReceipts,providerStatus:order.paymentSource==='sandbox'&&providerReceipts.some(receipt=>receipt.kind==='capture')?'Independently verified sandbox receipts':
      order.paymentSource==='sandbox'?'The admitted source observation is visible; its stored receipt is unavailable.':'Sample payment at this evidence cutoff'};
}
