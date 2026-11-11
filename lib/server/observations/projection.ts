import type { Database } from '@/packages/db/client';
import type { SourceEvent } from '@/packages/domain/types';
import { STORY_END } from '@/packages/domain/seed';
import { digest } from '@/packages/payments/security';
import { audit, datasetFor } from '../repository';
import { HttpError } from '../errors';
import { ownedPaymentResource, type OwnedPayment } from '../recovery/authority';
import type { CaptureCapacity } from '../recovery/evidence';
import { persistObservation } from '../recovery/projection';
import { connectorActor, requireConnector, type ObservationConnector } from './connector';

/** A complete independent inventory updates balances, never a webhook's amount or status. */
export async function projectCapacity(db: Database, connector: ObservationConnector, owned: OwnedPayment, observation: CaptureCapacity) {
  await db.transaction(async tx => {
    await requireConnector(tx,connector);
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[connector.tenantId]);
    if (owned.tenantId !== connector.tenantId || digest(await ownedPaymentResource(tx,connector.tenantId,owned.orderId)) !== digest(owned) ||
      observation.captureId !== owned.captureId || observation.orderId !== owned.providerOrderId || observation.totalMinor !== owned.entry.amountMinor || observation.currency !== 'USD') {
      throw new HttpError(409,'CAPACITY_BINDING_CHANGED','The independent inventory no longer matches the connector-owned capture.');
    }
    const previous = (await tx.query<{body:CaptureCapacity}>("SELECT body FROM gh_provider_resources WHERE tenant_id=$1 AND kind='capture_capacity' AND provider_id=$2",[connector.tenantId,owned.captureId]))[0]?.body;
    if (previous && Date.parse(previous.observedAt) > Date.parse(observation.observedAt)) return;
    if (previous?.bodyHash === observation.bodyHash) {
      // A repeated read still advances the freshness fence. Otherwise an older read
      // with different content could overwrite it after the later read deduplicates.
      await tx.query("UPDATE gh_provider_resources SET observed_at=$3,body=$4::jsonb WHERE tenant_id=$1 AND kind='capture_capacity' AND provider_id=$2",
        [connector.tenantId,owned.captureId,observation.observedAt,JSON.stringify(observation)]);
      return;
    }
    if (previous?.refunds.some(refund => refund.status === 'COMPLETED' && !observation.refunds.some(current => current.id === refund.id && current.status === 'COMPLETED' && current.amountMinor === refund.amountMinor))) {
      throw new HttpError(409,'REFUND_INVENTORY_REGRESSED','A complete confirmed refund disappeared from the new read. Keep the prior evidence and check again.');
    }
    const actor = connectorActor(connector), dataset = await datasetFor(actor,tx), order = dataset.orders.find(value => value.id === owned.orderId);
    if (!order) throw new HttpError(409,'OWNED_ORDER_MISSING','The independently owned order is unavailable.');
    const completedMinor = observation.refunds.filter(refund => refund.status === 'COMPLETED').reduce((sum,refund) => sum+refund.amountMinor,0);
    // The same balance can recur after a pending refund stops consuming money.
    // Deduplicate consecutive reads above; a return to old content is new knowledge.
    const event: SourceEvent = {id:`paypal:capacity:${owned.captureId}:${observation.bodyHash.slice(0,24)}:r${dataset.revision+1}`,tenantId:connector.tenantId,orderId:owned.orderId,
      type:'payment.refund_balance_observed',dimension:'payment',state:'balance_observed',occurredAt:observation.observedAt,ingestedAt:new Date(Math.max(Date.now(),Date.parse(observation.observedAt))).toISOString(),
      narrativeTime:STORY_END,sourceClass:'sandbox',sourceLabel:'PayPal sandbox · complete refund inventory',sourceRef:`paypal://sandbox/capture/${owned.captureId}`,revision:dataset.revision+1,
      payload:{captureId:owned.captureId,totalMinor:observation.totalMinor,completedMinor,consumedMinor:observation.consumedMinor,currency:'USD',complete:true,
        refundIds:observation.refundIds,refunds:observation.refunds.map(({id,status,amountMinor})=>({id,status,amountMinor})),
        receiptHash:observation.bodyHash,resourceVersion:order.resourceVersion+1,
        clockMapping:'The inventory was independently read at the actual observation time and maps to this incident decision point. Pending refunds reserve balance; they are not completed refunds.'}};
    if (dataset.events.some(item => item.id === event.id)) return;
    dataset.events.push(event);dataset.revision++;order.resourceVersion++;
    dataset.evidence.push({id:`evidence:${event.id}`,tenantId:connector.tenantId,orderId:order.id,kind:'payment',title:`${order.reference} · refund balance checked`,
      excerpt:`Independent reads established ${observation.refundIds.length} refund records: ${(completedMinor/100).toFixed(2)} USD completed and ${((observation.consumedMinor-completedMinor)/100).toFixed(2)} USD pending. The webhook was only a read trigger.`,
      sourceClass:'sandbox',sourceLabel:event.sourceLabel,occurredAt:STORY_END,ingestedAt:event.ingestedAt,supports:[event.id],contradicts:[]});
    await persistObservation(tx,dataset,event,new Set());
    await tx.query(`INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body) VALUES($1,'capture_capacity',$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(tenant_id,kind,provider_id) DO UPDATE SET version=gh_provider_resources.version+1,observed_at=excluded.observed_at,body=excluded.body`,
      [connector.tenantId,owned.captureId,owned.orderId,owned.runId,observation.observedAt,JSON.stringify(observation)]);
    await tx.query(`INSERT INTO gh_provider_observations(tenant_id,id,order_id,resource_id,kind,observed_at,body_hash,body) VALUES($1,$2,$3,$4,'capture_capacity',$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [connector.tenantId,event.id,owned.orderId,owned.captureId,observation.observedAt,observation.bodyHash,JSON.stringify(observation)]);
    await tx.query("UPDATE gh_plans SET status='stale',body=jsonb_set(jsonb_set(body,'{status}','\"stale\"'::jsonb),'{staleReason}','\"A complete independent refund inventory changed the evidence.\"'::jsonb) WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved')",[connector.tenantId]);
    await audit(tx,actor,'provider.balance_observed',`${order.reference} · current refund inventory independently checked`,owned.captureId,{readOnly:true,receiptHash:observation.bodyHash,completedMinor,consumedMinor:observation.consumedMinor});
  });
}
