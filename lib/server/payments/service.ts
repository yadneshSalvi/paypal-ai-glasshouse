import { randomBytes, randomUUID } from 'node:crypto';
import type { SetupTokenRequest } from 'paypal';
import type { Database } from '@/packages/db/client';
import type { Actor } from '@/packages/domain/types';
import type { SandboxStatus, SeedRun } from '@/packages/payments/types';
import { seedManifest } from '@/packages/payments/manifest';
import { digest, equalDigest, PaymentSecrets, trustedOrigin } from '@/packages/payments/security';
import { audit, datasetFor } from '../repository';
import { HttpError } from '../errors';
import { VaultFailure, type SetupObservation, type TokenObservation, type VaultGateway, type VaultReceipt } from './vault';
import { consentIdentity, consentRecord, currentMember, iso, openConsent, runRecord, vaultIdentity, type ConsentPrivate, type ConsentRecord, type ItemRecord, type RunRecord } from './records';

export interface PaymentServiceOptions {
  db: Database; secrets: PaymentSecrets;
  vault: Pick<VaultGateway, 'createSetup' | 'getSetup' | 'exchange' | 'getToken' | 'listTokens' | 'baselineTokens'>;
  configured: boolean; isolated: boolean;
}
type VaultOperation = Record<string, unknown> & { id: string; status: string; request_hash: string; private_document: string };
type VaultPrivate = { request: unknown; setup?: SetupObservation; token?: TokenObservation };

export class PaymentService {
  readonly db: Database;
  readonly secrets: PaymentSecrets;
  readonly vault: PaymentServiceOptions['vault'];
  constructor(readonly options: PaymentServiceOptions) { this.db = options.db; this.secrets = options.secrets; this.vault = options.vault; }

  async status(who: Actor): Promise<SandboxStatus> {
    const row = (await this.db.query<RunRecord>('SELECT * FROM gh_seed_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1', [who.tenantId]))[0];
    return {
      environment: 'sandbox', isolated: this.options.isolated, configured: this.options.configured,
      role: who.role, canApprove: ['owner','operator','judge'].includes(who.role),
      run: row ? await this.viewRun(who, row.id) : null,
      suggestedManifest: row?.manifest ?? seedManifest(await datasetFor(who, this.db)),
    };
  }
  async viewRun(who: Actor, id: string): Promise<SeedRun> {
    const run = await runRecord(this.db, who.tenantId, id);
    const rows = await this.db.query<ItemRecord>('SELECT * FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 ORDER BY order_id', [who.tenantId, id]);
    const consent = run.consent_id ? await consentRecord(this.db, who.tenantId, run.consent_id) : null;
    const privateConsent = consent ? openConsent(this.secrets, consent) : null;
    const captured = rows.filter(row => row.status === 'captured');
    return {
      id: run.id, status: run.status, manifest: run.manifest, createdAt: iso(run.created_at)!,
      approvedAt: iso(run.approved_at), approvalExpiresAt: iso(run.approval_expires_at), approvalVersion: run.approval_version,
      consent: consent ? {
        id: consent.id, status: consent.status, verifiedAt: iso(consent.verified_at), expiresAt: iso(consent.expires_at)!,
        approvalUrl: consent.status === 'awaiting_buyer' ? privateConsent?.setup?.approvalUrl ?? null : null, reason: consent.reason,
      } : null,
      progress: {
        captured: captured.length, capturedMinor: captured.reduce((sum, row) => sum + row.entry.amountMinor, 0),
        pending: rows.filter(row => ['queued','creating','capturing','verifying','awaiting_buyer'].includes(row.status)).length,
        unknown: rows.filter(row => row.status === 'unknown').length,
        refused: rows.filter(row => row.status === 'refused').length,
        held: rows.filter(row => row.status === 'held').length,
      },
      items: rows.map(row => ({ ...row.entry, status: row.status, providerOrderId: row.provider_order_id, providerCaptureId: row.provider_capture_id, reason: row.reason, observedAt: iso(row.observed_at) })),
    };
  }
  async createRun(who: Actor, expectedHash: string): Promise<SeedRun> {
    const id = await this.db.transaction(async tx => {
      await currentMember(tx, who.tenantId, who.id, who.membershipVersion);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`seed:${who.tenantId}`]);
      const prior = (await tx.query<RunRecord>('SELECT * FROM gh_seed_runs WHERE tenant_id=$1', [who.tenantId]))[0];
      if (prior) {
        if (!equalDigest(prior.manifest_hash, expectedHash)) throw new HttpError(409, 'MANIFEST_CHANGED', 'Reload the existing exact batch before continuing.');
        return prior.id;
      }
      const dataset = await datasetFor(who, tx);
      const manifest = seedManifest(dataset);
      if (!equalDigest(manifest.hash, expectedHash)) throw new HttpError(409, 'MANIFEST_CHANGED', 'The 600-order manifest changed. Review the current batch.');
      if (dataset.orders.some(order => order.captureId || order.paypalOrderId || order.paymentSource === 'sandbox')) throw new HttpError(409, 'SEED_ALREADY_BOUND', 'This dataset already has provider resources. Reconcile its existing batch.');
      const id = randomUUID();
      await tx.query('INSERT INTO gh_seed_runs(tenant_id,id,seed_version,manifest_hash,manifest,status,created_by,membership_version) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)', [who.tenantId,id,manifest.seedVersion,manifest.hash,JSON.stringify(manifest),'draft',who.id,who.membershipVersion]);
      await tx.query(`INSERT INTO gh_seed_items(tenant_id,run_id,order_id,entry)
        SELECT $1,$2,entry->>'orderId',entry FROM jsonb_array_elements($3::jsonb) entry`, [who.tenantId,id,JSON.stringify(manifest.entries)]);
      await audit(tx, who, 'seed.manifest_created', 'Exact 600-order sandbox manifest prepared', id, { manifestHash: manifest.hash, entryCount: manifest.entryCount, totalMinor: manifest.totalMinor, currency: 'USD', source: 'sample' });
      return id;
    });
    return this.viewRun(who, id);
  }

  private assertConfigured() {
    if (!this.options.configured || !this.options.isolated) throw new HttpError(503, 'SANDBOX_NOT_CONFIGURED', 'Connect the isolated Glasshouse PayPal sandbox before continuing.');
  }
  async connect(who: Actor, runId: string, manifestHash: string, requestOrigin: string, caller?: AbortSignal): Promise<SeedRun> {
    this.assertConfigured();
    const origin = trustedOrigin(requestOrigin);
    const consent = await this.db.transaction(async tx => {
      await currentMember(tx, who.tenantId, who.id, who.membershipVersion);
      const run = await runRecord(tx, who.tenantId, runId, true);
      if (!equalDigest(run.manifest_hash, manifestHash)) throw new HttpError(409, 'MANIFEST_CHANGED', 'Review the exact batch before connecting a saved payment method.');
      if (run.consent_id) return consentRecord(tx, who.tenantId, run.consent_id);
      if (run.status !== 'draft') throw new HttpError(409, 'BATCH_NOT_DRAFT', 'This batch cannot acquire another saved-payment consent.');
      const id = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const consentDigest = digest({ tenantId: who.tenantId, id, runId, manifestHash, entryCount: run.manifest.entryCount, totalMinor: run.manifest.totalMinor, maximumOrderMinor: run.manifest.maximumOrderMinor, currency: 'USD', createdBy: who.id, membershipVersion: who.membershipVersion, origin, expiresAt, version: 1 });
      const privateValue: ConsentPrivate = { origin, nonce, nonceHash: digest(nonce), merchantCustomerId: 'gh-' + digest([who.tenantId,runId,id]).slice(0,48), runHash: manifestHash, callbackVerified: false };
      await tx.query('INSERT INTO gh_payment_consents(tenant_id,id,run_id,version,digest,status,created_by,membership_version,expires_at,private_document) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9)', [who.tenantId,id,runId,consentDigest,'preparing',who.id,who.membershipVersion,expiresAt,this.secrets.seal(privateValue,consentIdentity(who.tenantId,id))]);
      await tx.query("UPDATE gh_seed_runs SET consent_id=$3,status='awaiting_consent',updated_at=now() WHERE tenant_id=$1 AND id=$2", [who.tenantId,runId,id]);
      await audit(tx, who, 'consent.requested', 'Saved-payment consent requested for the exact sandbox batch', id, { runId, manifestHash, totalMinor: run.manifest.totalMinor, entryCount: run.manifest.entryCount, expiresAt });
      return consentRecord(tx, who.tenantId, id);
    });
    if (consent.status !== 'preparing') return this.viewRun(who, runId);
    const privateValue = openConsent(this.secrets, consent);
    const returnUrl = new URL('/sandbox', privateValue.origin);
    returnUrl.searchParams.set('consent', consent.id); returnUrl.searchParams.set('state', privateValue.nonce);
    const cancelUrl = new URL(returnUrl); cancelUrl.searchParams.set('cancelled', '1');
    const request: SetupTokenRequest = {
      customer: { merchantCustomerId: privateValue.merchantCustomerId },
      paymentSource: { paypal: {
        description: 'Glasshouse sandbox only: 600 orders, total USD 27,600.00, maximum USD 89.00 each.',
        usagePattern: 'IMMEDIATE', usageType: 'MERCHANT', customerType: 'CONSUMER', permitMultiplePaymentTokens: false,
        experienceContext: { brandName: 'Glasshouse', locale: 'en-US', returnUrl: returnUrl.href, cancelUrl: cancelUrl.href, shippingPreference: 'NO_SHIPPING', userAction: 'CONTINUE' },
      } },
    };
    const claim = await this.claimVault(who, consent, 'setup', request);
    if (!claim.won) {
      if (claim.row.status === 'confirmed') {
        const stored = this.secrets.open<VaultPrivate>(claim.row.private_document, vaultIdentity(who.tenantId, claim.row.id));
        if (stored.setup) await this.saveSetup(who, consent, stored.setup);
      }
      return this.viewRun(who, runId);
    }
    try {
      const setup = await this.vault.createSetup(claim.requestId, request, caller);
      await this.finishVault(who.tenantId, claim.row.id, { request, setup }, setup.receipt);
      await this.saveSetup(who, consent, setup);
    } catch (error) { await this.failVault(who, consent, claim.row.id, error); }
    return this.viewRun(who, runId);
  }
  private async saveSetup(who: Actor, original: ConsentRecord, setup: SetupObservation) {
    await this.db.transaction(async tx => {
      const consent = await consentRecord(tx, who.tenantId, original.id, true);
      if (consent.status === 'revoked' || consent.status === 'verified') return;
      await currentMember(tx, who.tenantId, consent.created_by, consent.membership_version);
      const value = openConsent(this.secrets, consent);
      if (setup.merchantCustomerId && setup.merchantCustomerId !== value.merchantCustomerId) throw new HttpError(409, 'CUSTOMER_BINDING_MISMATCH', 'The provider customer did not match this workspace consent.');
      if (!['PAYER_ACTION_REQUIRED','APPROVED','CREATED'].includes(setup.status) || setup.status !== 'APPROVED' && !setup.approvalUrl) throw new HttpError(409, 'SETUP_NOT_APPROVABLE', 'PayPal has not returned an approval flow for this saved payment method.');
      value.setup = setup;
      await tx.query("UPDATE gh_payment_consents SET status='awaiting_buyer',private_document=$3,reason=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [who.tenantId,consent.id,this.secrets.seal(value,consentIdentity(who.tenantId,consent.id))]);
      await audit(tx, who, 'consent.awaiting_buyer', 'PayPal saved-payment approval is ready', consent.id, { source: 'sandbox', transport: 'apimatic_sdk', receiptHash: setup.receipt.bodyHash });
    });
  }
  private async claimVault(who: Actor, consent: ConsentRecord, kind: 'setup' | 'exchange', request: unknown) {
    return this.db.transaction(async tx => {
      const current = await consentRecord(tx, who.tenantId, consent.id, true);
      await currentMember(tx, who.tenantId, current.created_by, current.membership_version);
      if (current.status === 'revoked' || Date.parse(iso(current.expires_at)!) <= Date.now()) throw new HttpError(403, 'CONSENT_EXPIRED', 'This saved-payment consent is no longer active.');
      const id = `${kind}-${consent.id}`;
      const requestId = digest([who.tenantId,id]).slice(0,32);
      const requestHash = digest(request);
      const inserted = await tx.query<{id:string}>(`INSERT INTO gh_vault_operations(tenant_id,id,consent_id,kind,status,provider_request_id,request_hash,private_document,lease_until)
        VALUES($1,$2,$3,$4,'dispatching',$5,$6,$7,now()+interval '90 seconds') ON CONFLICT DO NOTHING RETURNING id`, [who.tenantId,id,consent.id,kind,requestId,requestHash,this.secrets.seal({request},vaultIdentity(who.tenantId,id))]);
      const row = (await tx.query<VaultOperation>('SELECT id,status,request_hash,private_document FROM gh_vault_operations WHERE tenant_id=$1 AND id=$2', [who.tenantId,id]))[0];
      if (!row || row.request_hash !== requestHash) throw new HttpError(409, 'VAULT_OPERATION_CHANGED', 'The saved-payment request differs from its original durable operation.');
      return { won: inserted.length === 1, row, requestId };
    });
  }
  private async finishVault(tenantId: string, id: string, value: VaultPrivate, receipt: VaultReceipt) {
    await this.db.query("UPDATE gh_vault_operations SET status='confirmed',private_document=$3,receipt=$4::jsonb,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId,id,this.secrets.seal(value,vaultIdentity(tenantId,id)),JSON.stringify(receipt)]);
  }
  private async failVault(who: Actor, consent: ConsentRecord, operationId: string, error: unknown) {
    const failure = error instanceof VaultFailure ? error : new VaultFailure('unknown','VAULT_INTERRUPTED','The saved-payment operation needs reconciliation before continuing.');
    await this.db.transaction(async tx => {
      const changed=await tx.query("UPDATE gh_vault_operations SET status=$3,receipt=$4::jsonb,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status <> 'confirmed' RETURNING id", [who.tenantId,operationId,failure.outcome,JSON.stringify({ code: failure.code, status: failure.status, debugId: failure.debugId })]);
      await tx.query("UPDATE gh_payment_consents SET status=$3,reason=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('verified','revoked')", [who.tenantId,consent.id,!changed.length || failure.outcome === 'unknown' ? 'unknown' : 'refused',failure.message]);
      await audit(tx, who, changed.length?'consent.held':'consent.verification_held', 'Saved-payment setup is held for verification', consent.id, { code: failure.code, outcome: failure.outcome, httpStatus: failure.status, writeClaimPresent:changed.length>0,debugId:failure.debugId });
    });
  }

  async completeConsent(who: Actor, runId: string, state?: string, caller?: AbortSignal): Promise<SeedRun> {
    this.assertConfigured();
    await currentMember(this.db, who.tenantId, who.id, who.membershipVersion);
    const run = await runRecord(this.db, who.tenantId, runId);
    if (!run.consent_id) throw new HttpError(409, 'CONSENT_REQUIRED', 'Connect this batch to a saved payment method first.');
    let consent = await consentRecord(this.db, who.tenantId, run.consent_id);
    let privateValue = openConsent(this.secrets, consent);
    if (consent.status === 'revoked' || Date.parse(iso(consent.expires_at)!) <= Date.now()) throw new HttpError(403, 'CONSENT_EXPIRED', 'This saved-payment consent is no longer active.');
    if (state !== undefined && !equalDigest(digest(state), privateValue.nonceHash)) throw new HttpError(403, 'CONSENT_STATE_MISMATCH', 'Return through this workspace’s original PayPal approval link.');
    if (consent.status === 'verified') return this.viewRun(who, runId);
    if (!privateValue.setup) throw new HttpError(409, 'SETUP_OUTCOME_UNKNOWN', 'The setup response has no provider identity. It cannot be safely submitted again.');
    if (state === undefined && !privateValue.callbackVerified) throw new HttpError(409, 'BUYER_RETURN_REQUIRED', 'Return from the PayPal approval flow to verify this saved payment method.');
    if (state !== undefined) {
      privateValue.callbackVerified = true;
      await this.db.query("UPDATE gh_payment_consents SET private_document=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('verified','revoked')", [who.tenantId,consent.id,this.secrets.seal(privateValue,consentIdentity(who.tenantId,consent.id))]);
    }
    const operationId = `exchange-${consent.id}`;
    try {
      const prior = (await this.db.query<VaultOperation>('SELECT id,status,request_hash,private_document FROM gh_vault_operations WHERE tenant_id=$1 AND id=$2', [who.tenantId,operationId]))[0];
      // An exchanged setup may be TOKENIZED or no longer readable. A persisted exchange
      // result is recovered from its exact payment token, never by exchanging it again.
      const setup = prior?.status === 'confirmed' ? privateValue.setup : await this.vault.getSetup(privateValue.setup.id, caller);
      if (setup.customerId !== privateValue.setup.customerId || setup.merchantCustomerId && setup.merchantCustomerId !== privateValue.merchantCustomerId) throw new VaultFailure('refused','CUSTOMER_BINDING_MISMATCH','The PayPal customer is outside this consent.',403);
      if (privateValue.setup.payerId && setup.payerId && privateValue.setup.payerId !== setup.payerId) throw new VaultFailure('refused','PAYER_BINDING_MISMATCH','The PayPal payer changed during saved-payment verification.',403);
      if (!(prior ? ['APPROVED','VAULTED','TOKENIZED'] : ['APPROVED']).includes(setup.status)) throw new HttpError(409, 'BUYER_APPROVAL_REQUIRED', 'PayPal has not confirmed the saved-payment approval yet.');
      setup.payerId ??= privateValue.setup.payerId;
      privateValue.setup = setup;
      let token: TokenObservation | undefined;
      if (prior?.status === 'confirmed') token = this.secrets.open<VaultPrivate>(prior.private_document,vaultIdentity(who.tenantId,prior.id)).token;
      else if (prior) {
        if (prior.status === 'refused' || prior.status === 'not_sent') return this.viewRun(who, runId);
        if (!privateValue.baselineTokenIds) throw new VaultFailure('unknown','TOKEN_BASELINE_MISSING','The saved-payment exchange has insufficient recovery evidence.');
        const tokens = await this.vault.listTokens(setup.customerId, caller);
        const candidates = tokens.filter(token => !privateValue.baselineTokenIds!.includes(token.id) && (!setup.payerId || token.payerId === setup.payerId) && (!token.merchantCustomerId || token.merchantCustomerId === privateValue.merchantCustomerId));
        if (candidates.length !== 1) throw new VaultFailure('unknown','TOKEN_MATCH_AMBIGUOUS','The saved-payment exchange is still unconfirmed. Its original operation has been retained.');
        token = candidates[0];
      } else {
        const baseline=await this.vault.baselineTokens(setup,privateValue.merchantCustomerId,caller);
        privateValue.baselineTokenIds = baseline.tokens.map(token => token.id);
        privateValue.baselineAbsence = baseline.absence;
        await this.db.transaction(async tx => {
          consent = await consentRecord(tx, who.tenantId, consent.id, true);
          if (consent.status === 'verified' || consent.status === 'revoked') throw new HttpError(409,'CONSENT_CHANGED','Reload the current saved-payment status.');
          await tx.query("UPDATE gh_payment_consents SET private_document=$3,status='exchanging',updated_at=now() WHERE tenant_id=$1 AND id=$2", [who.tenantId,consent.id,this.secrets.seal(privateValue,consentIdentity(who.tenantId,consent.id))]);
        });
        const request = { setupId: setup.id, customerId: setup.customerId, merchantCustomerId: privateValue.merchantCustomerId, customerMode:privateValue.baselineAbsence?'from_approved_setup':'existing_customer' };
        const claim = await this.claimVault(who, consent, 'exchange', request);
        if (!claim.won) return this.viewRun(who, runId);
        token = await this.vault.exchange(claim.requestId, setup, privateValue.merchantCustomerId, caller,!!privateValue.baselineAbsence);
        await this.finishVault(who.tenantId, operationId, { request, token }, token.receipt);
      }
      if (!token) throw new VaultFailure('unknown','TOKEN_IDENTITY_MISSING','The saved-payment exchange did not return a token identity.');
      const verified = await this.vault.getToken(token.id, setup.customerId, caller);
      if (verified.payerId !== token.payerId || setup.payerId && verified.payerId !== setup.payerId || verified.merchantCustomerId && verified.merchantCustomerId !== privateValue.merchantCustomerId || verified.usageType && verified.usageType !== 'MERCHANT') throw new VaultFailure('refused','TOKEN_OWNERSHIP_MISMATCH','The independently read payment method did not match this consent.',403);
      if(prior && prior.status !== 'confirmed') {
        const saved = this.secrets.open<VaultPrivate>(prior.private_document,vaultIdentity(who.tenantId,prior.id));
        await this.finishVault(who.tenantId,prior.id,{request:saved.request,token:verified},verified.receipt);
      }
      await this.db.transaction(async tx => {
        const current = await consentRecord(tx, who.tenantId, consent.id, true);
        await currentMember(tx, who.tenantId, current.created_by, current.membership_version);
        if (current.status === 'revoked' || Date.parse(iso(current.expires_at)!) <= Date.now()) throw new HttpError(403,'CONSENT_EXPIRED','This consent was revoked or expired during verification.');
        const currentRun = await runRecord(tx, who.tenantId, runId, true);
        if (!equalDigest(currentRun.manifest_hash, privateValue.runHash)) throw new HttpError(409,'MANIFEST_CHANGED','The consent no longer matches the exact batch.');
        privateValue.token = verified;
        await tx.query("UPDATE gh_payment_consents SET status='verified',private_document=$3,verified_at=$4,reason=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [who.tenantId,consent.id,this.secrets.seal(privateValue,consentIdentity(who.tenantId,consent.id)),verified.receipt.observedAt]);
        await tx.query("UPDATE gh_seed_runs SET status='ready',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('draft','awaiting_consent','held')", [who.tenantId,runId]);
        await audit(tx, who, 'consent.verified', 'PayPal saved-payment consent independently verified', consent.id, { runId, source: 'sandbox', transport: 'apimatic_sdk', receiptHash: verified.receipt.bodyHash, manifestHash: run.manifest_hash });
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      await this.failVault(who, consent, operationId, error);
    }
    return this.viewRun(who, runId);
  }

  async approve(who: Actor, runId: string, manifestHash: string): Promise<SeedRun> {
    this.assertConfigured();
    await this.db.transaction(async tx => {
      await currentMember(tx, who.tenantId, who.id, who.membershipVersion);
      const run = await runRecord(tx, who.tenantId, runId, true);
      if (!equalDigest(run.manifest_hash, manifestHash)) throw new HttpError(409,'MANIFEST_CHANGED','Review the exact manifest before approving it.');
      if (['approved','running','complete'].includes(run.status)) return;
      if (run.status !== 'ready' || !run.consent_id) throw new HttpError(409,'CONSENT_NOT_VERIFIED','Verify the PayPal saved-payment consent before approving the batch.');
      const consent = await consentRecord(tx, who.tenantId, run.consent_id, true);
      const value = openConsent(this.secrets, consent);
      if (consent.status !== 'verified' || !value.token || Date.parse(iso(consent.expires_at)!) <= Date.now()) throw new HttpError(403,'CONSENT_EXPIRED','The saved-payment consent is not current.');
      await currentMember(tx, who.tenantId, consent.created_by, consent.membership_version);
      const items = await tx.query<ItemRecord>('SELECT * FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2', [who.tenantId,runId]);
      if (items.length !== run.manifest.entryCount || items.reduce((sum,item)=>sum+item.entry.amountMinor,0) !== run.manifest.totalMinor || digest(items.map(item=>item.entry).sort((a,b)=>a.reference.localeCompare(b.reference))) !== digest(run.manifest.entries)) throw new HttpError(409,'BATCH_INTEGRITY_FAILED','The stored batch does not match the manifest. No payments were approved.');
      const approvedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now()+30*60_000).toISOString();
      const version = run.approval_version+1;
      const approvalDigest = digest({ runId, manifestHash, consentId:consent.id, consentDigest:consent.digest, approvedBy:who.id, membershipVersion:who.membershipVersion, approvedAt, expiresAt, version });
      await tx.query("UPDATE gh_seed_runs SET status='approved',approved_by=$3,membership_version=$4,approval_version=$5,approval_digest=$6,approved_at=$7,approval_expires_at=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2", [who.tenantId,runId,who.id,who.membershipVersion,version,approvalDigest,approvedAt,expiresAt]);
      await tx.query("INSERT INTO gh_jobs(tenant_id,id,kind,state,body) VALUES($1,$2,'seed_batch','queued',$3::jsonb) ON CONFLICT(tenant_id,id) DO NOTHING", [who.tenantId,'seed-'+runId,JSON.stringify({runId,manifestHash,approvedBy:who.id})]);
      await audit(tx,who,'seed.approved','Exact sandbox batch approved for durable processing',runId,{manifestHash,entryCount:run.manifest.entryCount,totalMinor:run.manifest.totalMinor,currency:'USD',expiresAt,approvalVersion:version});
    });
    return this.viewRun(who,runId);
  }
  async revoke(who: Actor, runId: string): Promise<SeedRun> {
    await this.db.transaction(async tx => {
      await currentMember(tx,who.tenantId,who.id,who.membershipVersion);
      const run = await runRecord(tx,who.tenantId,runId,true);
      if (run.consent_id) await tx.query("UPDATE gh_payment_consents SET status='revoked',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status <> 'revoked'", [who.tenantId,run.consent_id]);
      await tx.query("UPDATE gh_seed_runs SET status='revoked',updated_at=now() WHERE tenant_id=$1 AND id=$2", [who.tenantId,runId]);
      await audit(tx,who,'seed.authority_revoked','Sandbox batch authority revoked; existing outcomes remain available for reconciliation',runId);
    });
    return this.viewRun(who,runId);
  }
}
