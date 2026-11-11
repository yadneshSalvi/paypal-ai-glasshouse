import {recordFindingSourceChange} from '../findings/sources';
import {hasFindingsSchema} from '../findings/schema';
import type { Database } from '@/packages/db/client';
import type { Actor, SourceEvent } from '@/packages/domain/types';
import { appendStateObservation, STORY_END } from '@/packages/domain/seed';
import { digest } from '@/packages/payments/security';
import { audit, datasetFor, persistDataset } from '../repository';
import { HttpError } from '../errors';
import type { OrderEvidenceGateway } from '../payments/evidence';
import { ownedPayment, recoveryMember, type OwnedPayment } from './authority';
import type { DisputesGateway, DisputeObservation, DisputeInventory } from './disputes';
import { disputeCapabilities } from './disputes';
import { requireObservationAuthority, type ConnectorAuthority } from '../observations/connector';
import {assertWorkspaceRequestWrite,assertWorkspaceProviderScope} from '../workspaces/authority';

export class DisputeService {
  constructor(private readonly db: Database, private readonly disputes: Pick<DisputesGateway, 'list' | 'get'>,
    private readonly orders: Pick<OrderEvidenceGateway, 'order'>) {}

  private async currentRead(actor:Actor,orderId:string,expected?:OwnedPayment){return this.db.transaction(async tx=>{
    await assertWorkspaceRequestWrite(tx,actor);await assertWorkspaceProviderScope(tx,actor.tenantId);
    const owned=await ownedPayment(tx,actor,orderId);
    if(expected&&digest(owned)!==digest(expected))throw new HttpError(409,'RESOURCE_GRANT_CHANGED','The resource grant changed before the next case read.');
    return owned;
  });}

  async syncCase(actor:Actor,orderId:string,disputeId:string,signal?:AbortSignal){
    const owned=await this.currentRead(actor,orderId);
    const order=await this.orders.order(owned.providerOrderId,owned.entry,owned.customId,signal);
    if(order.captureIds.length!==1||order.captureIds[0]!==owned.captureId)throw new HttpError(409,'PAYMENT_SET_CHANGED','The owning order no longer has the expected single capture.');
    await this.currentRead(actor,orderId,owned);
    const observation=await this.disputes.get(disputeId,{captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'},signal);
    await this.db.transaction(async tx=>{
      await assertWorkspaceRequestWrite(tx,actor);
      await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[actor.tenantId]);
      if(digest(await ownedPayment(tx,actor,orderId))!==digest(owned))throw new HttpError(409,'RESOURCE_GRANT_CHANGED','The resource grant changed during the case read.');
      await projectDispute(tx,actor,owned,observation);
    });
    return{orderId,inventory:null,disputes:[observation]};
  }

  async syncOrder(actor: Actor, orderId: string, signal?: AbortSignal) {
    const owned = await this.currentRead(actor,orderId);
    const order = await this.orders.order(owned.providerOrderId, owned.entry, owned.customId, signal);
    if (order.captureIds.length !== 1 || order.captureIds[0] !== owned.captureId) throw new HttpError(409, 'PAYMENT_SET_CHANGED', 'The owning order no longer has the expected single capture.');
    const owner = { captureId: owned.captureId, amountMinor: owned.entry.amountMinor, currency: 'USD' as const };
    await this.currentRead(actor,orderId,owned);
    const inventory = await this.disputes.list(owner, signal);
    const observations: DisputeObservation[] = [];
    for (const id of inventory.ids){await this.currentRead(actor,orderId,owned);observations.push(await this.disputes.get(id, owner, signal));}
    await this.db.transaction(async tx => {
      await assertWorkspaceRequestWrite(tx,actor);
      await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE', [actor.tenantId]);
      const current = await ownedPayment(tx, actor, orderId);
      if (digest(current) !== digest(owned)) throw new HttpError(409, 'RESOURCE_GRANT_CHANGED', 'The resource grant changed during the provider read.');
      await tx.query(`INSERT INTO gh_dispute_inventories(tenant_id,capture_id,order_id,observed_at,body)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,capture_id) DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body`,
      [actor.tenantId,owned.captureId,orderId,inventory.observedAt,JSON.stringify(inventory)]);
      for (const observation of observations) await projectDispute(tx, actor, owned, observation);
    });
    return { orderId, inventory, disputes: observations };
  }

  async stored(actor: Actor, orderId: string): Promise<{ inventory: DisputeInventory | null; disputes: DisputeObservation[] }> {
    const owned = await ownedPayment(this.db, actor, orderId);
    const inventory = (await this.db.query<{ body: DisputeInventory }>('SELECT body FROM gh_dispute_inventories WHERE tenant_id=$1 AND capture_id=$2', [actor.tenantId,owned.captureId]))[0]?.body ?? null;
    const disputes = (await this.db.query<{ body: DisputeObservation }>("SELECT body FROM gh_provider_resources WHERE tenant_id=$1 AND order_id=$2 AND kind='dispute' AND active=true ORDER BY provider_id", [actor.tenantId,orderId])).map(row=>row.body);
    return { inventory, disputes };
  }
}

/** Call inside a transaction after locking the dataset. Observations never clear a different dimension. */
export async function projectDispute(tx: Database, actor: Actor, owned: OwnedPayment, observation: DisputeObservation, authority?: string|ConnectorAuthority) {
  const ownPlanId = typeof authority === 'string' ? authority : undefined;
  if(ownPlanId){
    const original=(await tx.query<{approved_by:string}>('SELECT approved_by FROM gh_recovery_runs WHERE tenant_id=$1 AND plan_id=$2',[actor.tenantId,ownPlanId]))[0];
    if(original?.approved_by!==actor.id)throw new HttpError(409,'ORIGINAL_RECOVERY_REQUIRED','The original approved recovery does not match this observation.');
  }else if (authority && typeof authority !== 'string') await requireObservationAuthority(tx,actor,authority);
  else await recoveryMember(tx, actor);
  if (observation.captureId !== owned.captureId || observation.grossAmountMinor !== owned.entry.amountMinor || owned.tenantId !== actor.tenantId) throw new HttpError(409, 'DISPUTE_BINDING_CONFLICT', 'The case is not bound to this owned capture.');
  const intended=(await tx.query<{capture_id:string;buyer_transaction_id:string;amount_minor:number}>('SELECT capture_id,buyer_transaction_id,amount_minor FROM gh_dispute_scenario_bindings WHERE tenant_id=$1 AND target_order_id=$2',[actor.tenantId,owned.orderId]))[0];
  if(intended&&(intended.capture_id!==observation.captureId||intended.buyer_transaction_id!==observation.buyerTransactionId||intended.amount_minor!==observation.grossAmountMinor))throw new HttpError(409,'SCENARIO_BUYER_BINDING_CONFLICT','The real provider case does not match the buyer transaction observed for this explicit scenario target.');
  const existing = (await tx.query<{ order_id: string; body: DisputeObservation }>("SELECT order_id,body FROM gh_provider_resources WHERE tenant_id=$1 AND kind='dispute' AND provider_id=$2", [actor.tenantId,observation.id]))[0];
  if (existing && existing.order_id !== owned.orderId) throw new HttpError(409, 'DISPUTE_BINDING_CONFLICT', 'This case is already bound to another order.');
  await tx.query('INSERT INTO gh_provider_observations(tenant_id,id,order_id,resource_id,kind,observed_at,body_hash,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING',
    [actor.tenantId,`dispute-${observation.id}-${observation.bodyHash.slice(0,16)}`,owned.orderId,observation.id,'dispute',observation.observedAt,observation.bodyHash,JSON.stringify(observation)]);
  if (existing && Date.parse(existing.body.updatedAt) > Date.parse(observation.updatedAt)) return;
  if (existing && Date.parse(existing.body.updatedAt) === Date.parse(observation.updatedAt) && Date.parse(existing.body.observedAt) > Date.parse(observation.observedAt)) return;
  if (existing?.body.status === 'RESOLVED' && observation.status !== 'RESOLVED' && Date.parse(observation.updatedAt) <= Date.parse(existing.body.updatedAt)) return;
  const dataset = await datasetFor(actor,tx), before=structuredClone(dataset);
  const capabilities = disputeCapabilities(observation);
  const baseEventId = `paypal:dispute:${observation.id}:${observation.bodyHash.slice(0,16)}:capabilities-v1:${digest(capabilities).slice(0,12)}`;
  const eventId = existing && existing.body.bodyHash !== observation.bodyHash && dataset.events.some(event=>event.id===baseEventId)
    ? `${baseEventId}:r${dataset.revision+1}` : baseEventId;
  if (!existing || existing.body.bodyHash !== observation.bodyHash) await tx.query(`INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body)
    VALUES($1,'dispute',$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,kind,provider_id)
    DO UPDATE SET version=gh_provider_resources.version+1,observed_at=excluded.observed_at,body=excluded.body`,
    [actor.tenantId,observation.id,owned.orderId,owned.runId,observation.observedAt,JSON.stringify(observation)]);
  else await tx.query("UPDATE gh_provider_resources SET observed_at=$3,body=$4::jsonb WHERE tenant_id=$1 AND kind='dispute' AND provider_id=$2",
    [actor.tenantId,observation.id,observation.observedAt,JSON.stringify(observation)]);
  if (dataset.events.some(event => event.id === eventId)) return;
  const order = dataset.orders.find(order=>order.id===owned.orderId);
  if (!order || order.captureId !== owned.captureId || order.disputeId && order.disputeId !== observation.id) throw new HttpError(409, 'DISPUTE_SET_UNSUPPORTED', 'This order has an unreviewed case relationship.');
  const revision = dataset.revision+1;
  const previous = dataset.events.filter(event=>event.orderId===order.id && event.dimension==='dispute').sort((a,b)=>b.revision-a.revision)[0];
  const knowledge = new Date(Math.max(Date.now(), Date.parse(observation.observedAt))).toISOString();
  const narrativeTime = previous?.narrativeTime ?? STORY_END;
  const event: SourceEvent = {
    id:eventId,tenantId:actor.tenantId,orderId:order.id,
    type:'dispute.observed',dimension:'dispute',state:observation.status.toLowerCase(),occurredAt:observation.updatedAt,
    ingestedAt:knowledge,narrativeTime,sourceClass:'sandbox',sourceLabel:'PayPal sandbox · independently read dispute',
    sourceRef:`paypal://sandbox/dispute/${observation.id}`,revision,
    payload:{disputeId:observation.id,captureId:owned.captureId,reason:observation.reason,stage:observation.stage,sellerResponseDueAt:observation.sellerResponseDueAt,
      amountMinor:observation.amountMinor,currency:observation.currency,receiptHash:observation.bodyHash,resourceVersion:order.resourceVersion+1,
      disputeCapabilities:capabilities,
      supersedesEventId:previous?.sourceClass==='sample'?previous.id:null,clockMapping:'Actual PayPal case timestamps are retained; the case maps to this incident order on the narrative clock.'},
  };
  appendStateObservation(dataset.intervals,event);
  dataset.events.push(event); dataset.revision=revision;
  order.disputeId=observation.id;order.disputeSource='sandbox';order.disputeState=event.state;
  order.disputeOpen=observation.status!=='RESOLVED';order.disputeDueAt=observation.sellerResponseDueAt;order.resourceVersion++;
  dataset.evidence.push({id:`evidence:${event.id}`,tenantId:actor.tenantId,orderId:order.id,title:`${order.reference} · PayPal dispute ${observation.status.toLowerCase().replaceAll('_',' ')}`,
    excerpt:`A merchant read linked this case to the exact ${owned.entry.amountMinor/100} USD captured payment. ${observation.sellerResponseDueAt?'The response deadline is the provider value.':'PayPal did not supply a response deadline.'} Evidence submission is separate from the case outcome.`,
    sourceClass:'sandbox',sourceLabel:event.sourceLabel,occurredAt:narrativeTime,ingestedAt:knowledge,kind:'dispute',supports:[event.id],contradicts:[]});
  await persistDataset(tx,dataset);
  if (ownPlanId) {
    await tx.query("UPDATE gh_recovery_runs SET accepted_revision=$3,accepted_resources=jsonb_set(accepted_resources,ARRAY[$4]::text[],to_jsonb($5::integer)),updated_at=now() WHERE tenant_id=$1 AND plan_id=$2 AND accepted_revision=$6", [actor.tenantId,ownPlanId,revision,order.id,order.resourceVersion,revision-1]);
  }
  await recordFindingSourceChange(tx,actor,before,dataset,{kind:'dispute_observation',reason:'An independent case observation changed the source evidence.',sourceId:event.id,ownPlanId});
  if(!await hasFindingsSchema(tx))await tx.query("UPDATE gh_plans SET status='stale',body=jsonb_set(jsonb_set(body,'{status}','\"stale\"'::jsonb),'{staleReason}','\"An independent PayPal case observation changed the evidence.\"'::jsonb) WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved') AND id<>$2", [actor.tenantId,ownPlanId??'']);
  await audit(tx,actor,'dispute.observed',`${order.reference} · ${observation.status.toLowerCase().replaceAll('_',' ')} observed from PayPal`,observation.id,
    {orderId:order.id,source:'sandbox',transport:'typed_rest',bodyHash:observation.bodyHash,stage:observation.stage,sellerResponseDueAt:observation.sellerResponseDueAt});
}
