import { SandboxPayPalProvider } from '@fracture/paypal-core';
import { database } from '../packages/db/client';
import { PaymentSecrets } from '../packages/payments/security';
import { openConsent,type ConsentRecord } from '../lib/server/payments/records';
import { mkdir,writeFile } from 'node:fs/promises';

const consentId=process.argv.find(value=>value.startsWith('--consent='))?.slice('--consent='.length);
if(!consentId)throw new Error('A stored consent ID is required.');
const db=await database();
const row=(await db.query<ConsentRecord>('SELECT * FROM gh_payment_consents WHERE id=$1',[consentId]))[0];
if(!row)throw new Error('The consent was not found.');
const value=openConsent(new PaymentSecrets(process.env.GLASSHOUSE_PAYMENT_KEY??''),row);
if(!value.setup)throw new Error('This consent has no known setup identity.');
const provider=new SandboxPayPalProvider({environment:'sandbox',baseUrl:'https://api-m.sandbox.paypal.com',clientId:process.env.PAYPAL_CLIENT_ID!,clientSecret:process.env.PAYPAL_CLIENT_SECRET!,isolatedProject:'glasshouse'});
function codes(payload:unknown){
  if(!payload||typeof payload!=='object')return [];
  let body:unknown='body' in payload?payload.body:null;
  if(!body&&'rawBody' in payload&&payload.rawBody instanceof ArrayBuffer&&payload.rawBody.byteLength<8192){try{body=JSON.parse(new TextDecoder().decode(payload.rawBody));}catch{}}
  if(!body||typeof body!=='object')return [];
  const values:unknown[]=['name'in body?body.name:null];
  if('details'in body&&Array.isArray(body.details))for(const detail of body.details){if(detail&&typeof detail==='object'&&'issue'in detail)values.push(detail.issue);}
  return values.filter((item):item is string=>typeof item==='string'&&/^[A-Z][A-Z0-9_]{0,70}$/.test(item)).slice(0,10);
}
const signal=AbortSignal.timeout(25_000);
const setup=await provider.client.vault.getSetupToken({id:value.setup.id},{signal}).asApiResult();
const list=await provider.client.vault.listCustomerPaymentTokens({customerId:value.setup.customerId,page:1,pageSize:10,totalRequired:true},{signal}).asApiResult();
const results=[{
  operation:'getSetupToken',httpStatus:setup.status,debugId:setup.headers.get('paypal-debug-id'),
  ...(setup.ok?{providerStatus:setup.value.status,identityMatches:setup.value.id===value.setup.id,customerMatches:setup.value.customer?.id===value.setup.customerId,merchantCustomerMatches:setup.value.customer?.merchantCustomerId===value.merchantCustomerId,payerPresent:!!setup.value.paymentSource?.paypal?.payerId}:{codes:codes(setup.payload)}),
},{
  operation:'listCustomerPaymentTokens',httpStatus:list.status,debugId:list.headers.get('paypal-debug-id'),
  ...(list.ok?{totalItems:list.value.totalItems,totalPages:list.value.totalPages,returnedItems:list.value.paymentTokens?.length,customerMatches:list.value.customer?.id===value.setup.customerId}:{codes:codes(list.payload)}),
}];
const evidence={at:new Date().toISOString(),consentId,providerWrites:0,results};
await mkdir('.setup-evidence',{recursive:true});
await writeFile('.setup-evidence/glasshouse-vault-read-probe.json',JSON.stringify(evidence,null,2),{mode:0o600});
console.log(JSON.stringify(evidence));
process.exit(0);
