import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SandboxPayPalProvider, SqlPaymentStore } from '@fracture/paypal-core';
import type { Database } from '../../packages/db/client';
import { schema } from '../../packages/db/schema';
import type { Actor } from '../../packages/domain/types';
import { PaymentSecrets } from '../../packages/payments/security';
import { PaymentService } from '../../lib/server/payments/service';
import { SeedExecutor } from '../../lib/server/payments/execution';
import { coreDatabase, ensurePaymentsSchema } from '../../lib/server/payments/schema';
import { OneWriteTransport } from '../../lib/server/payments/transport';
import { VaultGateway } from '../../lib/server/payments/vault';
import { OrderEvidenceGateway } from '../../lib/server/payments/evidence';

interface FixtureOrder { id:string;status:string;purchase_units:Array<Record<string,unknown>> }
export class PayPalFixture {
  readonly writes:Array<{path:string;body:Record<string,unknown>;requestId:string|null}>=[];
  readonly requests:Array<{path:string;method:string;query:string}>=[];
  readonly orders=new Map<string,FixtureOrder>();
  readonly captures=new Map<string,Record<string,unknown>>();
  readonly refunds=new Map<string,Record<string,unknown>>();
  refundLost=false;trackingLost=false;refundStatus='COMPLETED';refundRefused=false;
  refundLinkOrigin='https://api-m.sandbox.paypal.com';
  onRead:((path:string)=>Promise<void>)|null=null;
  merchantCustomerId='';
  setupApproved=false;
  tokenCreated=false;
  exchangeLost=false;
  createLost=false;
  captureLost=false;
  readsUnavailable=false;
  repeatTokenPage=false;
  missingNewCustomer=false;
  genericMissingCustomer=false;
  readonly customerId='customer_GLASS_FIXTURE';
  readonly payerId='PAYER_GLASS_FIXTURE';
  readonly tokenId='TOKEN_GLASS_FIXTURE';
  private json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','paypal-debug-id':'fixture-debug'}});}
  private token(){return {id:this.tokenId,customer:{id:this.customerId,merchant_customer_id:this.merchantCustomerId},payment_source:{paypal:{payer_id:this.payerId,usage_type:'MERCHANT',usage_pattern:'IMMEDIATE'}}};}
  readonly fetch:typeof fetch=async(input,init)=>{
    const request=new Request(input,init);const url=new URL(request.url);const path=url.pathname;
    if(url.origin!=='https://api-m.sandbox.paypal.com')throw new Error('Unexpected fixture host');
    this.requests.push({path,method:request.method,query:url.search});
    if(path==='/v1/oauth2/token')return this.json({access_token:'fixture-access-token',token_type:'Bearer',expires_in:3600});
    if(request.method==='GET')await this.onRead?.(path);
    if(request.method==='GET'&&this.readsUnavailable)return this.json({name:'INTERNAL_SERVER_ERROR'},500);
    const body=request.method==='POST'?await request.json() as Record<string,unknown>:{};
    if(request.method==='POST')this.writes.push({path,body,requestId:request.headers.get('paypal-request-id')});
    if(path==='/v3/vault/setup-tokens'&&request.method==='POST'){
      this.merchantCustomerId=(body.customer as {merchant_customer_id:string}).merchant_customer_id;
      return this.json({id:'SETUP_GLASS_FIXTURE',status:'PAYER_ACTION_REQUIRED',customer:{id:this.customerId,merchant_customer_id:this.merchantCustomerId},links:[{rel:'approve',method:'GET',href:'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP_GLASS_FIXTURE'}]},201);
    }
    if(path==='/v3/vault/setup-tokens/SETUP_GLASS_FIXTURE')return this.json({id:'SETUP_GLASS_FIXTURE',status:this.tokenCreated?'TOKENIZED':this.setupApproved?'APPROVED':'PAYER_ACTION_REQUIRED',customer:{id:this.customerId,merchant_customer_id:this.merchantCustomerId},payment_source:{paypal:{payer_id:this.payerId}}});
    if(path==='/v3/vault/payment-tokens'&&request.method==='POST'){
      this.tokenCreated=true;
      if(this.exchangeLost){this.exchangeLost=false;throw new Error('Fixture lost exchange response');}
      return this.json(this.token(),201);
    }
    if(path==='/v3/vault/payment-tokens'&&request.method==='GET'){
      if(!this.tokenCreated&&(this.missingNewCustomer||this.genericMissingCustomer))return this.json({name:'RESOURCE_NOT_FOUND',details:[{issue:this.genericMissingCustomer?'RESOURCE_NOT_FOUND':'CUSTOMER_ID_NOT_FOUND'}]},404);
      return this.json({customer:{id:this.customerId},total_items:this.repeatTokenPage?20:this.tokenCreated?1:0,total_pages:this.repeatTokenPage?2:this.tokenCreated?1:0,payment_tokens:this.tokenCreated?[this.token()]:[]});
    }
    if(path===`/v3/vault/payment-tokens/${this.tokenId}`)return this.json(this.token());
    if(path==='/v2/checkout/orders'&&request.method==='POST'){
      const id=`ORDER_FIXTURE_${String(this.orders.size+1).padStart(5,'0')}`;
      const order:FixtureOrder={id,status:'APPROVED',purchase_units:structuredClone(body.purchase_units) as Array<Record<string,unknown>>};
      this.orders.set(id,order);
      if(this.createLost){this.createLost=false;throw new Error('Fixture lost create response');}
      return this.json(order,201);
    }
    const tracking=path.match(/^\/v2\/checkout\/orders\/([^/]+)\/track$/);
    if(tracking&&request.method==='POST'){
      const order=this.orders.get(tracking[1]);if(!order)return this.json({name:'RESOURCE_NOT_FOUND'},404);
      const capture=(order.purchase_units[0].payments as {captures:Array<{id:string}>}).captures[0];
      if(body.capture_id!==capture.id)throw new Error('Tracking fixture requires the exact capture');
      order.purchase_units[0].shipping={trackers:[{id:`TRACKER_FIXTURE_${tracking[1]}`,status:'SHIPPED',create_time:new Date().toISOString()}]};
      if(this.trackingLost){this.trackingLost=false;this.readsUnavailable=true;throw new Error('Fixture lost tracking response');}
      return this.json(order,201);
    }
    const match=path.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if(match){
      const order=this.orders.get(match[1]);if(!order)return this.json({name:'RESOURCE_NOT_FOUND'},404);
      if(request.method==='GET')return this.json(order);
      if(match[2]&&request.method==='POST'){
        const id=`CAPTURE_FIXTURE_${String(this.captures.size+1).padStart(5,'0')}`;
        const capture={id,status:'COMPLETED',amount:order.purchase_units[0].amount,create_time:new Date().toISOString(),supplementary_data:{related_ids:{order_id:order.id}}};
        this.captures.set(id,capture);order.status='COMPLETED';order.purchase_units[0].payments={captures:[capture]};
        if(this.captureLost){this.captureLost=false;this.readsUnavailable=true;throw new Error('Fixture lost capture response');}
        return this.json(order,201);
      }
    }
    const capture=path.match(/^\/v2\/payments\/captures\/([^/]+)$/);
    if(capture&&request.method==='GET')return this.captures.has(capture[1])?this.json(this.captures.get(capture[1])):this.json({name:'RESOURCE_NOT_FOUND'},404);
    const refund=path.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/);
    if(refund&&request.method==='POST'){
      if(this.refundRefused)return this.json({name:'UNPROCESSABLE_ENTITY',details:[{issue:'REFUND_NOT_ALLOWED'}]},422);
      const capture=this.captures.get(refund[1]);if(!capture)return this.json({name:'RESOURCE_NOT_FOUND'},404);
      const order=[...this.orders.values()].find(order=>(order.purchase_units[0].payments as {captures:Array<{id:string}>}).captures.some(item=>item.id===refund[1]))!;
      const id=`REFUND_FIXTURE_${String(this.refunds.size+1).padStart(5,'0')}`;
      const value={id,status:this.refundStatus,amount:body.amount,custom_id:body.custom_id,create_time:new Date().toISOString(),links:[{rel:'up',method:'GET',href:`${this.refundLinkOrigin}/v2/payments/captures/${refund[1]}`}]};
      this.refunds.set(id,value);capture.status=this.refundStatus==='COMPLETED'?'PARTIALLY_REFUNDED':'COMPLETED';
      const payments=order.purchase_units[0].payments as {refunds?:unknown[]};payments.refunds=[...(payments.refunds??[]),value];
      if(this.refundLost){this.refundLost=false;this.readsUnavailable=true;throw new Error('Fixture lost refund response');}
      return this.json(value,201);
    }
    const readRefund=path.match(/^\/v2\/payments\/refunds\/([^/]+)$/);
    if(readRefund&&request.method==='GET')return this.refunds.has(readRefund[1])?this.json(this.refunds.get(readRefund[1])):this.json({name:'RESOURCE_NOT_FOUND'},404);
    throw new Error(`Unimplemented fixture endpoint ${request.method} ${path}`);
  };
}

export async function paymentHarness() {
  const pg=new PGlite();
  await pg.exec(schema);
  function adapt(client:Pick<typeof pg,'query'>):Database{return {
    async query<T extends Record<string,unknown>>(sql:string,params:unknown[]=[]){return(await client.query<T>(sql,params)).rows;},
    transaction:work=>pg.transaction(tx=>work(adapt(tx))),
  };}
  const db=adapt(pg);
  await ensurePaymentsSchema(db);
  const who:Actor={id:'fixture-owner',tenantId:'glasshouse-fixture-tenant',role:'judge',membershipVersion:1};
  await db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,$4)',[who.tenantId,who.id,who.role,who.membershipVersion]);
  const fixture=new PayPalFixture();
  const transport=new OneWriteTransport(fixture.fetch);
  const sdk=new SandboxPayPalProvider({environment:'sandbox',baseUrl:'https://api-m.sandbox.paypal.com',clientId:'fixture-client',clientSecret:'fixture-secret',isolatedProject:'glasshouse'},transport.fetch);
  const secrets=new PaymentSecrets(randomBytes(32).toString('base64'));
  const vault=new VaultGateway(sdk.client,transport);
  const service=new PaymentService({db,secrets,vault,configured:true,isolated:true});
  const store=new SqlPaymentStore(coreDatabase(db),{operationDocumentCodec:secrets.operationCodec()});
  await store.initialize();
  const evidence=new OrderEvidenceGateway(sdk.client);
  const executor=new SeedExecutor({service,store,provider:transport.provider(sdk),evidence});
  return {pg,db,who,fixture,transport,sdk,secrets,vault,service,store,executor,evidence};
}
export async function approvedRun(h:Awaited<ReturnType<typeof paymentHarness>>) {
  const status=await h.service.status(h.who);
  let run=await h.service.createRun(h.who,status.suggestedManifest.hash);
  run=await h.service.connect(h.who,run.id,run.manifest.hash,'http://localhost:4103');
  h.fixture.setupApproved=true;
  const row=(await h.db.query<{private_document:string}>('SELECT private_document FROM gh_payment_consents WHERE tenant_id=$1 AND id=$2',[h.who.tenantId,run.consent!.id]))[0];
  const {consentIdentity}=await import('../../lib/server/payments/records');
  const privateValue=h.secrets.open<{nonce:string}>(row.private_document,consentIdentity(h.who.tenantId,run.consent!.id));
  run=await h.service.completeConsent(h.who,run.id,privateValue.nonce);
  return h.service.approve(h.who,run.id,run.manifest.hash);
}
