import { database,type Database } from '@/packages/db/client';
import type { Actor } from '@/packages/domain/types';
import { recoveryMember } from './recovery/authority';
import { ensureObservationSchema } from './observations/schema';
import { configuredConnector } from './observations/connector';

export async function capabilities(actor:Actor,connection?:Database,configuration:Record<string,string|undefined>=process.env) {
  const db=connection??await database();
  actor=await recoveryMember(db,actor);
  const proof=await db.query<{kind:string;count:number;observed_at:string|Date}>(`SELECT kind,count(DISTINCT resource_id)::int AS count,max(observed_at) AS observed_at
    FROM gh_provider_observations WHERE tenant_id=$1 AND (
      kind='capture' AND body->>'status'='COMPLETED' OR
      kind='refund' AND body->>'status'='COMPLETED' OR
      kind='tracking' AND body->>'status'='SHIPPED' OR
      kind='dispute' AND body->'evidence' @> '[{"source":"SUBMITTED_BY_SELLER","type":"PROOF_OF_FULFILLMENT"}]'::jsonb
    ) GROUP BY kind`,[actor.tenantId]);
  const facts=(kind:string)=>proof.find(row=>row.kind===kind);
  const isolated=configuration.PAYPAL_PROJECT_ISOLATED==='true';
  const configured=isolated&&Boolean(configuration.PAYPAL_CLIENT_ID&&configuration.PAYPAL_CLIENT_SECRET);
  await ensureObservationSchema(db);
  let webhookBinding:ReturnType<typeof configuredConnector>=null;
  try{webhookBinding=configuredConnector(configuration);}catch{/* Incomplete connection setup is a visible capability gap. */}
  const webhookProof=(await db.query<{count:number;observed_at:string|Date|null}>(`SELECT count(*)::int AS count,max(e.received_at) AS observed_at
    FROM gh_webhook_events e JOIN gh_paypal_connectors c ON c.id=e.connector_id
    WHERE e.tenant_id=$1 AND e.state='complete' AND c.active=true AND c.config_hash=$2`,[actor.tenantId,webhookBinding?.configHash??'']))[0];
  const webhookCount=webhookProof?.count??0;
  const observed=(kind:string,description:string)=>{
    const value=facts(kind),count=value?.count??0;
    return {available:configured&&count>0,verifiedCount:count,observedAt:value?new Date(value.observed_at).toISOString():null,
      reason:count?`${count} ${description} independently verified in this workspace`:`No ${description} verified in this workspace yet`};
  };
  return {
    studio: { available: true, version: '3.1.0', widgets: 6, source: 'installed-package' },
    storage: { available:true, type:configuration.DATABASE_URL?'Postgres':'Local embedded Postgres' },
    ai: { available:Boolean(configuration.OPENAI_API_KEY),model:configuration.OPENAI_MODEL||'gpt-6.1-sol',transport:'OpenAI' },
    paypal: { available:configured&&(facts('capture')?.count??0)>0,configured,environment:'sandbox',isolated,
      reason:(facts('capture')?.count??0)>0?`${facts('capture')!.count} owned captures independently verified`:configured?'Configured; no owned captures verified yet':'Project sandbox connection is being verified' },
    refunds:observed('refund','refunds'),tracking:observed('tracking','tracking assignments'),disputes:observed('dispute','seller evidence submissions'),
    webhooks:{available:webhookCount>0,configured:webhookBinding?.tenantId===actor.tenantId,verifiedCount:webhookCount,
      observedAt:webhookProof?.observed_at?new Date(webhookProof.observed_at).toISOString():null,
      reason:webhookCount?`${webhookCount} authenticated provider events independently checked`:'A verified webhook delivery has not been qualified yet'},
  };
}
