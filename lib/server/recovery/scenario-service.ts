import type { Database } from '@/packages/db/client';
import type { Actor } from '@/packages/domain/types';
import { buildSnapshot } from '@/packages/domain/temporal';
import { STORY_END } from '@/packages/domain/seed';
import { reviseDisputeScenario } from '@/packages/domain/scenario';
import { digest } from '@/packages/payments/security';
import { audit, datasetFor, persistDataset } from '../repository';
import { HttpError } from '../errors';
import { ownedPayment, recoveryMember, type OwnedPayment } from './authority';
import type { DisputesGateway } from './disputes';
import type { OrderEvidenceGateway } from '../payments/evidence';

export interface ScenarioRequest {
  revisionId: string;
  pairs: Array<{originalReference:string;targetReference:string;buyerTransactionId:string;amountMinor:number}>;
}
export class ScenarioService {
  constructor(private readonly db:Database,private readonly disputes:Pick<DisputesGateway,'list'>,private readonly orders:Pick<OrderEvidenceGateway,'order'>){}
  async revise(actor:Actor,request:ScenarioRequest) {
    await recoveryMember(this.db,actor,true);
    if(!/^[a-z0-9-]{1,80}$/.test(request.revisionId)||request.pairs.length!==4||request.pairs.some(pair=>
      !/^FW-\d{6}$/.test(pair.originalReference)||!/^FW-\d{6}$/.test(pair.targetReference)||!/^[A-Z0-9]{17}$/.test(pair.buyerTransactionId)||!Number.isSafeInteger(pair.amountMinor)||pair.amountMinor<=0)||
      new Set(request.pairs.map(pair=>pair.buyerTransactionId)).size!==4)throw new HttpError(400,'INVALID_SCENARIO_REVISION','Four exact owned references, buyer transaction IDs and integer amounts are required.');
    const requestHash=digest(request);
    const existing=(await this.db.query<{payload_hash:string;body:Record<string,unknown>}>('SELECT payload_hash,body FROM gh_scenario_revisions WHERE tenant_id=$1 AND id=$2',[actor.tenantId,request.revisionId]))[0];
    if(existing){if(existing.payload_hash!==requestHash)throw new HttpError(409,'SCENARIO_REVISION_CONFLICT','This revision identity already binds a different immutable mapping.');return existing.body;}
    const dataset=await datasetFor(actor,this.db);
    const reads:Array<{original:OwnedPayment;target:OwnedPayment;buyerTransactionId:string;originalReference:string;targetReference:string;amountMinor:number}>=[];
    const providerReads:Array<Record<string,unknown>>=[];
    for(const pair of request.pairs){
      const originalOrder=dataset.orders.find(order=>order.reference===pair.originalReference),targetOrder=dataset.orders.find(order=>order.reference===pair.targetReference);
      if(!originalOrder||!targetOrder)throw new HttpError(404,'ORDER_NOT_FOUND','A scenario reference is not in this workspace.');
      const original=await ownedPayment(this.db,actor,originalOrder.id),target=await ownedPayment(this.db,actor,targetOrder.id);
      if(original.entry.amountMinor!==pair.amountMinor||target.entry.amountMinor!==pair.amountMinor||original.entry.currency!=='USD'||target.entry.currency!=='USD'||pair.buyerTransactionId===target.captureId)throw new HttpError(409,'SCENARIO_PAYMENT_MISMATCH','The two purchases must retain their distinct identities and exact same USD amount.');
      for(const owned of [original,target]){
        const signal=AbortSignal.timeout(25_000);
        const proof=await this.orders.order(owned.providerOrderId,owned.entry,owned.customId,signal);
        if(proof.captureIds.length!==1||proof.captureIds[0]!==owned.captureId||proof.refundIds.length||proof.trackers.length)throw new HttpError(409,'PAYMENT_SET_CHANGED','The original independently owned capture or recovery evidence changed.');
        const inventory=await this.disputes.list({captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'},signal);
        if(!inventory.complete||inventory.ids.length)throw new HttpError(409,'EXISTING_CASE_PREVENTS_REVISION','A real provider case or incomplete inventory prevents revising this fixture intention.');
        providerReads.push({orderId:owned.orderId,providerOrderId:owned.providerOrderId,captureId:owned.captureId,orderObservedAt:proof.observedAt,orderBodyHash:proof.bodyHash,inventory});
      }
      reads.push({...pair,original,target});
    }
    return this.db.transaction(async tx=>{
      await recoveryMember(tx,actor,true);
      await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[actor.tenantId]);
      const current=await datasetFor(actor,tx);
      if(current.revision!==dataset.revision)throw new HttpError(409,'EVIDENCE_CHANGED','New evidence arrived during the scenario review.');
      const active=(await tx.query("SELECT id FROM gh_recovery_intents WHERE tenant_id=$1 LIMIT 1",[actor.tenantId]));
      if(active.length)throw new HttpError(409,'RECOVERY_ALREADY_EXISTS','A durable recovery intent prevents changing this synthetic scenario.');
      for(const pair of reads)for(const proof of [pair.original,pair.target])if(digest(await ownedPayment(tx,actor,proof.orderId))!==digest(proof))throw new HttpError(409,'RESOURCE_GRANT_CHANGED','A payment grant changed during the scenario review.');
      const observedAt=new Date().toISOString();
      const previousKnownAt=current.events.reduce((latest,event)=>event.ingestedAt>latest?event.ingestedAt:latest,STORY_END);
      const before=buildSnapshot(current,{knownAt:previousKnownAt,asOf:STORY_END});
      const revised=reviseDisputeScenario(current,reads.map(pair=>({originalOrderId:pair.original.orderId,targetOrderId:pair.target.orderId})),request.revisionId,observedAt);
      const after=buildSnapshot(revised,{knownAt:observedAt,asOf:STORY_END});
      const body={revisionId:request.revisionId,observedAt,source:'fixture_shipping',classification:'explicit_synthetic_scenario_revision',
        statement:'No payment identities, capture receipts or original source events were rewritten. These are intended case targets; no provider case is implied.',
        previousRevision:current.revision,revision:revised.revision,previousKnownAt,beforeSnapshotHash:before.hash,afterSnapshotHash:after.hash,
        groups:{delivered:9,disputedIntentions:4,eligible:38,grace:12},counts:{orders:after.orders.length,incident:after.branches[0].trackingCount,affected:after.totals.affected,refunds:after.branches[0].eligibleCount,refundTotalMinor:after.branches[0].refundTotalMinor,actions:after.branches[0].actions.length},
        providerReads,
        pairs:reads.map(pair=>({originalReference:pair.originalReference,originalOrderId:pair.original.orderId,originalProviderOrderId:pair.original.providerOrderId,originalCaptureId:pair.original.captureId,
          targetReference:pair.targetReference,targetOrderId:pair.target.orderId,targetProviderOrderId:pair.target.providerOrderId,targetCaptureId:pair.target.captureId,buyerTransactionId:pair.buyerTransactionId,amountMinor:pair.amountMinor,currency:'USD',status:'intended'}))};
      await persistDataset(tx,revised);
      await tx.query('INSERT INTO gh_scenario_revisions(tenant_id,id,payload_hash,actor_id,observed_at,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[actor.tenantId,request.revisionId,requestHash,actor.id,observedAt,JSON.stringify(body)]);
      for(const pair of body.pairs)await tx.query('INSERT INTO gh_dispute_scenario_bindings(tenant_id,revision_id,original_order_id,target_order_id,capture_id,buyer_transaction_id,amount_minor,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[actor.tenantId,request.revisionId,pair.originalOrderId,pair.targetOrderId,pair.targetCaptureId,pair.buyerTransactionId,pair.amountMinor,JSON.stringify(pair)]);
      await tx.query("UPDATE gh_plans SET status='stale',body=jsonb_set(jsonb_set(body,'{status}','\"stale\"'::jsonb),'{staleReason}','\"An explicitly authorized synthetic scenario revision changed the four intended case targets. Review a new exact plan.\"'::jsonb) WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved')",[actor.tenantId]);
      await audit(tx,actor,'fixture.scenario_revised','Four uncreated case intentions moved to explicitly reviewed same-amount sandbox purchases',request.revisionId,body);
      return body;
    });
  }
}
