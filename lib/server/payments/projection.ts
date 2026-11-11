import {recordFindingSourceChange} from '../findings/sources';
import {hasFindingsSchema} from '../findings/schema';
import type { Database } from '@/packages/db/client';
import type { Actor, SourceEvent } from '@/packages/domain/types';
import { appendStateObservation } from '@/packages/domain/seed';
import { audit, datasetFor } from '../repository';
import { HttpError } from '../errors';
import type { CaptureEvidence, OwnedOrderEvidence } from './evidence';
import type { ItemRecord, RunRecord } from './records';

export async function projectCapture(db: Database, run: RunRecord, item: ItemRecord, order: OwnedOrderEvidence, capture: CaptureEvidence) {
  const actor: Actor = { id:run.approved_by!, tenantId:run.tenant_id, role:'operator', membershipVersion:run.membership_version };
  await db.transaction(async tx => {
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE', [run.tenant_id]);
    const dataset = await datasetFor(actor,tx), before=structuredClone(dataset);
    const record = dataset.orders.find(value=>value.id===item.order_id);
    if (!record || record.captureId && record.captureId !== capture.id || record.paypalOrderId && record.paypalOrderId !== order.id) throw new HttpError(409,'PROVIDER_BINDING_CONFLICT','This order already belongs to another provider payment.');
    await tx.query(`INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body)
      VALUES($1,'capture',$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,kind,provider_id)
      DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body`, [run.tenant_id,capture.id,item.order_id,run.id,capture.observedAt,JSON.stringify(capture)]);
    await tx.query('INSERT INTO gh_provider_observations(tenant_id,id,order_id,resource_id,kind,observed_at,body_hash,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING', [run.tenant_id,`capture-${capture.id}-${capture.bodyHash.slice(0,16)}`,item.order_id,capture.id,'capture',capture.observedAt,capture.bodyHash,JSON.stringify(capture)]);
    const eventId = `paypal:capture:${capture.id}`;
    if (!dataset.events.some(event=>event.id===eventId)) {
      const revision = dataset.revision+1;
      const knowledge = new Date(Math.max(Date.now(),Date.parse(capture.observedAt))).toISOString();
      const narrativeTime = new Date(Date.parse(record.narrativeCreatedAt)+5*60_000).toISOString();
      const original = dataset.events.find(event=>event.orderId===item.order_id && event.type==='payment.captured' && event.sourceClass==='sample');
      const event: SourceEvent = {
        id:eventId,tenantId:run.tenant_id,orderId:item.order_id,type:'payment.captured',dimension:'payment',state:'captured',
        occurredAt:capture.occurredAt,ingestedAt:knowledge,narrativeTime,sourceClass:'sandbox',sourceLabel:'PayPal sandbox · independently verified capture',
        sourceRef:`paypal://sandbox/capture/${capture.id}`,revision,
        payload:{amountMinor:capture.amountMinor,currency:capture.currency,paypalOrderId:order.id,captureId:capture.id,providerResourceId:capture.id,receiptHash:capture.bodyHash,runId:run.id,resourceVersion:record.resourceVersion+1,supersedesEventId:original?.id ?? null,clockMapping:'Provider capture time is actual; narrative time maps this owned seed order into the incident story.'},
      };
      const previousIds = new Set(dataset.intervals.filter(interval=>interval.orderId===item.order_id && interval.dimension==='payment' && interval.validTo===null && interval.knowledgeTo===null).map(interval=>interval.id));
      appendStateObservation(dataset.intervals,event);
      dataset.events.push(event); dataset.revision=revision;
      record.captureId=capture.id; record.paypalOrderId=order.id; record.providerOccurredAt=capture.occurredAt;
      record.paymentSource='sandbox'; record.resourceVersion++;
      dataset.evidence.push({id:`evidence:${eventId}`,tenantId:run.tenant_id,orderId:item.order_id,title:`${record.reference} · PayPal capture verified`,excerpt:`A separate PayPal read confirmed ${(capture.amountMinor/100).toFixed(2)} USD captured for this exact order. Shipping and dispute evidence keep their own provenance.`,sourceClass:'sandbox',sourceLabel:'PayPal sandbox',occurredAt:narrativeTime,ingestedAt:knowledge,kind:'payment',supports:[eventId],contradicts:[]});
      await tx.query('UPDATE gh_datasets SET revision=$2,body=$3::jsonb,updated_at=now() WHERE tenant_id=$1', [run.tenant_id,revision,JSON.stringify(dataset)]);
      await tx.query('INSERT INTO gh_source_events(tenant_id,id,order_id,occurred_at,ingested_at,source_class,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING', [run.tenant_id,event.id,item.order_id,event.occurredAt,event.ingestedAt,event.sourceClass,JSON.stringify(event)]);
      const changed = dataset.intervals.filter(interval=>previousIds.has(interval.id) || interval.sourceEventId===event.id || [...previousIds].some(id=>interval.id===`${id}:until:${event.id}`));
      for (const interval of changed) {
        await tx.query(`INSERT INTO gh_state_intervals(tenant_id,id,order_id,dimension,state,valid_from,valid_to,knowledge_from,knowledge_to,clock_domain,source_class,source_event_id,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,id) DO UPDATE SET knowledge_to=excluded.knowledge_to`, [run.tenant_id,interval.id,item.order_id,interval.dimension,interval.state,interval.validFrom,interval.validTo,interval.knowledgeFrom,interval.knowledgeTo,interval.clockDomain,interval.sourceClass,interval.sourceEventId,interval.revision]);
      }
      await recordFindingSourceChange(tx,actor,before,dataset,{kind:'payment_capture',reason:'Independent payment evidence changed the resource authority.',sourceId:event.id});
      if(!await hasFindingsSchema(tx))await tx.query("UPDATE gh_plans SET status='stale',body=jsonb_set(jsonb_set(body,'{status}','\"stale\"'::jsonb),'{staleReason}','\"New independent payment evidence changed the resource version.\"'::jsonb) WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved')", [run.tenant_id]);
      await audit(tx,actor,'payment.capture_verified',`${record.reference} independently verified as a sandbox capture`,capture.id,{runId:run.id,orderId:item.order_id,amountMinor:capture.amountMinor,currency:'USD',source:'sandbox',transport:'apimatic_sdk',receiptHash:capture.bodyHash});
    }
    await tx.query("UPDATE gh_seed_items SET status='captured',provider_order_id=$4,provider_capture_id=$5,observed_at=$6,receipt=$7::jsonb,reason=NULL,lease_owner=NULL,lease_until=NULL WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3", [run.tenant_id,run.id,item.order_id,order.id,capture.id,capture.observedAt,JSON.stringify(capture)]);
  });
}
