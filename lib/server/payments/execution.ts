import { randomUUID } from 'node:crypto';
import { PaymentCore, PaymentError, payloadHash, type PaymentCommand, type PaymentOperation, type ProviderAdapter, type SqlPaymentStore, type AuthorizationDecision, type PaymentAction } from '@fracture/paypal-core';
import { digest } from '@/packages/payments/security';
import { HttpError } from '../errors';
import type { PaymentService } from './service';
import { commandIdentity, consentRecord, currentMember, iso, openConsent, runRecord, type ItemRecord, type RunRecord } from './records';
import type { OrderEvidenceGateway, OwnedOrderEvidence } from './evidence';
import { projectCapture } from './projection';

const PROJECT_ID = 'glasshouse';
const seedIdentity = (tenant: string, run: string, order: string) => digest([tenant,run,order]);
export const seedMarker = (tenant: string, run: string, order: string) => 'gh_' + seedIdentity(tenant,run,order).slice(0,32);
type CommandRow = Record<string, unknown> & { private_document: string; run_id: string; order_id: string; created_by: string; membership_version: number; payload_hash: string };
interface ExecutionOptions { service: PaymentService; store: SqlPaymentStore; provider: ProviderAdapter; evidence: Pick<OrderEvidenceGateway,'order'|'capture'> }

export class SeedExecutor {
  readonly core: PaymentCore;
  private readonly service: PaymentService;
  constructor(readonly options: ExecutionOptions) {
    this.service = options.service;
    this.core = new PaymentCore({ store: options.store, provider: options.provider, policy: { authorize: command => this.authorize(command) } });
  }
  private async authorize(command: PaymentCommand): Promise<AuthorizationDecision> {
    const deny = (reason: string): AuthorizationDecision => ({ allowed:false, reason, resourceIds:[], currency:'USD', maximumMinor:0, approvalId:command.approval.id, approvalVersion:command.approval.version, approvalDigest:command.approval.digest });
    if (command.scope.projectId !== PROJECT_ID) return deny('The command belongs to another project.');
    const db = this.service.db;
    const row = (await db.query<CommandRow>('SELECT private_document,run_id,order_id,created_by,membership_version,payload_hash FROM gh_payment_commands WHERE tenant_id=$1 AND operation_id=$2', [command.scope.tenantId,command.operationId]))[0];
    if (!row || row.payload_hash !== command.payloadHash) return deny('The immutable domain command is missing.');
    const stored = this.service.secrets.open<PaymentCommand>(row.private_document,commandIdentity(command.scope.tenantId,command.operationId));
    if (digest(stored) !== digest(command)) return deny('The domain command changed after approval.');
    const run = await runRecord(db,command.scope.tenantId,row.run_id);
    try { await currentMember(db,command.scope.tenantId,row.created_by,row.membership_version); }
    catch (error) { if (error instanceof HttpError) return deny(error.message); throw error; }
    if (!['approved','running'].includes(run.status) || run.approved_by !== row.created_by || run.membership_version !== row.membership_version || command.approval.id !== run.id || command.approval.version !== run.approval_version || command.approval.digest !== run.approval_digest || command.approval.expiresAt !== iso(run.approval_expires_at) || Date.parse(iso(run.approval_expires_at) ?? '') <= Date.now()) return deny('The exact batch approval is no longer current.');
    if (!run.consent_id) return deny('Saved-payment consent is missing.');
    const consent = await consentRecord(db,command.scope.tenantId,run.consent_id);
    if (consent.status !== 'verified' || Date.parse(iso(consent.expires_at)!) <= Date.now()) return deny('The saved-payment consent is no longer current.');
    try { await currentMember(db,command.scope.tenantId,consent.created_by,consent.membership_version); }
    catch (error) { if (error instanceof HttpError) return deny(error.message); throw error; }
    const value = openConsent(this.service.secrets,consent);
    if (!value.token || value.runHash !== run.manifest_hash || command.businessKey !== `seed:${run.id}:${row.order_id}:${command.action.kind}`) return deny('The command is outside this consent and batch.');
    const entry = run.manifest.entries.find(entry => entry.orderId === row.order_id);
    const item = (await db.query<ItemRecord>('SELECT * FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3', [command.scope.tenantId,run.id,row.order_id]))[0];
    if (!entry || !item || digest(entry) !== digest(item.entry) || command.action.money.currency !== entry.currency || command.action.money.minor !== entry.amountMinor) return deny('The requested payment differs from the immutable manifest entry.');
    const totals = (await db.query<{count:string;total:string}>('SELECT count(*)::text AS count,sum((entry->>\'amountMinor\')::bigint)::text AS total FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2', [command.scope.tenantId,run.id]))[0];
    if (Number(totals?.count) !== run.manifest.entryCount || Number(totals?.total) !== run.manifest.totalMinor) return deny('The complete batch budget could not be verified.');
    const decision: AuthorizationDecision = {
      allowed:true, reason:'Exact current tenant batch, consent and resource authority verified.',
      resourceIds:[], currency:entry.currency, maximumMinor:entry.amountMinor,
      approvalId:run.id, approvalVersion:run.approval_version, approvalDigest:run.approval_digest!, checkoutOrigins:[value.origin],
    };
    if (command.action.kind === 'create_order') {
      const action = command.action;
      const first = run.manifest.entries[0].orderId === row.order_id;
      if (!first) {
        const firstRow = (await db.query<{status:string}>('SELECT status FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3', [command.scope.tenantId,run.id,run.manifest.entries[0].orderId]))[0];
        if (firstRow?.status !== 'captured') return deny('The first saved-payment capture must be independently verified before subsequent use.');
      }
      const wallet = { vaultId:value.token.id,consentId:consent.id,consentVersion:consent.version,consentDigest:consent.digest,paymentInitiator:'MERCHANT' as const,usagePattern:'IMMEDIATE' as const,usage:first?'DERIVED' as const:'SUBSEQUENT' as const };
      if (action.intent !== 'CAPTURE' || action.customId !== seedMarker(command.scope.tenantId,run.id,row.order_id) || digest(action.savedWallet) !== digest(wallet) || action.saveWalletOnSuccess) return deny('The saved method or charge metadata differs from the approved consent.');
      if (!action.items || action.items.length !== 1 || action.items[0].quantity !== 1 || action.items[0].name !== entry.product || action.items[0].sku !== entry.reference || action.items[0].unitAmount.minor !== entry.amountMinor) return deny('The itemized purchase differs from the approved manifest.');
      decision.resourceIds = [value.token.id];
      decision.savedWalletConsent = { ...wallet, expiresAt:iso(consent.expires_at)! };
    } else if (command.action.kind === 'capture_order') {
      if (item.provider_order_id !== command.action.orderId) return deny('The capture references another order.');
      const resource = (await db.query<{order_id:string;active:boolean}>('SELECT order_id,active FROM gh_provider_resources WHERE tenant_id=$1 AND kind=\'order\' AND provider_id=$2 AND run_id=$3', [command.scope.tenantId,command.action.orderId,run.id]))[0];
      if (!resource?.active || resource.order_id !== row.order_id) return deny('The owning order has no current tenant grant.');
      decision.resourceIds = [command.action.orderId];
    } else return deny('This seed approval does not authorize that operation kind.');
    return decision;
  }

  private async command(run: RunRecord, item: ItemRecord, kind: 'create_order' | 'capture_order'): Promise<PaymentCommand> {
    return this.service.db.transaction(async tx => {
      const operationId = `seed-${kind === 'create_order' ? 'new' : 'cap'}-${seedIdentity(run.tenant_id,run.id,item.order_id).slice(0,32)}`;
      const previous = (await tx.query<CommandRow>('SELECT private_document FROM gh_payment_commands WHERE tenant_id=$1 AND operation_id=$2', [run.tenant_id,operationId]))[0];
      if (previous) return this.service.secrets.open<PaymentCommand>(previous.private_document,commandIdentity(run.tenant_id,operationId));
      const current = await runRecord(tx,run.tenant_id,run.id,true);
      if (!current.approved_by || !current.consent_id || !current.approval_digest || !current.approval_expires_at) throw new HttpError(403,'APPROVAL_REQUIRED','Approve the exact sandbox manifest before processing it.');
      await currentMember(tx,run.tenant_id,current.approved_by,current.membership_version);
      if (!['approved','running'].includes(current.status) || Date.parse(iso(current.approval_expires_at)!) <= Date.now()) throw new HttpError(403,'BATCH_APPROVAL_EXPIRED','The batch approval is no longer active.');
      const consent = await consentRecord(tx,run.tenant_id,current.consent_id);
      const value = openConsent(this.service.secrets,consent);
      if (consent.status !== 'verified' || !value.token || Date.parse(iso(consent.expires_at)!) <= Date.now()) throw new HttpError(403,'CONSENT_REQUIRED','The saved-payment consent is no longer active.');
      const first = current.manifest.entries[0].orderId === item.order_id;
      const money = {currency:item.entry.currency,minor:item.entry.amountMinor};
      const action: PaymentAction = kind === 'create_order' ? {
        kind, money, intent:'CAPTURE', customId:seedMarker(run.tenant_id,run.id,item.order_id),
        items:[{name:item.entry.product,quantity:1,unitAmount:money,sku:item.entry.reference}],
        savedWallet:{vaultId:value.token.id,consentId:consent.id,consentVersion:consent.version,consentDigest:consent.digest,paymentInitiator:'MERCHANT',usagePattern:'IMMEDIATE',usage:first?'DERIVED':'SUBSEQUENT'},
      } : {kind,money,orderId:item.provider_order_id!};
      if (kind === 'capture_order' && !item.provider_order_id) throw new HttpError(409,'OWNED_ORDER_REQUIRED','Verify the owning provider order before capturing it.');
      const command: PaymentCommand = {
        scope:{tenantId:run.tenant_id,projectId:PROJECT_ID},operationId,
        businessKey:`seed:${run.id}:${item.order_id}:${kind}`,intentId:`seed:${run.id}:${item.order_id}`,
        providerRequestId:randomUUID(),payloadHash:payloadHash(action),action,
        approval:{id:run.id,version:current.approval_version,digest:current.approval_digest,expiresAt:iso(current.approval_expires_at)!},
      };
      await tx.query('INSERT INTO gh_payment_commands(tenant_id,operation_id,business_key,run_id,order_id,action_kind,created_by,membership_version,payload_hash,private_document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [run.tenant_id,operationId,command.businessKey,run.id,item.order_id,kind,current.approved_by,current.membership_version,command.payloadHash,this.service.secrets.seal(command,commandIdentity(run.tenant_id,operationId))]);
      const column = kind === 'create_order' ? 'create_operation_id' : 'capture_operation_id';
      await tx.query(`UPDATE gh_seed_items SET ${column}=$4 WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3`, [run.tenant_id,run.id,item.order_id,operationId]);
      return command;
    });
  }
  private async resume(command: PaymentCommand, signal: AbortSignal): Promise<PaymentOperation> {
    const prior = await this.options.store.get(command.scope,command.operationId);
    if (!prior) return this.core.execute(command,signal);
    if (prior.status === 'claimed' && Date.parse(prior.leaseUntil) <= Date.now()) {
      return this.core.recoverOperation(command.scope,command.operationId,signal);
    }
    if (['dispatching','pending_reconciliation'].includes(prior.status)) return this.core.reconcile(command.scope,command.operationId,signal);
    return prior;
  }
  private async held(item: ItemRecord, status: 'unknown'|'refused'|'held'|'awaiting_buyer', reason: string) {
    await this.service.db.query('UPDATE gh_seed_items SET status=$4,reason=$5,lease_owner=NULL,lease_until=NULL,next_attempt_at=now()+interval \'60 seconds\' WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3 AND lease_owner=$6', [item.tenant_id,item.run_id,item.order_id,status,reason,item.lease_owner]);
  }
  private async bindOrder(run: RunRecord, item: ItemRecord, order: OwnedOrderEvidence) {
    await this.service.db.transaction(async tx => {
      await tx.query(`INSERT INTO gh_provider_resources(tenant_id,kind,provider_id,order_id,run_id,observed_at,body)
        VALUES($1,'order',$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,kind,provider_id)
        DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body`, [run.tenant_id,order.id,item.order_id,run.id,order.observedAt,JSON.stringify(order)]);
      await tx.query("UPDATE gh_seed_items SET provider_order_id=$4,status='capturing',reason=NULL WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3 AND lease_owner=$5", [run.tenant_id,run.id,item.order_id,order.id,item.lease_owner]);
    });
    item.provider_order_id = order.id;
  }
  private async process(item: ItemRecord, signal: AbortSignal): Promise<void> {
    const run = await runRecord(this.service.db,item.tenant_id,item.run_id);
    try {
      let orderId = item.provider_order_id;
      if (!orderId) {
        const command = await this.command(run,item,'create_order');
        const operation = await this.resume(command,signal);
        if (operation.status !== 'succeeded') {
          await this.held(item,['refused','not_sent'].includes(operation.status)?'refused':'unknown',operation.error?.message ?? 'The original create operation is awaiting provider reconciliation.');
          return;
        }
        const resources = operation.receipt?.resources.filter(resource=>resource.kind==='order') ?? [];
        if (resources.length !== 1) throw new HttpError(409,'ORDER_IDENTITY_UNCONFIRMED','The create receipt did not identify exactly one provider order.');
        orderId=resources[0].id;
      }
      let order = await this.options.evidence.order(orderId,item.entry,seedMarker(run.tenant_id,run.id,item.order_id),signal);
      await this.bindOrder(run,item,order);
      if (!order.captureIds.length) {
        if (order.status !== 'APPROVED') { await this.held(item,'awaiting_buyer','PayPal requires an additional approval for this owned order.'); return; }
        const command = await this.command(run,item,'capture_order');
        const operation = await this.resume(command,signal);
        if (operation.status !== 'succeeded') {
          await this.held(item,['refused','not_sent'].includes(operation.status)?'refused':'unknown',operation.error?.message ?? 'The original capture operation is awaiting provider reconciliation.');
          return;
        }
        order = await this.options.evidence.order(orderId,item.entry,seedMarker(run.tenant_id,run.id,item.order_id),signal);
      }
      if (order.captureIds.length !== 1 || order.refundIds.length) throw new HttpError(409,'CAPTURE_SET_UNCONFIRMED','The owning order has an unexpected payment set. Reconcile it before projecting a result.');
      if(item.capture_operation_id) {
        const reconciled=await this.core.reconcile({tenantId:run.tenant_id,projectId:PROJECT_ID},item.capture_operation_id,signal);
        if(reconciled.status!=='succeeded'){await this.held(item,'unknown','The original capture operation has not yet reconciled to its provider receipt.');return;}
      }
      const capture = await this.options.evidence.capture(order.captureIds[0],order,item.entry,signal);
      await projectCapture(this.service.db,run,item,order,capture);
    } catch (error) {
      const reason = error instanceof HttpError || error instanceof PaymentError ? error.message : 'Independent provider verification has not completed. The original operation remains available for reconciliation.';
      const status = error instanceof HttpError && error.status===403 || error instanceof PaymentError && error.httpStatus===403 ? 'held' : 'unknown';
      await this.held(item,status,reason);
    }
  }
  private async claim(tenantId?: string, runId?: string): Promise<ItemRecord | null> {
    return this.service.db.transaction(async tx => {
      const parameters: unknown[] = [];
      let scope='';
      if (tenantId) { parameters.push(tenantId); scope+=` AND r.tenant_id=$${parameters.length}`; }
      if (runId) { parameters.push(runId); scope+=` AND r.id=$${parameters.length}`; }
      const run = (await tx.query<RunRecord>(`SELECT r.* FROM gh_seed_runs r WHERE r.status IN ('approved','running','held','revoked')${scope}
        AND EXISTS(SELECT 1 FROM gh_seed_items i WHERE i.tenant_id=r.tenant_id AND i.run_id=r.id
          AND (i.status IN ('unknown','creating','capturing','verifying') OR (r.status IN ('approved','running') AND r.approval_expires_at>now() AND i.status IN ('queued','awaiting_buyer')))
          AND i.next_attempt_at<=now() AND (i.lease_until IS NULL OR i.lease_until<now()))
        ORDER BY r.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, parameters))[0];
      if (!run) return null;
      const firstId=run.manifest.entries[0].orderId;
      const active=['approved','running'].includes(run.status)&&Date.parse(iso(run.approval_expires_at)??'')>Date.now();
      const first=(await tx.query<{status:string}>('SELECT status FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3', [run.tenant_id,run.id,firstId]))[0];
      const items=await tx.query<ItemRecord>(`SELECT * FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2
        AND status IN (${active?"'queued','creating','capturing','verifying','unknown','awaiting_buyer'":"'creating','capturing','verifying','unknown'"}) AND next_attempt_at<=now()
        AND (lease_until IS NULL OR lease_until<now())${first?.status==='captured'?'':' AND order_id=$3'} ORDER BY order_id LIMIT 1 FOR UPDATE SKIP LOCKED`, first?.status==='captured'?[run.tenant_id,run.id]:[run.tenant_id,run.id,firstId]);
      const item=items[0]; if(!item)return null;
      const lease=randomUUID();
      await tx.query("UPDATE gh_seed_items SET lease_owner=$4,lease_until=now()+interval '120 seconds',attempts=attempts+1,status=CASE WHEN status='queued' THEN 'creating' ELSE status END WHERE tenant_id=$1 AND run_id=$2 AND order_id=$3", [run.tenant_id,run.id,item.order_id,lease]);
      if(active)await tx.query("UPDATE gh_seed_runs SET status='running',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('approved','running')", [run.tenant_id,run.id]);
      return {...item,lease_owner:lease};
    });
  }
  async drain(options: {tenantId?:string;runId?:string;limit?:number;concurrency?:number;signal?:AbortSignal} = {}) {
    const limit=Math.max(1,Math.min(60,options.limit??40));
    const concurrency=Math.max(1,Math.min(4,options.concurrency??3));
    const deadline=AbortSignal.timeout(95_000);
    const signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
    let claimed=0;
    let failed=0;
    await this.service.db.query(`UPDATE gh_seed_runs SET status='held',updated_at=now() WHERE status IN ('approved','running') AND approval_expires_at<=now()${options.tenantId?' AND tenant_id=$1':''}`,options.tenantId?[options.tenantId]:[]);
    const touched=new Map<string,{tenantId:string;runId:string}>();
    while(claimed<limit && !signal.aborted) {
      const items:ItemRecord[]=[];
      for(let i=0;i<concurrency && claimed+items.length<limit;i++) {
        const item=await this.claim(options.tenantId,options.runId);
        if(!item)break;
        items.push(item); touched.set(`${item.tenant_id}/${item.run_id}`,{tenantId:item.tenant_id,runId:item.run_id});
      }
      if(!items.length)break;
      claimed+=items.length;
      const results=await Promise.allSettled(items.map(item=>this.process(item,signal)));
      failed+=results.filter(result=>result.status==='rejected').length;
    }
    for(const {tenantId,runId} of touched.values()) {
      const counts=(await this.service.db.query<{total:string;captured:string}>("SELECT count(*)::text AS total,count(*) FILTER(WHERE status='captured')::text AS captured FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2",[tenantId,runId]))[0];
      if(Number(counts?.total)===600 && Number(counts?.captured)===600) {
        await this.service.db.query("UPDATE gh_seed_runs SET status='complete',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('approved','running')",[tenantId,runId]);
        await this.service.db.query("UPDATE gh_jobs SET state='complete',lease_until=NULL WHERE tenant_id=$1 AND id=$2",[tenantId,'seed-'+runId]);
      }
    }
    return {claimed,runs:touched.size,failed};
  }
}
