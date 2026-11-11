import { ShipmentCarrier, type PaypalClient } from 'paypal';
import { fromProviderMoney, ProviderError } from '@fracture/paypal-core';
import { digest } from '@/packages/payments/security';
import type { OrderEvidenceGateway, OwnedOrderEvidence } from '../payments/evidence';
import type { OneWriteTransport } from '../payments/transport';
import type { OwnedPayment } from './authority';

export interface RefundObservation {
  id:string;captureId:string;orderId:string;customId:string|null;status:string;amountMinor:number;currency:'USD';
  occurredAt:string;observedAt:string;bodyHash:string;debugId:string|null;
}
export interface CaptureCapacity {
  captureId:string;orderId:string;status:string;currency:'USD';totalMinor:number;consumedMinor:number;
  refundIds:string[];refunds:RefundObservation[];observedAt:string;bodyHash:string;
}
export interface TrackingCommand {
  operationId:string;orderId:string;captureId:string;trackingNumber:string;carrierName:string;notifyPayer:false;
}
export interface TrackingObservation {
  id:string;orderId:string;captureId:string;status:string;trackingNumber:string;carrierName:string;fixtureShipping:true;
  fieldVerification:'approved_request_and_returned_identity';occurredAt:string|null;observedAt:string;bodyHash:string;
}
type ApiResult<T>={ok:true;value:T;status:number;headers:Headers}|{ok:false;status:number;headers:Headers;payload:unknown};
const mismatch=(reason='The independent provider evidence did not match the original owned payment.')=>new ProviderError('decode',reason,'unknown',409);
const debug=(headers:Headers)=>{const id=headers.get('paypal-debug-id');return id&&/^[A-Za-z0-9_-]{1,128}$/.test(id)?id:null;};

export class RecoveryEvidenceGateway {
  constructor(private readonly client:PaypalClient,private readonly orders:Pick<OrderEvidenceGateway,'order'>,private readonly transport:OneWriteTransport){}
  private async read<T>(work:()=>Promise<ApiResult<T>>):Promise<{value:T;status:number;headers:Headers}>{
    const result=await work();
    if(!result.ok)throw new ProviderError('api','A current independent PayPal read did not confirm this resource.','unknown',result.status,debug(result.headers));
    return result;
  }
  private async bounded<T>(work:(signal:AbortSignal)=>Promise<T>,caller?:AbortSignal):Promise<T>{
    const deadline=AbortSignal.timeout(25_000),signal=caller?AbortSignal.any([caller,deadline]):deadline;
    try{return await work(signal);}catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError(signal.aborted?'timeout':'connection','The original provider operation requires independent reconciliation.','unknown',502);}
  }
  private async order(owned:OwnedPayment,signal:AbortSignal):Promise<OwnedOrderEvidence>{
    const order=await this.orders.order(owned.providerOrderId,owned.entry,owned.customId,signal);
    if(order.captureIds.length!==1||order.captureIds[0]!==owned.captureId)throw mismatch('The original single-capture payment set changed.');
    return order;
  }
  private async refundRead(id:string,owned:OwnedPayment,signal:AbortSignal):Promise<RefundObservation>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw mismatch();
    const result=await this.read(()=>this.client.payments.getRefund({refundId:id},{signal}).asApiResult());
    const value=result.value;
    if(value.id!==id||!value.amount||!value.status||!['COMPLETED','PENDING','FAILED','CANCELLED'].includes(value.status)||!value.createTime||!Number.isFinite(Date.parse(value.createTime)))throw mismatch('The refund state or amount is incomplete.');
    const money=fromProviderMoney(value.amount);
    if(money.currency!=='USD'||money.minor<=0||money.minor>owned.entry.amountMinor)throw mismatch();
    for(const link of value.links??[])if(link.rel==='up'){
      let url:URL;try{url=new URL(link.href);}catch{throw mismatch();}
      // PayPal returns its legacy sandbox host in parent metadata. Never follow it:
      // both accepted hosts still require the exact original capture and a GET link.
      if(!['https://api-m.sandbox.paypal.com','https://api.sandbox.paypal.com'].includes(url.origin)||url.username||url.password||link.method!=='GET'||
        url.pathname!==`/v2/payments/captures/${owned.captureId}`||url.search||url.hash)throw mismatch('The refund names a different owning capture.');
    }
    const facts={id,captureId:owned.captureId,orderId:owned.providerOrderId,customId:value.customId??null,status:value.status,amountMinor:money.minor,currency:'USD' as const,occurredAt:new Date(value.createTime).toISOString()};
    return {...facts,observedAt:new Date().toISOString(),bodyHash:digest(facts),debugId:debug(result.headers)};
  }
  async capacity(owned:OwnedPayment,caller?:AbortSignal):Promise<CaptureCapacity>{
    return this.bounded(async signal=>{
      const order=await this.order(owned,signal);
      if(order.refundIds.length>100)throw mismatch('The complete refund inventory exceeded its bounded read.');
      const result=await this.read(()=>this.client.payments.getCapturedPayment({captureId:owned.captureId},{signal}).asApiResult());
      const value=result.value;
      if(value.id!==owned.captureId||!value.amount||!value.status||!['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'].includes(value.status)||value.supplementaryData?.relatedIds?.orderId&&value.supplementaryData.relatedIds.orderId!==owned.providerOrderId)throw mismatch();
      const money=fromProviderMoney(value.amount);
      if(money.currency!=='USD'||money.minor!==owned.entry.amountMinor)throw mismatch();
      const refunds:RefundObservation[]=[];
      for(let offset=0;offset<order.refundIds.length;offset+=4){
        const settled=await Promise.allSettled(order.refundIds.slice(offset,offset+4).map(id=>this.refundRead(id,owned,signal)));
        const errors=settled.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
        if(errors.length)throw errors[0].reason;
        refunds.push(...settled.filter((result):result is PromiseFulfilledResult<RefundObservation>=>result.status==='fulfilled').map(result=>result.value));
      }
      const consumedMinor=refunds.filter(refund=>['COMPLETED','PENDING'].includes(refund.status)).reduce((sum,refund)=>sum+refund.amountMinor,0);
      if(consumedMinor>money.minor||value.status==='PARTIALLY_REFUNDED'&&consumedMinor===0||value.status==='REFUNDED'&&consumedMinor!==money.minor)throw mismatch('The capture status and complete observed refund set disagree.');
      const facts={captureId:owned.captureId,orderId:owned.providerOrderId,status:value.status,currency:'USD' as const,totalMinor:money.minor,consumedMinor,refundIds:refunds.map(refund=>refund.id),refunds};
      return {...facts,observedAt:new Date().toISOString(),bodyHash:digest({...facts,refunds:refunds.map(({observedAt,debugId,...facts})=>facts)})};
    },caller);
  }
  async refund(id:string,owned:OwnedPayment,operationId:string,amountMinor:number,caller?:AbortSignal):Promise<RefundObservation>{
    return this.bounded(async signal=>{
      const order=await this.order(owned,signal);
      if(!order.refundIds.includes(id))throw mismatch('The original refund is not yet present on its owning order.');
      const refund=await this.refundRead(id,owned,signal);
      if(refund.customId!==operationId||refund.amountMinor!==amountMinor)throw mismatch('The refund does not match the original approved command.');
      return refund;
    },caller);
  }
  async tracking(owned:OwnedPayment,command:TrackingCommand,trackerId:string,caller?:AbortSignal):Promise<TrackingObservation>{
    return this.bounded(async signal=>{
      this.assertTracking(owned,command);
      const order=await this.order(owned,signal);
      const tracker=order.trackers.find(tracker=>tracker.id===trackerId);
      if(!tracker||tracker.status!=='SHIPPED')throw mismatch('The original tracking assignment was not independently confirmed.');
      const facts={id:tracker.id,orderId:owned.providerOrderId,captureId:owned.captureId,status:tracker.status,
        trackingNumber:command.trackingNumber,carrierName:command.carrierName,fixtureShipping:true as const,
        fieldVerification:'approved_request_and_returned_identity' as const,occurredAt:tracker.createdAt};
      return {...facts,observedAt:new Date().toISOString(),bodyHash:digest(facts)};
    },caller);
  }
  private assertTracking(owned:OwnedPayment,command:TrackingCommand){
    if(command.orderId!==owned.providerOrderId||command.captureId!==owned.captureId||command.notifyPayer!==false||!/^SYNTHETIC-[A-Za-z0-9_-]{1,240}$/.test(command.trackingNumber)||
      !command.carrierName||command.carrierName.length>255||/[\u0000-\u001f\u007f]/.test(command.carrierName))throw new ProviderError('encode','Only the exact approved labelled fixture shipment may be assigned.','not_sent',409);
  }
  async addTracking(owned:OwnedPayment,command:TrackingCommand,authorize:()=>Promise<void>,caller?:AbortSignal):Promise<{trackerId:string;receipt:{status:number;debugId:string|null;observedAt:string;bodyHash:string}}>{
    this.assertTracking(owned,command);
    return this.bounded(async signal=>{
      const before=await this.order(owned,signal);
      if(before.trackers.length)throw new ProviderError('encode','This order already contains a tracking assignment; review the original resource before another write.','not_sent',409);
      signal.throwIfAborted();
      const result=await this.transport.run(command.operationId,`/v2/checkout/orders/${owned.providerOrderId}/track`,()=>this.client.orders.createOrderTracking({
        id:owned.providerOrderId,body:{captureId:owned.captureId,trackingNumber:command.trackingNumber,carrier:ShipmentCarrier.Other,carrierNameOther:command.carrierName,notifyPayer:false},
      },{signal}).asApiResult(),async()=>{try{await authorize();}catch{throw new ProviderError('encode','Current application authority did not permit the original tracking write.','not_sent',403);}});
      if(!result.ok)throw new ProviderError('api','PayPal did not confirm the tracking assignment.',result.status>=400&&result.status<500&&![408,429].includes(result.status)?'rejected':'unknown',result.status,debug(result.headers));
      const unit=result.value.purchaseUnits?.length===1?result.value.purchaseUnits[0]:null;
      const trackers=unit?.shipping?.trackers;
      if(result.value.id!==owned.providerOrderId||unit?.customId!==owned.customId||!trackers||trackers.length!==1||typeof trackers[0].id!=='string'||!/^[A-Za-z0-9_-]{1,255}$/.test(trackers[0].id))throw mismatch('The accepted tracking response did not identify the original assignment.');
      return {trackerId:trackers[0].id,receipt:{status:result.status,debugId:debug(result.headers),observedAt:new Date().toISOString(),bodyHash:digest({orderId:owned.providerOrderId,trackerId:trackers[0].id,command})}};
    },caller);
  }
}
