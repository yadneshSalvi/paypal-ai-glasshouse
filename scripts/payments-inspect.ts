import { database } from '../packages/db/client';
import { PaymentSecrets } from '../packages/payments/security';
import { openConsent, type ConsentRecord } from '../lib/server/payments/records';

const db=await database();
const consentId=process.argv.find(value=>value.startsWith('--consent='))?.slice('--consent='.length);
const rows=await db.query<ConsentRecord>(`SELECT * FROM gh_payment_consents${consentId?' WHERE id=$1':''} ORDER BY created_at DESC LIMIT 20`,consentId?[consentId]:[]);
if(process.argv.includes('--progress')){
  for(const row of rows){
    const run=await db.query('SELECT id,status,approval_version,approval_expires_at,manifest_hash FROM gh_seed_runs WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.run_id]);
    const progress=await db.query('SELECT status,count(*)::int AS count,sum((entry->>\'amountMinor\')::bigint)::text AS total_minor FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 GROUP BY status',[row.tenant_id,row.run_id]);
    const held=await db.query("SELECT entry->>'reference' AS reference,status,reason FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 AND status IN ('unknown','refused','held','awaiting_buyer') ORDER BY order_id",[row.tenant_id,row.run_id]);
    console.log(JSON.stringify({observedAt:new Date().toISOString(),consentStatus:row.status,run:run[0],progress,held}));
  }
  process.exit(0);
}
const secrets=new PaymentSecrets(process.env.GLASSHOUSE_PAYMENT_KEY??'');
for(const row of rows){
  const value=openConsent(secrets,row);
  const operations=await db.query('SELECT id,kind,status,request_hash,receipt,lease_until,created_at,updated_at FROM gh_vault_operations WHERE tenant_id=$1 AND consent_id=$2 ORDER BY created_at',[row.tenant_id,row.id]);
  const progress=await db.query('SELECT status,count(*)::int AS count FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 GROUP BY status',[row.tenant_id,row.run_id]);
  const audit=await db.query("SELECT timestamp,event_type,body->'data' AS data FROM gh_audit WHERE tenant_id=$1 AND body->>'refId'=$2 ORDER BY sequence DESC LIMIT 10",[row.tenant_id,row.id]);
  console.log(JSON.stringify({tenantId:row.tenant_id,runId:row.run_id,consentId:row.id,status:row.status,reason:row.reason,verifiedAt:row.verified_at,expiresAt:row.expires_at,privateEvidence:{setupPresent:!!value.setup,setupStatus:value.setup?.status,setupCustomerPresent:!!value.setup?.customerId,merchantCustomerMatches:value.setup?.merchantCustomerId===value.merchantCustomerId,payerPresent:!!value.setup?.payerId,tokenPresent:!!value.token,callbackVerified:value.callbackVerified,baselineTokenCount:value.baselineTokenIds?.length},operations,progress,audit}));
}
process.exit(0);
