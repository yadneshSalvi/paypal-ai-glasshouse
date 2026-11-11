import { appendStateObservation, STORY_END } from './seed';
import { buildSnapshot, stableHash } from './temporal';
import type { Order, SeedDataset, SourceEvent } from './types';

export interface ScenarioPair { originalOrderId: string; targetOrderId: string }
export interface FixtureProfile {
  incidentMember: boolean; seedGroup: Order['seedGroup']; region: string; regionCode: string;
  promisedAt: string; carrier: string; supportContacts: number;
}
export function fixtureProfile(value: unknown): FixtureProfile | null {
  if (!value || typeof value !== 'object') return null;
  const profile = value as Record<string,unknown>;
  if (typeof profile.incidentMember !== 'boolean' || !['context','disputed'].includes(String(profile.seedGroup)) ||
    !['PNW','SW','MW','NE','SE'].includes(String(profile.regionCode)) || typeof profile.region !== 'string' ||
    typeof profile.promisedAt !== 'string' || !Number.isFinite(Date.parse(profile.promisedAt)) ||
    typeof profile.carrier !== 'string' || !profile.carrier.endsWith('(fixture)') ||
    !Number.isSafeInteger(profile.supportContacts) || Number(profile.supportContacts)<0) return null;
  return {incidentMember:profile.incidentMember,seedGroup:profile.seedGroup as Order['seedGroup'],region:profile.region,
    regionCode:String(profile.regionCode),promisedAt:profile.promisedAt,carrier:profile.carrier,supportContacts:Number(profile.supportContacts)};
}

/** An explicit new fixture observation. Original payments, source events and past knowledge remain intact. */
export function reviseDisputeScenario(dataset: SeedDataset, pairs: readonly ScenarioPair[], revisionId: string, observedAt: string): SeedDataset {
  if (!/^[a-z0-9-]{1,80}$/.test(revisionId) || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt)<=Date.parse(STORY_END)) throw new Error('A valid revision identity and later observation time are required.');
  const marker=`fixture:scenario:${revisionId}`;
  if (dataset.events.some(event=>event.id.startsWith(`${marker}:`))) throw new Error('This scenario revision already exists.');
  if (pairs.length!==4 || new Set(pairs.flatMap(pair=>[pair.originalOrderId,pair.targetOrderId])).size!==8) throw new Error('Exactly four distinct original and target orders are required.');
  const current=buildSnapshot(dataset,{knownAt:observedAt,asOf:STORY_END});
  const revised=structuredClone(dataset),revision=dataset.revision+1;
  const profile=(order:Order):FixtureProfile=>({incidentMember:order.incidentMember,seedGroup:order.seedGroup,region:order.region,regionCode:order.regionCode,promisedAt:order.promisedAt,carrier:order.carrier,supportContacts:order.supportContacts});
  const added:SourceEvent[]=[];
  for (const pair of pairs) {
    const original=current.orders.find(order=>order.id===pair.originalOrderId),target=current.orders.find(order=>order.id===pair.targetOrderId);
    if (!original || !target || original.seedGroup!=='disputed' || !original.incidentMember || target.seedGroup!=='context' || target.incidentMember ||
      original.currency!=='USD' || target.currency!=='USD' || original.amountMinor!==target.amountMinor ||
      original.disputeSource==='sandbox' || target.disputeSource==='sandbox' || target.disputeOpen ||
      original.refundedMinor!==0 || target.refundedMinor!==0 || original.trackingInPayPal || target.trackingInPayPal ||
      !['delivered','in_transit','shipped'].includes(target.fulfillmentState)) throw new Error('Only matching, unused fixture case targets can be revised.');
    for (const [order,replacement,state,disputeState] of [[original,profile(target),target.fulfillmentState,'none'],[target,profile(original),'delayed','open']] as const) {
      const record=revised.orders.find(value=>value.id===order.id)!;
      const resourceVersion=record.resourceVersion+1;
      const common={tenantId:dataset.tenantId,orderId:order.id,occurredAt:observedAt,ingestedAt:observedAt,narrativeTime:STORY_END,
        sourceLabel:'Explicit synthetic shipping scenario revision',sourceRef:`fixture://scenario/${revisionId}/${order.id}`,revision};
      const shipment:SourceEvent={...common,id:`${marker}:${order.id}:fulfillment`,type:`fulfillment.${state}`,dimension:'fulfillment',state,sourceClass:'fixture_shipping',
        payload:{fixtureProfile:replacement,resourceVersion,fixtureShipping:true,scenarioRevisionId:revisionId,originalOrderId:pair.originalOrderId,targetOrderId:pair.targetOrderId,
          shipmentRef:record.shipmentRef,trackingNumber:record.trackingNumber,carrier:replacement.carrier,
          statement:'Synthetic scenario revision only. No physical shipment, delivery or payment change is asserted.'}};
      const dispute:SourceEvent={...common,id:`${marker}:${order.id}:dispute`,type:`dispute.${disputeState}`,dimension:'dispute',state:disputeState,sourceClass:'sample',
        payload:{resourceVersion,scenarioRevisionId:revisionId,simulated:true,providerDisputeId:null,sellerResponseDueAt:null,
          statement:disputeState==='open'?'Intended controlled sandbox case; no provider case exists yet.':'The uncreated Sample case intention moved to the recorded target order.'}};
      for(const event of [shipment,dispute]){appendStateObservation(revised.intervals,event);revised.events.push(event);added.push(event);}
      record.resourceVersion=resourceVersion;
      for (const [event,kind] of [[shipment,'shipment'],[dispute,'dispute']] as const) revised.evidence.push({id:`evidence:${event.id}`,tenantId:dataset.tenantId,orderId:order.id,kind,
        title:`${order.reference} · explicit ${kind} fixture revision`,excerpt:String(event.payload.statement),sourceClass:event.sourceClass,sourceLabel:event.sourceLabel,
        occurredAt:STORY_END,ingestedAt:observedAt,supports:[event.id],contradicts:dataset.events.filter(value=>value.orderId===order.id&&value.dimension===event.dimension).map(value=>value.id)});
    }
  }
  revised.revision=revision;
  revised.evidence.unshift({id:`evidence:${marker}`,tenantId:dataset.tenantId,orderId:null,kind:'finding',title:'Four controlled case targets revised; payments unchanged',
    excerpt:`The authorized synthetic scenario revision ${revisionId} changes four uncreated case intentions to four same-amount owned purchases. All 600 payment identities remain unchanged. The incident remains 63 orders: nine delivered, four disputed intentions, 38 eligible and 12 in grace. This is a fixture revision, not new physical shipping evidence.`,
    sourceClass:'fixture_shipping',sourceLabel:'Explicit synthetic shipping scenario revision',occurredAt:STORY_END,ingestedAt:observedAt,supports:added.map(event=>event.id),contradicts:[]});
  const after=buildSnapshot(revised,{knownAt:observedAt,asOf:STORY_END});
  const beforeMoney=dataset.orders.map(({id,reference,amountMinor,currency,captureId,paypalOrderId})=>({id,reference,amountMinor,currency,captureId,paypalOrderId}));
  const afterMoney=revised.orders.map(({id,reference,amountMinor,currency,captureId,paypalOrderId})=>({id,reference,amountMinor,currency,captureId,paypalOrderId}));
  const groups=Object.fromEntries(['delivered_revision','disputed','eligible','grace'].map(group=>[group,after.orders.filter(order=>order.incidentMember&&order.seedGroup===group).length]));
  if(stableHash(beforeMoney)!==stableHash(afterMoney)||after.orders.length!==600||after.branches[0].trackingCount!==63||after.branches[0].eligibleCount!==38||after.branches[1].eligibleCount!==50||
    after.branches[0].disputeCount!==4||groups.delivered_revision!==9||groups.disputed!==4||groups.eligible!==38||groups.grace!==12)throw new Error('The scenario revision did not preserve the reviewed cohort and payment invariants.');
  return revised;
}
