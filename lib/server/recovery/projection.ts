import {recordFindingSourceChange} from '../findings/sources';
import {hasFindingsSchema} from '../findings/schema';
import type { Database } from '@/packages/db/client';
import type { Actor, SeedDataset, SourceEvent } from '@/packages/domain/types';
import { appendStateObservation, STORY_END } from '@/packages/domain/seed';
import { digest } from '@/packages/payments/security';
import { HttpError } from '../errors';
import { audit, datasetFor } from '../repository';
import type { RecoveryIntent } from './contracts';
import type { RefundObservation, TrackingObservation } from './evidence';

export async function persistObservation(tx:Database,dataset:SeedDataset,event:SourceEvent,previousIds:Set<string>){
  await tx.query('UPDATE gh_datasets SET revision=$2,body=$3::jsonb,updated_at=now() WHERE tenant_id=$1',[dataset.tenantId,dataset.revision,JSON.stringify(dataset)]);
  await tx.query('INSERT INTO gh_source_events(tenant_id,id,order_id,occurred_at,ingested_at,source_class,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',[dataset.tenantId,event.id,event.orderId,event.occurredAt,event.ingestedAt,event.sourceClass,JSON.stringify(event)]);
  const changed=dataset.intervals.filter(interval=>previousIds.has(interval.id)||interval.sourceEventId===event.id||[...previousIds].some(id=>interval.id===`${id}:until:${event.id}`));
  for(const interval of changed)await tx.query(`INSERT INTO gh_state_intervals(tenant_id,id,order_id,dimension,state,valid_from,valid_to,knowledge_from,knowledge_to,clock_domain,source_class,source_event_id,revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,id) DO UPDATE SET knowledge_to=excluded.knowledge_to`,
    [dataset.tenantId,interval.id,interval.orderId,interval.dimension,interval.state,interval.validFrom,interval.validTo,interval.knowledgeFrom,interval.knowledgeTo,interval.clockDomain,interval.sourceClass,interval.sourceEventId,interval.revision]);
}

export async function projectRecoveryResult(db:Database,intent:RecoveryIntent,observation:RefundObservation|TrackingObservation){
  const command=intent.command;
  const actor:Actor={tenantId:intent.tenant_id,id:command.actorId,membershipVersion:command.membershipVersion,role:'operator'};
  await db.transaction(async tx=>{
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[intent.tenant_id]);
    const original=(await tx.query<RecoveryIntent>('SELECT * FROM gh_recovery_intents WHERE tenant_id=$1 AND id=$2',[intent.tenant_id,intent.id]))[0];
    if(!original||original.payload_hash!==digest(command)||observation.orderId!==command.owned.providerOrderId||observation.captureId!==command.owned.captureId)throw new HttpError(409,'ORIGINAL_RECEIPT_REQUIRED','The provider result does not match the original recovery intent.');
    const refund=intent.kind==='refund';
    if(refund&&(!('amountMinor' in observation)||observation.status!=='COMPLETED'||observation.amountMinor!==command.action.amountMinor||observation.customId!==command.operationId)||
      !refund&&(!('trackingNumber' in observation)||observation.status!=='SHIPPED'||observation.trackingNumber!==command.tracking?.trackingNumber||observation.carrierName!==command.tracking?.carrierName))throw new HttpError(409,'RESULT_UNCONFIRMED','The exact approved outcome has not been independently confirmed.');
    const dataset=await datasetFor(actor,tx),before=structuredClone(dataset);const order=dataset.orders.find(order=>order.id===intent.order_id);
    if(!order||order.captureId!==observation.captureId||order.paypalOrderId!==observation.orderId)throw new HttpError(409,'RESOURCE_BINDING_CHANGED','The observed result belongs to a different payment.');
    const eventId=`paypal:${refund?'refund':'tracking'}:${observation.orderId}:${observation.id}`;
    if(dataset.events.some(event=>event.id===eventId))return;
    const priorRevision=dataset.revision;const revision=priorRevision+1;
    const knowledge=new Date(Math.max(Date.now(),Date.parse(observation.observedAt))).toISOString();
    const previous=dataset.intervals.filter(interval=>interval.orderId===order.id&&interval.dimension==='remediation'&&interval.validTo===null&&interval.knowledgeTo===null);
    const previousIds=new Set(previous.map(interval=>interval.id));
    const previousState=previous[0]?.state??'none';
    const event:SourceEvent={id:eventId,tenantId:intent.tenant_id,orderId:order.id,type:refund?'remediation.refunded':'remediation.tracking_added',dimension:'remediation',
      state:refund?'refunded':['refunded','credited'].includes(previousState)?previousState:'tracking_added',
      occurredAt:observation.occurredAt??observation.observedAt,ingestedAt:knowledge,narrativeTime:STORY_END,sourceClass:'sandbox',
      sourceLabel:refund?'PayPal sandbox · independently verified refund':'PayPal sandbox · fixture tracking assignment verified',
      sourceRef:refund?`paypal://sandbox/refund/${observation.id}`:`paypal://sandbox/order/${observation.orderId}/tracker/${observation.id}`,revision,
      payload:{operationId:intent.id,planId:intent.plan_id,providerResourceId:observation.id,receiptHash:observation.bodyHash,resourceVersion:order.resourceVersion+1,
        actualProviderTime:observation.occurredAt,clockMapping:'Actual receipt time is retained; the recovery is mapped to the incident decision point on the narrative clock.',
        ...(refund?{amountMinor:(observation as RefundObservation).amountMinor,currency:'USD',refundId:observation.id}:{trackingInPayPal:true,trackingId:observation.id,fixtureShipping:true,fieldVerification:'approved_request_and_returned_identity'})}};
    appendStateObservation(dataset.intervals,event);dataset.events.push(event);dataset.revision=revision;order.resourceVersion++;
    if(refund){order.refundedMinor+=(observation as RefundObservation).amountMinor;order.refundableMinor=Math.max(0,order.amountMinor-order.refundedMinor);}else order.trackingInPayPal=true;
    dataset.evidence.push({id:`evidence:${eventId}`,tenantId:intent.tenant_id,orderId:order.id,
      title:`${order.reference} · ${refund?'$5 goodwill refund verified':'tracking assignment verified'}`,
      excerpt:refund?'A separate PayPal read confirmed the exact approved refund. Delivery and dispute status remain independent.':'PayPal returned a tracker identity and a separate owning-order read confirmed that assignment. The tracking number and carrier came from the approved synthetic shipment; no physical delivery is asserted.',
      sourceClass:'sandbox',sourceLabel:event.sourceLabel,occurredAt:STORY_END,ingestedAt:knowledge,kind:refund?'payment':'shipment',supports:[eventId],contradicts:[]});
    await persistObservation(tx,dataset,event,previousIds);
    await tx.query('INSERT INTO gh_provider_observations(tenant_id,id,order_id,resource_id,kind,observed_at,body_hash,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING',
      [intent.tenant_id,eventId,order.id,observation.id,refund?'refund':'tracking',observation.observedAt,observation.bodyHash,JSON.stringify(observation)]);
    if(refund)await tx.query(`INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body) VALUES($1,'refund',$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(tenant_id,kind,provider_id) DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body`,[intent.tenant_id,observation.id,order.id,command.owned.runId,observation.observedAt,JSON.stringify(observation)]);
    // Only a receipt on the already accepted revision can advance this execution's authority.
    await tx.query("UPDATE gh_recovery_runs SET accepted_revision=$3,accepted_resources=jsonb_set(accepted_resources,ARRAY[$4]::text[],to_jsonb($5::integer)),updated_at=now() WHERE tenant_id=$1 AND plan_id=$2 AND accepted_revision=$6",
      [intent.tenant_id,intent.plan_id,revision,order.id,order.resourceVersion,priorRevision]);
    await recordFindingSourceChange(tx,actor,before,dataset,{kind:'original_recovery_receipt',reason:'An independent recovery observation changed the available actions.',sourceId:event.id,ownPlanId:intent.plan_id});
    if(!await hasFindingsSchema(tx))await tx.query("UPDATE gh_plans SET status='stale',body=jsonb_set(jsonb_set(body,'{status}','\"stale\"'::jsonb),'{staleReason}','\"An independent recovery receipt changed the evidence.\"'::jsonb) WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved') AND id<>$2",[intent.tenant_id,intent.plan_id]);
    await audit(tx,actor,refund?'recovery.refund_verified':'recovery.tracking_verified',`${order.reference} · ${refund?'$5 refund':'fixture tracking assignment'} independently verified`,intent.id,
      {planId:intent.plan_id,providerId:observation.id,source:'sandbox',shippingSource:refund?null:'fixture_shipping',transport:'apimatic_sdk',receiptHash:observation.bodyHash});
  });
}

/** A new knowledge-time review leaves previously exported snapshots and receipts intact. */
export async function projectRecoveryReview(db: Database, intent: RecoveryIntent, observedAt: string) {
  await db.transaction(async tx => {
    await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE', [intent.tenant_id]);
    const original = (await tx.query<RecoveryIntent>('SELECT * FROM gh_recovery_intents WHERE tenant_id=$1 AND id=$2', [intent.tenant_id,intent.id]))[0];
    if (!original || original.payload_hash !== digest(intent.command)) throw new HttpError(409,'ORIGINAL_RECEIPT_REQUIRED','The original recovery intent changed during its status check.');
    const actor: Actor = { tenantId:intent.tenant_id,id:intent.command.actorId,membershipVersion:intent.command.membershipVersion,role:'operator' };
    const dataset = await datasetFor(actor,tx), before=structuredClone(dataset), order = dataset.orders.find(row => row.id === intent.order_id);
    if (!order || order.captureId !== intent.command.owned.captureId) throw new HttpError(409,'RESOURCE_BINDING_CHANGED','The status check no longer belongs to this payment.');
    const id = `paypal:recovery-review:${order.id}:v1`;
    if (dataset.events.some(event => event.id === id)) return;
    const priorRevision = dataset.revision;
    const event: SourceEvent = { id,tenantId:intent.tenant_id,orderId:order.id,type:'recovery.capabilities_observed',dimension:'remediation',state:'reviewed',
      occurredAt:observedAt,ingestedAt:new Date(Math.max(Date.now(),Date.parse(observedAt))).toISOString(),narrativeTime:STORY_END,sourceClass:'sandbox',
      sourceLabel:'PayPal sandbox · independent recovery review',sourceRef:`paypal://sandbox/order/${intent.command.owned.providerOrderId}`,revision:priorRevision+1,
      payload:{version:1,operationId:intent.id,resourceVersion:order.resourceVersion+1,meaning:'New proposals exclude an already verified tracking assignment. Original receipts and case outcomes remain separate.'} };
    dataset.events.push(event);dataset.revision++;order.resourceVersion++;
    await persistObservation(tx,dataset,event,new Set());
    await tx.query("UPDATE gh_recovery_runs SET accepted_revision=$3,accepted_resources=jsonb_set(accepted_resources,ARRAY[$4]::text[],to_jsonb($5::integer)),updated_at=now() WHERE tenant_id=$1 AND plan_id=$2 AND accepted_revision=$6",
      [intent.tenant_id,intent.plan_id,dataset.revision,order.id,order.resourceVersion,priorRevision]);
    await recordFindingSourceChange(tx,actor,before,dataset,{kind:'recovery_status_review',reason:'An independent recovery observation changed the available actions.',sourceId:event.id,ownPlanId:intent.plan_id});
    if(!await hasFindingsSchema(tx))await tx.query("UPDATE gh_plans SET status='stale',body=jsonb_set(jsonb_set(body,'{status}','\"stale\"'::jsonb),'{staleReason}','\"An independent status review changed available recovery actions.\"'::jsonb) WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved') AND id<>$2",[intent.tenant_id,intent.plan_id]);
    await audit(tx,actor,'recovery.status_reviewed',`${order.reference} · original provider result checked`,intent.id,{source:'sandbox',readOnly:true});
  });
}
