import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import type {AxiosStatic,AxiosAdapter,InternalAxiosRequestConfig} from 'axios';
import type {PayPalAgentToolkit as NativeToolkit} from '@paypal/agent-toolkit/openai';
import type {OwnedPayment} from '../recovery/authority';
import {hash} from '../repository';
import {HttpError} from '../errors';

const requireNative=createRequire(import.meta.url);
// Both are public package entry points. Requiring the same CJS Axios instance used
// by the installed Toolkit is necessary; its ESM build has a different singleton.
const axios=requireNative('axios') as AxiosStatic;
const {PayPalAgentToolkit}=requireNative('@paypal/agent-toolkit/openai') as {PayPalAgentToolkit:typeof NativeToolkit};
const ORIGIN='https://api.sandbox.paypal.com';
type NativeRead='get_order'|'list_disputes'|'get_dispute'|'list_transactions';
interface WireRead {status:number;body:unknown;hash:string;observedAt:string;start:string|null;end:string|null;debugId:string|null}
interface Context {
  name:NativeRead;owned:OwnedPayment;disputeId?:string;fetch:typeof fetch;beforeSend():Promise<void>;
  reads:WireRead[];requests:number;failed:boolean;deadline:AbortSignal;
}
const calls=new AsyncLocalStorage<Context>();
const mismatch=()=>new HttpError(409,'TOOLKIT_EVIDENCE_UNVERIFIED','The Toolkit response did not establish the exact owned resource.');
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw mismatch();return value as Record<string,unknown>;};
const list=(value:unknown,max=100):unknown[]=>{if(!Array.isArray(value)||value.length>max)throw mismatch();return value;};
const code=(value:unknown):string=>{if(typeof value!=='string'||!/^[A-Z][A-Z0-9_]{0,99}$/.test(value))throw mismatch();return value;};
const id=(value:unknown):string=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,150}$/.test(value))throw mismatch();return value;};
const date=(value:unknown):string|null=>typeof value==='string'&&/T/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function money(value:unknown){const obj=object(value);if(obj.currency_code!=='USD'||typeof obj.value!=='string'||!/^\d{1,10}(?:\.\d{1,2})?$/.test(obj.value))throw mismatch();const [a,b='']=obj.value.split('.');const minor=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(minor))throw mismatch();return minor;}
function query(url:URL,key:string,expected?:string){const values=url.searchParams.getAll(key);if(values.length===0||values.length>2||values.some(value=>value!==values[0])||expected!==undefined&&values[0]!==expected)throw mismatch();return values[0];}
function assertWire(ctx:Context,url:URL,method:string,config:InternalAxiosRequestConfig){
  if(url.origin!==ORIGIN||url.username||url.password||url.hash||++ctx.requests>2)throw mismatch();
  if(url.pathname==='/v1/oauth2/token'){
    if(method!=='POST'||url.search||config.data!=='grant_type=client_credentials'||ctx.requests!==1)throw mismatch();return;
  }
  if(method!=='GET'||config.data!==undefined)throw mismatch();
  if(ctx.name==='get_order'){if(url.pathname!==`/v2/checkout/orders/${ctx.owned.providerOrderId}`||url.search)throw mismatch();return;}
  if(ctx.name==='get_dispute'){if(url.pathname!==`/v1/customer/disputes/${ctx.disputeId}`||url.search)throw mismatch();return;}
  if(ctx.name==='list_disputes'){
    if(url.pathname!=='/v1/customer/disputes'||[...url.searchParams.keys()].some(key=>!['disputed_transaction_id','page_size','page'].includes(key)))throw mismatch();
    query(url,'disputed_transaction_id',ctx.owned.captureId);query(url,'page_size','50');query(url,'page','1');return;
  }
  if(url.pathname!=='/v1/reporting/transactions'||[...url.searchParams.keys()].some(key=>!['transaction_id','page_size','page','start_date','end_date'].includes(key)))throw mismatch();
  query(url,'transaction_id',ctx.owned.captureId);query(url,'page_size','100');query(url,'page','1');
  const start=Date.parse(query(url,'start_date')),end=Date.parse(query(url,'end_date'));
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||end-start>31*86400000+1000||Math.abs(end-Date.now())>60000)throw mismatch();
}
async function readJson(response:globalThis.Response,signal:AbortSignal){
  if(!response.body)throw mismatch();const reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024)throw mismatch();parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;}catch{throw mismatch();}
}
const adapter:AxiosAdapter=async config=>{
  const ctx=calls.getStore();if(!ctx)throw mismatch();
  try{
    const url=new URL(axios.getUri(config)),method=(config.method??'GET').toUpperCase();assertWire(ctx,url,method,config);
    await ctx.beforeSend();ctx.deadline.throwIfAborted();
    const headers=new Headers();for(const [key,value] of Object.entries(config.headers.toJSON()))if(value!==undefined&&value!==null)headers.set(key,String(value));
    const response=await ctx.fetch(url,{method,headers,body:method==='POST'?String(config.data):undefined,signal:ctx.deadline,redirect:'error'});
    const value=await readJson(response,ctx.deadline);
    if(!response.ok)throw new HttpError(response.status===401||response.status===403?503:502,'TOOLKIT_READ_UNAVAILABLE',`The scoped Toolkit read returned HTTP ${response.status}. No empty result was inferred.`);
    if(method==='POST'){
      const token=object(value);if(typeof token.access_token!=='string'||!token.access_token||token.access_token.length>10000||/\s/.test(token.access_token))throw mismatch();
    }else{
      const debug=response.headers.get('paypal-debug-id');
      ctx.reads.push({status:response.status,body:value,hash:hash(value),observedAt:new Date().toISOString(),start:url.searchParams.get('start_date'),end:url.searchParams.get('end_date'),debugId:debug&&/^[A-Za-z0-9_-]{1,100}$/.test(debug)?debug:null});
    }
    return {data:value,status:response.status,statusText:response.statusText,headers:Object.fromEntries(response.headers),config};
  }catch(error){ctx.failed=true;throw error instanceof HttpError?error:new HttpError(502,'TOOLKIT_READ_UNAVAILABLE','The scoped Toolkit read was interrupted. No empty result was inferred.');}
};
// Supported Axios middleware seam; no Toolkit internals or vendor code are patched.
axios.interceptors.request.use(config=>calls.getStore()?{...config,adapter,maxRedirects:0,timeout:15000,proxy:false}:config);

export interface ToolkitReadResult {
  source:'sandbox'|'synthetic_transport';transport:'Toolkit';package:'@paypal/agent-toolkit@1.11.0';
  operation:NativeRead;orderId:string;captureId:string;observedAt:string;bodyHash:string;status:number;
  coverage:Record<string,unknown>;facts:Record<string,unknown>;disclosure:string;
}
export class ScopedPayPalToolkit {
  constructor(private readonly clientId:string,private readonly clientSecret:string,readonly mode:'live'|'synthetic'='live',private readonly fetcher:typeof fetch=globalThis.fetch){}
  async read(name:string,owned:OwnedPayment,disputeId:string|undefined,beforeSend:()=>Promise<void>):Promise<ToolkitReadResult>{
    const mapping:Record<string,NativeRead>={paypal_get_order:'get_order',paypal_list_disputes:'list_disputes',paypal_get_dispute:'get_dispute',paypal_find_transaction:'list_transactions'};
    const native=mapping[name];if(!native)throw new HttpError(403,'TOOLKIT_WRITE_DENIED','Only four explicitly registered PayPal reads are available.');
    if(native==='get_dispute'&&(!disputeId||!/^[A-Za-z0-9_-]{1,100}$/.test(disputeId)))throw mismatch();
    if(process.env.DEBUG&&(/agent-toolkit|\*/.test(process.env.DEBUG)))throw new HttpError(503,'TOOLKIT_DEBUG_DISABLED','Toolkit debug output must be disabled before private reads.');
    const toolkit=new PayPalAgentToolkit({clientId:this.clientId,clientSecret:this.clientSecret,configuration:{actions:{orders:{get:true},disputes:{list:true,get:true},transactions:{list:true}},context:{sandbox:true,debug:false}}});
    const advertised=toolkit.getTools().filter(tool=>tool.type==='function').map(tool=>tool.function.name).sort();
    if(hash(advertised)!==hash(['get_dispute','get_order','list_disputes','list_transactions']))throw new HttpError(503,'TOOLKIT_CONTRACT_CHANGED','The installed Toolkit read inventory differs from the pinned contract.');
    const args=native==='get_order'?{id:owned.providerOrderId}:native==='get_dispute'?{dispute_id:disputeId}:native==='list_disputes'?{disputed_transaction_id:owned.captureId,page_size:50,page:1}:{transaction_id:owned.captureId,search_months:1,page_size:100,page:1};
    const context:Context={name:native,owned,disputeId,fetch:this.fetcher,beforeSend,reads:[],requests:0,failed:false,deadline:AbortSignal.timeout(20000)};
    await calls.run(context,async()=>{
      try{await toolkit.handleToolCall({id:'glasshouse-owned-read',type:'function',function:{name:native,arguments:JSON.stringify(args)}});}catch{context.failed=true;}
    });
    // Toolkit may swallow a reporting failure as found:false. Only independently
    // observed successful native wire evidence can establish a result.
    if(context.failed||context.reads.length!==1)throw new HttpError(502,'TOOLKIT_READ_UNRESOLVED','The installed Toolkit did not return one successful scoped read. Reporting absence was not inferred.');
    const wire=context.reads[0],body=object(wire.body);let facts:Record<string,unknown>,coverage:Record<string,unknown>;
    if(native==='get_order'){
      if(body.id!==owned.providerOrderId)throw mismatch();const units=list(body.purchase_units,1);if(units.length!==1)throw mismatch();
      const unit=object(units[0]);if(unit.custom_id!==owned.customId)throw mismatch();const captures=list(object(unit.payments).captures,1);if(captures.length!==1)throw mismatch();const capture=object(captures[0]);
      if(capture.id!==owned.captureId||money(capture.amount)!==owned.entry.amountMinor)throw mismatch();
      facts={orderId:owned.providerOrderId,status:code(body.status),captureId:owned.captureId,captureStatus:code(capture.status),amountMinor:money(capture.amount),currency:'USD',providerOccurredAt:date(capture.create_time)};coverage={kind:'exact_owned_order'};
    }else if(native==='get_dispute'||native==='list_disputes'){
      const cases=native==='get_dispute'?[body]:list(body.items??[],50);
      if(native==='list_disputes'&&body.items===undefined)throw mismatch();
      const rows=cases.map(value=>{
        const item=object(value),transactions=list(item.disputed_transactions,1);if(transactions.length!==1)throw mismatch();const transaction=object(transactions[0]);
        if(transaction.seller_transaction_id!==owned.captureId)throw mismatch();
        if(transaction.gross_amount!==undefined&&money(transaction.gross_amount)!==owned.entry.amountMinor)throw mismatch();
        const dispute=id(item.dispute_id);if(native==='get_dispute'&&dispute!==disputeId)throw mismatch();
        return {id:dispute,captureId:owned.captureId,status:code(item.status),reason:code(item.reason),stage:item.dispute_life_cycle_stage?code(item.dispute_life_cycle_stage):null,amountMinor:item.dispute_amount?money(item.dispute_amount):null,currency:'USD',providerUpdatedAt:date(item.update_time),sellerResponseDueAt:date(item.seller_response_due_date)};
      });
      facts={disputes:rows};coverage={kind:native==='get_dispute'?'exact_bound_case':'first_owned_capture_page',page:1,pageSize:50,complete:false};
    }else{
      if(!Array.isArray(body.transaction_details)&&!(body.total_items===0&&body.total_pages===0))throw mismatch();
      const rows=list(body.transaction_details??[],100).map(value=>object(object(value).transaction_info));
      if(rows.some(row=>row.transaction_id!==owned.captureId)||body.page!==1||!Number.isSafeInteger(body.total_items)||!Number.isSafeInteger(body.total_pages)||Number(body.total_items)<rows.length||Number(body.total_pages)<0||rows.length>1||Number(body.total_items)>0&&Number(body.total_pages)<1)throw mismatch();
      const matches=rows.map(row=>{
        const amount=money(row.transaction_amount);if(amount!==owned.entry.amountMinor)throw mismatch();
        return {captureId:owned.captureId,amountMinor:amount,currency:'USD',status:code(row.transaction_status),providerOccurredAt:date(row.transaction_initiation_date)};
      });
      const refreshed=date(body.last_refreshed_datetime);
      facts={matches,observed:matches.length>0,providerRefreshedAt:refreshed};coverage={kind:'bounded_reporting_page',start:wire.start,end:wire.end,page:1,pageSize:100,totalItems:body.total_items,totalPages:body.total_pages,complete:false,providerRefreshedAt:refreshed};
    }
    return {source:this.mode==='live'?'sandbox':'synthetic_transport',transport:'Toolkit',package:'@paypal/agent-toolkit@1.11.0',operation:native,orderId:owned.orderId,captureId:owned.captureId,observedAt:wire.observedAt,bodyHash:wire.hash,status:wire.status,coverage,facts,disclosure:native==='list_transactions'?'A current, bounded reporting read. Reporting can lag; absence in this page does not establish a missing capture. This read does not change the workspace T/K projection.':'A current read of the exact owned sandbox resource. This read does not change the workspace T/K projection.'};
  }
}
