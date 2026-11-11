import { randomUUID } from 'node:crypto';
import { PaymentError, ProviderError } from '@fracture/paypal-core';
import type { Database } from '@/packages/db/client';
import { digest, type PaymentSecrets } from '@/packages/payments/security';
import { HttpError } from '../errors';
import { ownedPaymentResource, type OwnedPayment } from '../recovery/authority';
import type { RecoveryExecutor, RecoveryCheck } from '../recovery/execution';
import type { RecoveryEvidenceGateway } from '../recovery/evidence';
import type { DisputesGateway } from '../recovery/disputes';
import { projectDispute } from '../recovery/dispute-service';
import { requireConnector, connectorActor, type ObservationConnector } from './connector';
import type { ObservationJob } from './service';
import { projectCapacity } from './projection';
import { parseWebhook } from './webhook';

interface Options {
  db:Database; secrets:PaymentSecrets; connector:ObservationConnector|null; recovery:Pick<RecoveryExecutor,'reconcileOnly'>;
  evidence:Pick<RecoveryEvidenceGateway,'capacity'>; disputes:Pick<DisputesGateway,'get'>;
}
interface WorkResult {
  outcome:'complete'|'retry'|'attention'; reason:string|null; checks:RecoveryCheck[];
  observation?:{kind:string;resourceId:string;bodyHash:string;observedAt:string;status:string};
}
const reasonFor = (error: unknown) => error instanceof HttpError || error instanceof PaymentError || error instanceof ProviderError
  ? error.message : 'The independent provider read could not finish. The original operation was not resent.';
const terminal = new Set(['CONNECTOR_BINDING_CHANGED','RESOURCE_OUTSIDE_CONNECTOR','EVENT_RESOURCE_CONFLICT','EVENT_RESOURCE_MISMATCH','DISPUTE_BINDING_CONFLICT','SCENARIO_BUYER_BINDING_CONFLICT','DISPUTE_SET_UNSUPPORTED']);

/** This worker deliberately receives read capabilities only. It cannot call the write worker. */
export class ObservationWorker {
  constructor(readonly options: Options) {}
  private get db() { return this.options.db; }

  private async claim(tenantId?: string, jobId?: string): Promise<ObservationJob|null> {
    return this.db.transaction(async tx => {
      const values:unknown[] = [], filters:string[] = [];
      if (tenantId) { values.push(tenantId);filters.push(`tenant_id=$${values.length}`); }
      if (jobId) { values.push(jobId);filters.push(`id=$${values.length}`); }
      const job = (await tx.query<ObservationJob>(`SELECT * FROM gh_observation_jobs WHERE next_attempt_at<=now()
        AND (state IN ('queued','retry') OR state='running' AND lease_until<now()) AND (lease_until IS NULL OR lease_until<now())
        ${filters.length?' AND '+filters.join(' AND '):''} ORDER BY next_attempt_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,values))[0];
      if (!job) return null;
      return (await tx.query<ObservationJob>("UPDATE gh_observation_jobs SET state='running',attempts=attempts+1,lease_owner=$3,lease_until=now()+interval '180 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",[job.tenant_id,job.id,randomUUID()]))[0];
    });
  }

  private async owned(job: ObservationJob, connector: ObservationConnector): Promise<OwnedPayment> {
    const hint = job.subject.hint;
    if (!hint?.supported || !hint.primary || !hint.resources.length || hint.resources.length > 10) throw new HttpError(409,'EVENT_RESOURCE_MISMATCH','The verified event has no supported owned-resource hint.');
    const orderIds = new Set<string>();
    for (const resource of hint.resources) {
      const grants = await this.db.query<{tenant_id:string;order_id:string}>('SELECT tenant_id,order_id FROM gh_provider_resources WHERE kind=$1 AND provider_id=$2 AND active=true',[resource.kind,resource.id]);
      if (grants.some(grant => grant.tenant_id !== connector.tenantId)) throw new HttpError(403,'RESOURCE_OUTSIDE_CONNECTOR','A notified resource belongs outside this connector. No provider read was authorized.');
      for (const grant of grants) orderIds.add(grant.order_id);
    }
    if (!orderIds.size) throw new HttpError(409,'RESOURCE_ACKNOWLEDGEMENT_PENDING','The original owned-resource acknowledgement has not arrived. The event is saved and no resource read has started.');
    if (orderIds.size !== 1) throw new HttpError(409,'EVENT_RESOURCE_CONFLICT','The notified resources do not belong to one original owned order.');
    const owned = await ownedPaymentResource(this.db,connector.tenantId,[...orderIds][0]);
    for (const resource of hint.resources) if (resource.kind === 'order' && resource.id !== owned.providerOrderId || resource.kind === 'capture' && resource.id !== owned.captureId) {
      throw new HttpError(409,'EVENT_RESOURCE_MISMATCH','The event relation does not match the exact independently owned payment.');
    }
    return owned;
  }

  private async resource(job: ObservationJob, signal: AbortSignal): Promise<WorkResult> {
    const connector = this.options.connector;
    if (!connector || connector.id !== job.connector_id || connector.tenantId !== job.tenant_id || connector.configHash !== job.subject.configHash) {
      throw new HttpError(409,'CONNECTOR_BINDING_CHANGED','This saved event needs the same active isolated merchant binding before it can be read.');
    }
    await requireConnector(this.db,connector);
    const canonical = (await this.db.query<{raw_hash:string;event_type:string;private_document:string}>('SELECT raw_hash,event_type,private_document FROM gh_webhook_events WHERE connector_id=$1 AND event_id=$2 AND tenant_id=$3',[connector.id,job.event_id,job.tenant_id]))[0];
    if (!canonical || canonical.event_type !== job.subject.hint?.eventType || job.subject.hint.eventId !== job.event_id) throw new HttpError(409,'EVENT_RESOURCE_MISMATCH','The canonical verified event is unavailable.');
    const envelope = this.options.secrets.open<{rawBody:string}>(canonical.private_document,`webhook-event:${connector.id}:${job.event_id}`);
    if (digest(envelope.rawBody) !== canonical.raw_hash || digest(parseWebhook(envelope.rawBody)) !== digest(job.subject.hint)) throw new HttpError(409,'EVENT_RESOURCE_MISMATCH','The queued resource hint no longer matches the verified event bytes.');
    const owned = await this.owned(job,connector), primary = job.subject.hint!.primary!;
    let observation: NonNullable<WorkResult['observation']>;
    if (primary.kind === 'dispute') {
      const value = await this.options.disputes.get(primary.id,{captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'},signal);
      await this.db.transaction(async tx => {
        await tx.query('SELECT tenant_id FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[job.tenant_id]);
        if (digest(await ownedPaymentResource(tx,job.tenant_id,owned.orderId)) !== digest(owned)) throw new HttpError(409,'RESOURCE_GRANT_CHANGED','The owned payment changed during the independent case read.');
        await projectDispute(tx,connectorActor(connector),owned,value,{kind:'connector',connector});
      });
      observation = {kind:'dispute',resourceId:value.id,bodyHash:value.bodyHash,observedAt:value.observedAt,status:value.status};
    } else {
      const value = await this.options.evidence.capacity(owned,signal);
      if (primary.kind === 'refund' && !value.refundIds.includes(primary.id)) throw new HttpError(409,'REFUND_ACKNOWLEDGEMENT_PENDING','The notified refund is not yet present in the complete owned-order read.');
      await projectCapacity(this.db,connector,owned,value);
      observation = {kind:'capture_capacity',resourceId:owned.captureId,bodyHash:value.bodyHash,observedAt:value.observedAt,status:value.status};
    }
    const originals = await this.db.query<{id:string;kind:string;provider_id:string|null}>(`SELECT id,kind,provider_id FROM gh_recovery_intents WHERE tenant_id=$1 AND order_id=$2
      AND status NOT IN ('queued','claimed','blocked','provider_failed') ORDER BY id LIMIT 11`,[job.tenant_id,owned.orderId]);
    if (originals.length > 10) throw new HttpError(409,'EVENT_RESOURCE_CONFLICT','The order has more original operations than this bounded observation can review.');
    const checks: RecoveryCheck[] = [];
    for (const original of originals) {
      if (primary.kind === 'dispute' && (original.kind !== 'dispute_response' || original.provider_id && original.provider_id !== primary.id)) continue;
      if (primary.kind === 'refund' && (original.kind !== 'refund' || original.provider_id && original.provider_id !== primary.id)) continue;
      signal.throwIfAborted();
      await requireConnector(this.db,connector);
      checks.push(await this.options.recovery.reconcileOnly(job.tenant_id,original.id,signal));
    }
    const waiting = checks.find(check => ['busy','pending','unresolved'].includes(check.outcome));
    return {outcome:waiting?'retry':'complete',reason:waiting?.reason??null,checks,observation};
  }

  private async process(job: ObservationJob): Promise<WorkResult> {
    const signal = AbortSignal.timeout(120_000);
    try {
      if (job.kind === 'resource') return await this.resource(job,signal);
      if (!job.subject.operationId || !job.subject.planId) throw new HttpError(409,'EVENT_RESOURCE_MISMATCH','The status job has no original operation identity.');
      const original = (await this.db.query<{plan_id:string}>('SELECT plan_id FROM gh_recovery_intents WHERE tenant_id=$1 AND id=$2',[job.tenant_id,job.subject.operationId]))[0];
      if (!original || original.plan_id !== job.subject.planId) throw new HttpError(409,'EVENT_RESOURCE_MISMATCH','The status job does not match the original saved recovery.');
      const check = await this.options.recovery.reconcileOnly(job.tenant_id,job.subject.operationId,signal);
      return {outcome:['verified','not_dispatched','not_completed'].includes(check.outcome)?'complete':'retry',reason:check.outcome==='verified'?null:check.reason,checks:[check]};
    } catch (error) {
      return {outcome:error instanceof HttpError && terminal.has(error.code)?'attention':'retry',reason:reasonFor(error),checks:[]};
    }
  }

  private async finish(job: ObservationJob, result: WorkResult) {
    return this.db.transaction(async tx => {
      const owned = (await tx.query<{lease_owner:string|null}>('SELECT lease_owner FROM gh_observation_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[job.tenant_id,job.id]))[0];
      if (owned?.lease_owner !== job.lease_owner) return null;
      const exhausted = job.attempts >= 12 || Date.now()-Date.parse(String(job.created_at)) >= 86_400_000;
      const state = result.outcome === 'retry' && exhausted ? 'attention' : result.outcome;
      const reason = state === 'attention' && result.outcome === 'retry' ? `Automatic read attempts stopped. ${result.reason ?? 'Review the saved original resource before requesting another check.'}` : result.reason;
      const delaySeconds = Math.min(3600,5*2**Math.min(job.attempts-1,10));
      await tx.query(`UPDATE gh_observation_jobs SET state=$4,result=$5::jsonb,last_error=$6,lease_owner=NULL,lease_until=NULL,
        next_attempt_at=now()+($7::text||' seconds')::interval,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3`,
        [job.tenant_id,job.id,job.lease_owner,state,JSON.stringify({...result,outcome:state}),reason,delaySeconds]);
      for (const check of result.checks) await tx.query('INSERT INTO gh_status_checks(tenant_id,id,operation_id,job_id,checked_at,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [job.tenant_id,randomUUID(),check.operationId,job.id,check.observedAt,JSON.stringify(check)]);
      if (job.connector_id && job.event_id) await tx.query('UPDATE gh_webhook_events SET state=$3,reason=$4 WHERE connector_id=$1 AND event_id=$2',[job.connector_id,job.event_id,state,reason]);
      return state;
    });
  }

  async drain(options: {tenantId?:string;jobId?:string;limit?:number;signal?:AbortSignal} = {}) {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40 || options.jobId && !options.tenantId) throw new HttpError(400,'INVALID_OBSERVATION_BOUND','The independent read worker needs a bounded, scoped job request.');
    const stopAt = Date.now()+50_000;
    let claimed = 0, complete = 0, attention = 0, retry = 0;
    while (claimed < limit && Date.now() < stopAt && !options.signal?.aborted) {
      const job = await this.claim(options.tenantId,options.jobId);
      if (!job) break;
      claimed++;
      const result = await this.process(job);
      const state = await this.finish(job,result);
      if (state === 'complete') complete++;else if (state === 'attention') attention++;else if (state === 'retry') retry++;
    }
    return {claimed,complete,retry,attention,readOnly:true};
  }
}
