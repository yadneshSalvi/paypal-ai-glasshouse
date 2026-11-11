import { randomUUID } from 'node:crypto';
import type { WebhookVerifier } from '@fracture/paypal-core';
import type { Database } from '@/packages/db/client';
import type { Actor } from '@/packages/domain/types';
import type { ObservationOverview, StatusCheckView } from '@/packages/observations/types';
import { digest, type PaymentSecrets } from '@/packages/payments/security';
import { HttpError } from '../errors';
import { audit } from '../repository';
import { recoveryMember } from '../recovery/authority';
import {assertWorkspaceRequestWrite} from '../workspaces/authority';
import { requireConnector, type ObservationConnector } from './connector';
import { MAX_WEBHOOK_BYTES, parseWebhook, SIGNATURE_HEADERS, validSignatureHeaders, type WebhookHint } from './webhook';

export type ObservationJob = Record<string,unknown> & {
  tenant_id:string;id:string;kind:'resource'|'recovery';connector_id:string|null;event_id:string|null;
  subject: {hint?:WebhookHint;configHash?:string;operationId?:string;planId?:string;requestedBy?:string};
  state:string;attempts:number;lease_owner:string|null;lease_until:Date|string|null;created_at:Date|string;
};

export class ObservationService {
  constructor(readonly db: Database, readonly secrets: PaymentSecrets|null, readonly connector: ObservationConnector|null = null) {}

  async receive(connector: ObservationConnector, verifier: WebhookVerifier, raw: string, headers: Headers) {
    const secrets = this.secrets;
    if (!secrets) throw new HttpError(503,'PRIVATE_RECEIPT_STORAGE_REQUIRED','Encrypted provider receipt storage is not configured.');
    if (Buffer.byteLength(raw) > MAX_WEBHOOK_BYTES) throw new HttpError(413,'BODY_TOO_LARGE','The provider event exceeded the bounded receipt size.');
    await requireConnector(this.db,connector);
    const deliveryId = randomUUID(), rawHash = digest(raw);
    const envelope = {rawBody:raw,headers:Object.fromEntries(SIGNATURE_HEADERS.map(key => [key,headers.get(key)?.slice(0,8192) ?? null]))};
    const encrypted = secrets.seal(envelope,`webhook-delivery:${connector.id}:${deliveryId}`);
    let hint: WebhookHint|null = null;
    const delivery = async (db: Database, verified: boolean, outcome: string) => {
      await db.query(`INSERT INTO gh_webhook_deliveries(id,connector_id,event_id,raw_hash,transmission_id,verified,outcome,private_document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[deliveryId,connector.id,hint?.eventId ?? null,rawHash,headers.get('paypal-transmission-id')?.slice(0,128) ?? null,verified,outcome,encrypted]);
    };
    try { hint = parseWebhook(raw); }
    catch (error) { await delivery(this.db,false,'invalid_event');throw error; }
    if (!validSignatureHeaders(headers)) {
      await delivery(this.db,false,'invalid_signature_headers');
      throw new HttpError(400,'WEBHOOK_SIGNATURE_REQUIRED','The provider transmission headers are incomplete or outside the isolated sandbox.');
    }
    let verified: boolean;
    try { verified = (await verifier.verify(raw,headers)).verified; }
    catch {
      await delivery(this.db,false,'verification_unavailable');
      throw new HttpError(503,'WEBHOOK_VERIFICATION_UNAVAILABLE','PayPal verification is temporarily unavailable. This delivery has not been accepted for processing.');
    }
    if (!verified) { await delivery(this.db,false,'invalid_signature');throw new HttpError(400,'WEBHOOK_SIGNATURE_INVALID','PayPal did not verify this event signature.'); }
    const event = hint;
    return this.db.transaction(async tx => {
      await requireConnector(tx,connector);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`webhook:${connector.id}:${event.eventId}`]);
      const current = (await tx.query<{raw_hash:string}>('SELECT raw_hash FROM gh_webhook_events WHERE connector_id=$1 AND event_id=$2',[connector.id,event.eventId]))[0];
      if (current) {
        const outcome = current.raw_hash === rawHash ? 'duplicate' : 'identity_conflict';
        await delivery(tx,true,outcome);
        return {accepted:true,deliveryId,outcome};
      }
      const wrongMerchant = event.merchantIds.some(id => id !== connector.merchantId);
      const state = wrongMerchant ? 'attention' : event.supported ? 'queued' : 'unsupported';
      const reason = wrongMerchant ? 'The signed merchant metadata does not match this isolated connector.' : !event.supported ? 'This event type or resource shape is not supported for scoped observation.' : null;
      await delivery(tx,true,wrongMerchant ? 'merchant_conflict' : event.supported ? 'accepted' : 'unsupported');
      await tx.query(`INSERT INTO gh_webhook_events(connector_id,event_id,tenant_id,event_type,occurred_at,raw_hash,state,reason,private_document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[connector.id,event.eventId,connector.tenantId,event.eventType,event.occurredAt,rawHash,state,reason,
        secrets.seal(envelope,`webhook-event:${connector.id}:${event.eventId}`)]);
      if (state === 'queued') await tx.query(`INSERT INTO gh_observation_jobs(tenant_id,id,kind,connector_id,event_id,subject)
        VALUES($1,$2,'resource',$3,$4,$5::jsonb)`,[connector.tenantId,`webhook-${digest([connector.id,event.eventId]).slice(0,40)}`,connector.id,event.eventId,JSON.stringify({hint:event,configHash:connector.configHash})]);
      return {accepted:true,deliveryId,outcome:state};
    });
  }

  async enqueueStatus(actor: Actor, planId: string, operationId?: string) {
    return this.db.transaction(async tx => {
      await assertWorkspaceRequestWrite(tx,actor);
      await recoveryMember(tx,actor);
      const plan = (await tx.query<{id:string}>('SELECT id FROM gh_plans WHERE tenant_id=$1 AND id=$2',[actor.tenantId,planId]))[0];
      if (!plan) throw new HttpError(404,'PLAN_NOT_FOUND','This workspace has no such saved recovery.');
      const operations = await tx.query<{id:string}>(`SELECT id FROM gh_recovery_intents WHERE tenant_id=$1 AND plan_id=$2${operationId?' AND id=$3':''} ORDER BY id LIMIT 601`,operationId?[actor.tenantId,planId,operationId]:[actor.tenantId,planId]);
      if (!operations.length) throw new HttpError(409,'ORIGINAL_OPERATIONS_REQUIRED','This recovery has no original provider operations to check.');
      if (operations.length > 600) throw new HttpError(409,'STATUS_CHECK_TOO_LARGE','Select a smaller set of original operations to check.');
      let queued = 0;
      for (const operation of operations) {
        const rows = await tx.query(`INSERT INTO gh_observation_jobs(tenant_id,id,kind,subject) VALUES($1,$2,'recovery',$3::jsonb)
          ON CONFLICT(tenant_id,id) DO UPDATE SET subject=excluded.subject,state='queued',result=NULL,attempts=0,last_error=NULL,
            lease_owner=NULL,lease_until=NULL,next_attempt_at=now(),created_at=now(),updated_at=now()
          WHERE gh_observation_jobs.state NOT IN ('queued','retry') AND (gh_observation_jobs.state<>'running' OR gh_observation_jobs.lease_until<now()) RETURNING id`,
          [actor.tenantId,`status-${operation.id}`,JSON.stringify({operationId:operation.id,planId,requestedBy:actor.id})]);
        queued += rows.length;
      }
      await audit(tx,actor,'recovery.status_requested',`Independent status checks requested for ${operations.length} original actions`,planId,{readOnly:true,queued,operations:operations.length});
      return {queued,operations:operations.length,readOnly:true};
    });
  }

  async overview(actor: Actor): Promise<ObservationOverview> {
    await recoveryMember(this.db,actor);
    const rows = await this.db.query<{state:string;count:string}>('SELECT state,count(*)::text AS count FROM gh_observation_jobs WHERE tenant_id=$1 GROUP BY state',[actor.tenantId]);
    const totals = Object.fromEntries(rows.map(row => [row.state,Number(row.count)]));
    const deliveries = await this.db.query<{outcome:string;verified:boolean;count:string;latest:Date|string}>(`SELECT d.outcome,d.verified,count(*)::text AS count,max(d.received_at) AS latest FROM gh_webhook_deliveries d
      JOIN gh_paypal_connectors c ON c.id=d.connector_id WHERE c.tenant_id=$1 GROUP BY d.outcome,d.verified`,[actor.tenantId]);
    const count = (predicate:(row:typeof deliveries[number])=>boolean) => deliveries.filter(predicate).reduce((sum,row)=>sum+Number(row.count),0);
    const applied = (await this.db.query<{count:string}>("SELECT count(*)::text AS count FROM gh_webhook_events WHERE tenant_id=$1 AND state='complete'",[actor.tenantId]))[0];
    const recent = await this.db.query<{id:string;kind:string;state:string;attempts:number;updated_at:Date|string;last_error:string|null}>('SELECT id,kind,state,attempts,updated_at,last_error FROM gh_observation_jobs WHERE tenant_id=$1 ORDER BY updated_at DESC,id LIMIT 8',[actor.tenantId]);
    const checks = await this.db.query<{body:StatusCheckView}>(`SELECT body FROM (SELECT DISTINCT ON(operation_id) body,checked_at FROM gh_status_checks
      WHERE tenant_id=$1 ORDER BY operation_id,checked_at DESC,id DESC) latest ORDER BY checked_at DESC LIMIT 600`,[actor.tenantId]);
    const pending = await this.db.query<{operation_id:string}>("SELECT subject->>'operationId' AS operation_id FROM gh_observation_jobs WHERE tenant_id=$1 AND kind='recovery' AND state IN ('queued','running','retry') LIMIT 600",[actor.tenantId]);
    const held = await this.db.query<{operation_id:string;last_error:string|null;updated_at:Date|string}>("SELECT subject->>'operationId' AS operation_id,last_error,updated_at FROM gh_observation_jobs WHERE tenant_id=$1 AND kind='recovery' AND state='attention' ORDER BY updated_at DESC LIMIT 600",[actor.tenantId]);
    let connectorConfigured = false;
    if (this.connector?.tenantId === actor.tenantId) try { await requireConnector(this.db,this.connector);connectorConfigured = true; } catch { /* Show the binding as unavailable. */ }
    return {connectorConfigured,notifications:{verified:count(row=>row.verified),applied:Number(applied?.count??0),duplicates:count(row=>row.outcome==='duplicate'),
      rejected:count(row=>!row.verified),conflicts:count(row=>row.outcome==='identity_conflict'||row.outcome==='merchant_conflict'),
      lastVerifiedAt:deliveries.filter(row=>row.verified).map(row=>new Date(row.latest).toISOString()).sort().at(-1)??null},
      jobs:{queued:totals.queued??0,running:totals.running??0,retry:totals.retry??0,complete:totals.complete??0,attention:totals.attention??0},
      recent:recent.map(row=>({id:row.id,kind:row.kind,state:row.state,attempts:row.attempts,updatedAt:new Date(row.updated_at).toISOString(),reason:row.last_error})),pendingOperations:pending.map(row=>row.operation_id),
      heldOperations:held.map(row=>({operationId:row.operation_id,reason:row.last_error??'The independent read needs another review.',updatedAt:new Date(row.updated_at).toISOString()})),checks:checks.map(row=>row.body)};
  }

  async retryHeld(actor: Actor) {
    return this.db.transaction(async tx => {
      await assertWorkspaceRequestWrite(tx,actor);
      await recoveryMember(tx,actor);
      const rows = await tx.query(`UPDATE gh_observation_jobs SET state='queued',attempts=0,next_attempt_at=now(),created_at=now(),updated_at=now(),
        lease_owner=NULL,lease_until=NULL,last_error=NULL WHERE tenant_id=$1 AND state='attention' RETURNING id`,[actor.tenantId]);
      await audit(tx,actor,'observation.retry_requested',`${rows.length} held independent reads requested again`,null,{readOnly:true,queued:rows.length});
      return {queued:rows.length,readOnly:true};
    });
  }
}
