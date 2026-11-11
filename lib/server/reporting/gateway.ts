import type {PaypalClient,PaypalError,SearchError} from 'paypal';
import {fromProviderMoney} from '@fracture/paypal-core';
import {digest} from '@/packages/payments/security';
import type {ReportingEntry,ReportingPage} from '@/packages/reporting/types';
import {HttpError} from '../errors';
export interface ReportingGrant {id:string;kind:'capture'|'refund';orderId:string;version:number}
export interface ReportingReader {read(start:string,end:string,page:number,grants:ReportingGrant[],signal:AbortSignal):Promise<ReportingPage>}
const fail=()=>new HttpError(502,'REPORTING_SHAPE_UNCERTAIN','The report did not contain consistent page, amount and timestamp evidence. Its cursor was not advanced.');
const instant=(value:unknown)=>typeof value==='string'&&value.length<=64&&/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)&&Number.isFinite(Date.parse(value));
function refusal(status:number,reason?:SearchError):HttpError {
 if(status===401||status===403)return new HttpError(503,'REPORTING_ACCESS_UNAVAILABLE','The merchant reporting connection is unavailable.');
 if(status===429)return new HttpError(503,'REPORTING_RATE_LIMIT','PayPal reporting is temporarily rate limited. The saved page will be read later.');
 if(status>=400&&status<500){const message=reason?.message.replace(/https?:\/\/\S+/g,'[provider link]').replace(/[\u0000-\u001f]/g,' ').slice(0,300);
 return new HttpError(status,reason?.name==='RESULTSET_TOO_LARGE'?'REPORTING_WINDOW_TOO_LARGE':'REPORTING_REQUEST_REFUSED',message??'PayPal refused this reporting window. Review its dates.');}
 return new HttpError(502,'REPORTING_UNAVAILABLE','PayPal reporting could not complete this page. Prior evidence is retained.');
}
/** One checkpointed GET. The page contains only current, independently owned resources. */
export class ReportingGateway implements ReportingReader {
 constructor(readonly client:PaypalClient){}
 async read(start:string,end:string,page:number,grants:ReportingGrant[],signal:AbortSignal):Promise<ReportingPage>{
  if(!instant(start)||!instant(end)||Date.parse(end)<=Date.parse(start)||Date.parse(end)-Date.parse(start)>31*86400000||!Number.isSafeInteger(page)||page<1||page>100)throw new HttpError(400,'REPORTING_WINDOW_INVALID','Choose an ordered reporting window of at most 31 days and a bounded page.');
  try {
   const result=await this.client.transactionSearch.searchTransactions({startDate:start,endDate:end,fields:'transaction_info',balanceAffectingRecordsOnly:'Y',pageSize:100,page},
    {signal:AbortSignal.any([signal,AbortSignal.timeout(25000)]),retry:{maxRetries:0}}).asApiResult();
   if(!result.ok)throw refusal(result.status,result.payload.kind==='searchError'?result.payload.body:undefined);
   const value=result.value,empty=value.totalItems===0&&value.totalPages===0&&page===1;
   const details=value.transactionDetails??(empty?[]:null);
   if(!details||details.length>100||value.page!==undefined&&value.page!==page||!Number.isSafeInteger(value.totalPages)||value.totalPages!<0||!Number.isSafeInteger(value.totalItems)||value.totalItems!<0||
     !empty&&(value.totalPages!<page||value.totalItems!<details.length)||empty&&details.length>0)throw fail();
   if(value.totalPages!>100)throw new HttpError(409,'REPORTING_WINDOW_TOO_LARGE','This window exceeds the product page bound. Start a narrower window; no complete coverage is claimed.');
   if(value.lastRefreshedDatetime!==undefined&&!instant(value.lastRefreshedDatetime))throw fail();
   const allowed=new Map(grants.map(g=>[g.id,g])),entries:ReportingEntry[]=[];
   for(const detail of details){const info=detail.transactionInfo,grant=info?.transactionId?allowed.get(info.transactionId):undefined;if(!info||!grant)continue;
    if(!info.transactionAmount||!instant(info.transactionInitiationDate)||!instant(info.transactionUpdatedDate)||!info.transactionStatus||!/^[A-Z0-9_]{1,32}$/.test(info.transactionStatus))throw fail();
    const negative=info.transactionAmount.value.startsWith('-');let amount:ReturnType<typeof fromProviderMoney>;try{amount=fromProviderMoney({...info.transactionAmount,value:info.transactionAmount.value.replace(/^-/,'')});}catch{throw fail();}
    entries.push({transactionId:grant.id,kind:grant.kind,orderId:grant.orderId,status:info.transactionStatus,amountMinor:negative?-amount.minor:amount.minor,currency:amount.currency,
     occurredAt:new Date(info.transactionInitiationDate!).toISOString(),updatedAt:new Date(info.transactionUpdatedDate!).toISOString()});
   }
   const safe={page,totalPages:value.totalPages!,totalItems:value.totalItems!,returned:details.length,excluded:details.length-entries.length,
    refreshedAt:value.lastRefreshedDatetime?new Date(value.lastRefreshedDatetime).toISOString():null,entries};
   return {...safe,observedAt:new Date().toISOString(),bodyHash:digest(safe)};
  }catch(error){if(error instanceof HttpError)throw error;
   if(error&&typeof error==='object'&&'kind' in error&&'uri' in error){const e=error as PaypalError;
    if(e.kind==='api'||e.kind==='decode')throw refusal(e.status);
    throw new HttpError(502,'REPORTING_UNAVAILABLE','The provider read was interrupted. No empty result or completed coverage was inferred.');}
   throw error;
  }
 }
}
