import { PaypalError, VaultTokenRequestType, type PaypalClient, type SetupTokenRequest, type SetupTokenResponse, type PaymentTokenResponse } from 'paypal';
import { digest } from '@/packages/payments/security';
import type { OneWriteTransport } from './transport';

export interface VaultReceipt { source: 'sandbox'; transport: 'apimatic_sdk'; status: number; debugId: string | null; bodyHash: string; observedAt: string }
export interface SetupObservation {
  id: string; status: string; customerId: string; merchantCustomerId: string | null;
  payerId: string | null; approvalUrl: string | null; receipt: VaultReceipt;
}
export interface TokenObservation {
  id: string; customerId: string; merchantCustomerId: string | null; payerId: string;
  usageType: string | null; usagePattern: string | null; receipt: VaultReceipt;
}
export class VaultFailure extends Error {
  constructor(public readonly outcome: 'unknown' | 'not_sent' | 'refused', public readonly code: string, message: string, public readonly status = 502, public readonly debugId: string | null = null) { super(message); this.name = 'VaultFailure'; }
}
type Result<T> = { ok: true; value: T; status: number; headers: Headers } | { ok: false; status: number; headers: Headers; payload: unknown };
type Success<T> = { value: T; status: number; headers: Headers };
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{3,128}$/.test(id);
const incomplete = () => new VaultFailure('unknown', 'INCOMPLETE_VAULT_RESPONSE', 'PayPal returned incomplete saved-payment evidence. Reconciliation is required.');
function customerNotFound(payload: unknown): boolean {
  if(!payload || typeof payload!=='object')return false;
  let body:unknown='body' in payload?payload.body:null;
  if(!body && 'rawBody' in payload && payload.rawBody instanceof ArrayBuffer && payload.rawBody.byteLength<8192){try{body=JSON.parse(new TextDecoder().decode(payload.rawBody));}catch{return false;}}
  return !!body && typeof body==='object' && 'name' in body && body.name==='RESOURCE_NOT_FOUND' && 'details' in body && Array.isArray(body.details) && body.details.some(detail=>detail && typeof detail==='object' && 'issue' in detail && detail.issue==='CUSTOMER_ID_NOT_FOUND');
}

export class VaultGateway {
  constructor(private readonly client: PaypalClient, private readonly transport: OneWriteTransport) {}
  private async invoke<T>(work: (signal: AbortSignal) => Promise<Result<T>>, caller?: AbortSignal): Promise<Success<T>> {
    const deadline = AbortSignal.timeout(25_000);
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
    try {
      const result = await work(signal);
      if (!result.ok) throw new VaultFailure(result.status >= 400 && result.status < 500 ? 'refused' : 'unknown', result.status===404 && customerNotFound(result.payload)?'CUSTOMER_ID_NOT_FOUND':`PAYPAL_HTTP_${result.status}`, result.status === 403 ? 'PayPal has not enabled this saved-payment capability for the isolated application.' : 'PayPal did not confirm this saved-payment operation.', result.status, result.headers.get('paypal-debug-id'));
      return result;
    } catch (error) {
      if (error instanceof VaultFailure) throw error;
      if (error instanceof PaypalError) {
        if (error.kind === 'auth' || error.kind === 'encode') throw new VaultFailure('not_sent', `VAULT_${error.kind.toUpperCase()}`, 'Saved-payment setup could not be sent. Check the isolated connection.');
        if (error.kind === 'connection' || error.kind === 'timeout') throw new VaultFailure(error.uri.endsWith('/v1/oauth2/token') ? 'not_sent' : 'unknown', 'VAULT_RESPONSE_LOST', 'The response was lost. Glasshouse is holding this operation for reconciliation.');
        if (error.kind === 'decode') throw new VaultFailure(error.status >= 400 && error.status < 500 ? 'refused' : 'unknown', 'VAULT_RESPONSE_UNREADABLE', 'The provider response could not be verified.', error.status, error.headers.get('paypal-debug-id'));
      }
      // Abort and implementation failures can happen after the provider received the write.
      throw new VaultFailure('unknown', 'VAULT_INTERRUPTED', 'Saved-payment setup was interrupted. Reconciliation is required.');
    }
  }
  private receipt<T>(result: Success<T>, safe: unknown): VaultReceipt {
    return { source: 'sandbox', transport: 'apimatic_sdk', status: result.status, debugId: result.headers.get('paypal-debug-id'), bodyHash: digest(safe), observedAt: new Date().toISOString() };
  }
  private setup(result: Success<SetupTokenResponse>): SetupObservation {
    const value = result.value;
    if (!safeId(value.id) || !safeId(value.customer?.id) || !value.status) throw incomplete();
    const link = value.links?.find(link => link.rel === 'approve' && (!link.method || link.method === 'GET'));
    let approvalUrl: string | null = null;
    if (link) {
      const url = new URL(link.href);
      if (url.protocol !== 'https:' || !['sandbox.paypal.com', 'www.sandbox.paypal.com'].includes(url.hostname) || url.username || url.password || !url.pathname.startsWith('/agreements/')) throw incomplete();
      approvalUrl = url.href;
    }
    const safe = { id: value.id, status: value.status, customerId: value.customer.id, merchantCustomerId: value.customer.merchantCustomerId ?? null, payerId: value.paymentSource?.paypal?.payerId ?? null, approvalUrl };
    return { ...safe, receipt: this.receipt(result, safe) };
  }
  private token(result: Success<PaymentTokenResponse>): TokenObservation {
    const value = result.value;
    const wallet = value.paymentSource?.paypal;
    if (!safeId(value.id) || !safeId(value.customer?.id) || !safeId(wallet?.payerId)) throw incomplete();
    const safe = { id: value.id, customerId: value.customer.id, merchantCustomerId: value.customer.merchantCustomerId ?? null, payerId: wallet.payerId, usageType: wallet.usageType ?? null, usagePattern: wallet.usagePattern ?? null };
    return { ...safe, receipt: this.receipt(result, safe) };
  }
  async createSetup(requestId: string, body: SetupTokenRequest, caller?: AbortSignal): Promise<SetupObservation> {
    const result = await this.transport.run(requestId, '/v3/vault/setup-tokens', () => this.invoke(signal => this.client.vault.createSetupToken({ payPalRequestId: requestId, body }, { signal, retry: { maxRetries: 0 } }).asApiResult(), caller));
    return this.setup(result);
  }
  async getSetup(id: string, caller?: AbortSignal): Promise<SetupObservation> {
    if (!safeId(id)) throw incomplete();
    const result = this.setup(await this.invoke(signal => this.client.vault.getSetupToken({ id }, { signal }).asApiResult(), caller));
    if (result.id !== id) throw incomplete();
    return result;
  }
  async exchange(requestId: string, setup: SetupObservation, merchantCustomerId: string, caller?: AbortSignal, newCustomer=false): Promise<TokenObservation> {
    if (setup.status !== 'APPROVED') throw new VaultFailure('not_sent', 'BUYER_APPROVAL_REQUIRED', 'Complete the PayPal saved-payment approval first.', 409);
    const result = await this.transport.run(requestId, '/v3/vault/payment-tokens', () => this.invoke(signal => this.client.vault.createPaymentToken({
      payPalRequestId: requestId,
      body: { ...(newCustomer?{}:{customer:{id:setup.customerId,merchantCustomerId}}), paymentSource: { token: { id: setup.id, type: VaultTokenRequestType.SetupToken } } },
    }, { signal, retry: { maxRetries: 0 } }).asApiResult(), caller));
    return this.token(result);
  }
  async getToken(id: string, customerId: string, caller?: AbortSignal): Promise<TokenObservation> {
    if (!safeId(id) || !safeId(customerId)) throw incomplete();
    const token = this.token(await this.invoke(signal => this.client.vault.getPaymentToken({ id }, { signal }).asApiResult(), caller));
    if (token.id !== id || token.customerId !== customerId) throw new VaultFailure('refused', 'TOKEN_OWNERSHIP_MISMATCH', 'The saved payment method does not belong to this consent.', 403);
    return token;
  }
  async baselineTokens(setup: SetupObservation, merchantCustomerId: string, caller?: AbortSignal): Promise<{tokens:TokenObservation[];absence:VaultReceipt|null}> {
    try { return {tokens:await this.listTokens(setup.customerId,caller),absence:null}; }
    catch(error) {
      const age=Date.now()-Date.parse(setup.receipt.observedAt);
      if(!(error instanceof VaultFailure) || error.status!==404 || error.code!=='CUSTOMER_ID_NOT_FOUND' || setup.status!=='APPROVED' || setup.merchantCustomerId!==merchantCustomerId || !safeId(setup.payerId) || !Number.isFinite(age) || age< -1000 || age>60_000)throw error;
      return {tokens:[],absence:{source:'sandbox',transport:'apimatic_sdk',status:404,debugId:error.debugId,bodyHash:digest({operation:'listCustomerPaymentTokens',code:error.code,setupId:setup.id,customerId:setup.customerId}),observedAt:new Date().toISOString()}};
    }
  }
  async listTokens(customerId: string, caller?: AbortSignal): Promise<TokenObservation[]> {
    if (!safeId(customerId)) throw incomplete();
    const deadline = AbortSignal.timeout(25_000);
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
    const collected: TokenObservation[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | null = null;
    let expectedPages: number | null = null;
    for (let page = 1; page <= 20; page++) {
      const result = await this.invoke(s => this.client.vault.listCustomerPaymentTokens({ customerId, pageSize: 10, page, totalRequired: true }, { signal: s }).asApiResult(), signal);
      const value = result.value;
      if (!Number.isSafeInteger(value.totalItems) || !Number.isSafeInteger(value.totalPages) || value.totalItems! < 0 || value.totalPages! < 0 || value.totalItems! > 200 || value.totalPages! > 20 || value.customer?.id && value.customer.id !== customerId) throw incomplete();
      if (expectedTotal !== null && (expectedTotal !== value.totalItems || expectedPages !== value.totalPages)) throw incomplete();
      expectedTotal = value.totalItems!; expectedPages = value.totalPages!;
      const tokens = value.paymentTokens ?? (expectedTotal === 0 ? [] : undefined);
      if (!tokens || expectedPages === 0 && tokens.length || page < expectedPages && !tokens.length) throw incomplete();
      for (const value of tokens) {
        if (!safeId(value.id) || seen.has(value.id)) throw incomplete();
        seen.add(value.id);
        // The list can omit each entry's customer; its enclosing customer query supplies that identity.
        const normalized = this.token({ ...result, value: { ...value, customer: value.customer ?? { id: customerId } } });
        if (normalized.customerId !== customerId) throw incomplete();
        collected.push(normalized);
      }
      if (page >= expectedPages) {
        if (collected.length !== expectedTotal) throw incomplete();
        return collected;
      }
    }
    throw incomplete();
  }
}
