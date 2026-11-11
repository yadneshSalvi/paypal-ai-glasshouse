import { ProviderError } from '@fracture/paypal-core';
import { digest } from '@/packages/payments/security';
import type { OneWriteTransport } from '../payments/transport';

const ORIGIN = 'https://api-m.sandbox.paypal.com';
const ROOT = '/v1/customer/disputes';
const MAX_BODY = 512 * 1024;
const ACTIONS = ['provide-evidence', 'provide-supporting-info', 'escalate', 'adjudicate', 'require-evidence'] as const;
export type DisputeAction = typeof ACTIONS[number];
export interface DisputeOwner { captureId: string; amountMinor: number; currency: 'USD' }
export interface DisputeEvidence {
  type: string; source: string; date: string | null; itemId: string | null;
  notesHash: string | null; tracking: Array<{ carrier: string; carrierOther: string | null; number: string }>;
}
export interface DisputeObservation {
  id: string; captureId: string; buyerTransactionId: string; reason: string; status: string; stage: string;
  amountMinor: number; grossAmountMinor: number; currency: 'USD'; createdAt: string; updatedAt: string;
  sellerResponseDueAt: string | null; actions: DisputeAction[]; evidence: DisputeEvidence[];
  observedAt: string; bodyHash: string; debugId: string | null;
}
export interface DisputeInventory {
  captureId: string; ids: string[]; complete: true; observedAt: string; bodyHash: string;
  pages: Array<{ status: number; debugId: string | null; bodyHash: string }>;
}
export interface FulfillmentEvidence {
  disputeId: string; captureId: string; amountMinor: number; currency: 'USD';
  trackingNumber: string; carrierName: string; notes: string; operationId: string;
  expectedBodyHash?: string;
}
export interface RestReceipt { status: number; debugId: string | null; bodyHash: string; observedAt: string }
type ObjectValue = Record<string, unknown>;

const mismatch = (message = 'The dispute response did not establish exact owned resource evidence.') =>
  new ProviderError('decode', message, 'unknown', 409);
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw mismatch();
  return value as ObjectValue;
};
function string(value: unknown, max = 255): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw mismatch();
  return value;
}
function code(value: unknown): string {
  const result = string(value, 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(result)) throw mismatch();
  return result;
}
function caseId(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9-]+$/.test(result)) throw mismatch();
  return result;
}
function resourceId(value: unknown): string {
  const result = string(value, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw mismatch();
  return result;
}
function timestamp(value: unknown): string {
  const result = string(value, 64);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(result) || !Number.isFinite(Date.parse(result))) throw mismatch();
  return new Date(result).toISOString();
}
function amount(value: unknown): number {
  const money = object(value);
  if (money.currency_code !== 'USD' || typeof money.value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(money.value)) throw mismatch();
  const [whole, fraction = ''] = money.value.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw mismatch();
  return minor;
}
function links(value: unknown): ObjectValue[] {
  if (!Array.isArray(value) || value.length > 50) throw mismatch('PayPal did not return a complete allowed-link inventory.');
  return value.map(object);
}
function safeUrl(value: unknown): URL {
  let url: URL;
  try { url = new URL(string(value, 8192)); } catch { throw mismatch('An untrusted provider link was held.'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw mismatch('A provider link escaped the isolated sandbox scope.');
  return url;
}
function safeDebug(headers: Headers): string | null {
  const id = headers.get('paypal-debug-id');
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}
function boundedArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw mismatch();
  return value;
}
function normalizedEvidence(value: unknown): DisputeEvidence {
  const entry = object(value);
  const info = entry.evidence_info === undefined ? {} : object(entry.evidence_info);
  const tracking = info.tracking_info === undefined ? [] : boundedArray(info.tracking_info, 10).map(value => {
    const item = object(value);
    return { carrier: code(item.carrier_name), carrierOther: item.carrier_name_other === undefined ? null : string(item.carrier_name_other), number: string(item.tracking_number) };
  });
  return {
    type: code(entry.evidence_type), source: code(entry.source),
    date: entry.date === undefined ? null : timestamp(entry.date),
    itemId: entry.item_id === undefined ? null : string(entry.item_id),
    notesHash: entry.notes === undefined ? null : digest(string(entry.notes, 2000)), tracking,
  };
}

/** Safe normalized facts only. A merchant-readable case is not an application grant. */
export function normalizeDispute(value: unknown, id: string, owner: DisputeOwner, debugId: string | null = null): DisputeObservation {
  const body = object(value);
  if (caseId(body.dispute_id) !== caseId(id) || owner.currency !== 'USD' || !Number.isSafeInteger(owner.amountMinor)) throw mismatch();
  const transactions = boundedArray(body.disputed_transactions, 20);
  if (transactions.length !== 1) throw mismatch('The dispute includes a transaction outside this exact approved order.');
  const transaction = object(transactions[0]);
  if (resourceId(transaction.seller_transaction_id) !== resourceId(owner.captureId) || amount(transaction.gross_amount) !== owner.amountMinor) throw mismatch('The dispute does not belong to the expected captured payment.');
  const disputeAmount = amount(body.dispute_amount);
  if (disputeAmount > owner.amountMinor) throw mismatch();
  const actions = new Set<DisputeAction>();
  for (const link of links(body.links)) {
    if (link.method !== 'POST') continue;
    const href = safeUrl(link.href);
    if (href.search) continue;
    for (const action of ACTIONS) if (href.pathname === `${ROOT}/${id}/${action}`) actions.add(action);
  }
  const createdAt = timestamp(body.create_time), updatedAt = timestamp(body.update_time);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw mismatch();
  const facts = {
    id, captureId: owner.captureId, buyerTransactionId: resourceId(transaction.buyer_transaction_id),
    reason: code(body.reason), status: code(body.status), stage: code(body.dispute_life_cycle_stage),
    amountMinor: disputeAmount, grossAmountMinor: owner.amountMinor, currency: 'USD' as const, createdAt, updatedAt,
    sellerResponseDueAt: body.seller_response_due_date === undefined ? null : timestamp(body.seller_response_due_date),
    actions: [...actions].sort(), evidence: body.evidences === undefined ? [] : boundedArray(body.evidences, 100).map(normalizedEvidence),
  };
  return { ...facts, observedAt: new Date().toISOString(), bodyHash: digest(facts), debugId };
}

function evidenceBody(request: FulfillmentEvidence) {
  caseId(request.disputeId); resourceId(request.captureId); resourceId(request.operationId);
  if (request.currency !== 'USD' || !Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0 ||
    !request.trackingNumber.startsWith('SYNTHETIC-') || !request.notes.includes(`Glasshouse operation ${request.operationId}.`) ||
    !request.notes.includes('Sandbox exercise; synthetic shipping evidence. No physical delivery is asserted.')) {
    throw new ProviderError('encode', 'Only the exact approved, explicitly labelled sandbox evidence may be submitted.', 'not_sent', 409);
  }
  return { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{
    carrier_name: 'OTHER', carrier_name_other: string(request.carrierName), tracking_number: string(request.trackingNumber),
  }] }, notes: string(request.notes, 2000) }] };
}
export function evidenceObserved(observation: DisputeObservation, request: FulfillmentEvidence): boolean {
  return observation.id === request.disputeId && observation.captureId === request.captureId && observation.evidence.some(item =>
    item.source === 'SUBMITTED_BY_SELLER' && item.type === 'PROOF_OF_FULFILLMENT' && item.itemId === null &&
    item.notesHash === digest(request.notes) && item.tracking.length === 1 &&
    item.tracking[0].carrier === 'OTHER' && item.tracking[0].carrierOther === request.carrierName && item.tracking[0].number === request.trackingNumber);
}

/** The SDK has no Disputes resource. This adapter implements only the contracted fixed sandbox paths. */
export class DisputesGateway {
  private credential: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly transport: OneWriteTransport) {}

  private async json(response: Response): Promise<unknown> {
    if (!response.body) throw mismatch();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.byteLength;
        if (size > MAX_BODY) { await reader.cancel(); throw mismatch('The bounded provider response was incomplete.'); }
        chunks.push(value.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) { if (error instanceof ProviderError) throw error; throw mismatch('PayPal did not return a complete readable response.'); }
    finally { reader.releaseLock(); }
  }
  private async token(signal: AbortSignal): Promise<string> {
    if (this.credential && this.credential.expiresAt > Date.now() + 60_000) return this.credential.token;
    this.refreshing ??= (async () => {
      const response = await this.transport.fetch(`${ORIGIN}/v1/oauth2/token`, {
        method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials', signal, redirect: 'error', cache: 'no-store',
      });
      if (response.status !== 200) { await response.body?.cancel(); throw new ProviderError('auth', 'The isolated merchant credentials could not authorize this read.', 'not_sent', response.status, safeDebug(response.headers)); }
      const body = object(await this.json(response));
      if (typeof body.access_token !== 'string' || body.access_token.length < 8 || body.access_token.length > 8192 || body.token_type !== 'Bearer' ||
        !Number.isSafeInteger(body.expires_in) || Number(body.expires_in) <= 0 || Number(body.expires_in) > 86400) throw mismatch('PayPal credentials did not include a valid expiry.');
      this.credential = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 };
      return body.access_token;
    })().finally(() => { this.refreshing = null; });
    return untilSignal(this.refreshing, signal);
  }
  private async request(path: string, signal: AbortSignal, body?: FormData): Promise<{ value: unknown; receipt: RestReceipt }> {
    const token = await this.token(signal);
    signal.throwIfAborted();
    const response = await this.transport.fetch(`${ORIGIN}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body, signal, redirect: 'error', cache: 'no-store' });
    const debugId = safeDebug(response.headers);
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 401) this.credential = null;
      throw new ProviderError('api', response.status === 401 || response.status === 403 ? 'This merchant cannot perform the requested dispute operation.' : 'PayPal did not confirm the requested dispute operation.',
        body && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 'rejected' : 'unknown', response.status, debugId);
    }
    const value = await this.json(response);
    return { value, receipt: { status: response.status, debugId, bodyHash: digest(value), observedAt: new Date().toISOString() } };
  }
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    const deadline = AbortSignal.timeout(25_000);
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
    try { return await untilSignal(work(signal), signal); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted ? 'timeout' : 'connection', 'The original dispute operation requires an independent read before further action.', 'unknown', 502);
    }
  }
  async list(owner: DisputeOwner, caller?: AbortSignal): Promise<DisputeInventory> {
    resourceId(owner.captureId);
    return this.bounded(async signal => {
      let path = `${ROOT}?${new URLSearchParams({ disputed_transaction_id: owner.captureId, page_size: '50' })}`;
      const ids = new Set<string>(), cursors = new Set<string>(), pages: DisputeInventory['pages'] = [];
      for (let page = 0; page < 20; page++) {
        if (cursors.has(path)) throw mismatch('PayPal repeated a dispute page; absence has not been established.');
        cursors.add(path);
        const response = await this.request(path, signal);
        const result = object(response.value);
        const items = boundedArray(result.items, 50);
        for (const value of items) {
          const id = caseId(object(value).dispute_id);
          if (ids.has(id)) throw mismatch('PayPal repeated a dispute identity; the inventory is incomplete.');
          ids.add(id);
        }
        pages.push({ status: response.receipt.status, debugId: response.receipt.debugId, bodyHash: response.receipt.bodyHash });
        const next = links(result.links).filter(link => link.rel === 'next');
        if (!next.length) {
          const ordered = [...ids].sort();
          return { captureId: owner.captureId, ids: ordered, complete: true, observedAt: new Date().toISOString(), bodyHash: digest({ captureId: owner.captureId, ids: ordered }), pages };
        }
        if (next.length !== 1 || !items.length || next[0].method !== 'GET') throw mismatch('The dispute inventory did not make bounded progress.');
        const url = safeUrl(next[0].href);
        const allowed = ['disputed_transaction_id', 'page_size', 'next_page_token', 'page'];
        if (url.pathname !== ROOT || [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1) ||
          url.searchParams.get('disputed_transaction_id') !== owner.captureId || url.searchParams.get('page_size') !== '50' ||
          (!url.searchParams.has('page') && !url.searchParams.has('next_page_token'))) throw mismatch('The next dispute page did not retain the owned capture scope.');
        path = `${ROOT}?${url.searchParams.toString()}`;
      }
      throw mismatch('The dispute inventory exceeded its bound; it is not complete.');
    }, caller);
  }
  async get(id: string, owner: DisputeOwner, caller?: AbortSignal): Promise<DisputeObservation> {
    caseId(id);
    return this.bounded(async signal => {
      const response = await this.request(`${ROOT}/${id}`, signal);
      return normalizeDispute(response.value, id, owner, response.receipt.debugId);
    }, caller);
  }
  async provideEvidence(request: FulfillmentEvidence, authorize: () => Promise<void>, caller?: AbortSignal): Promise<{ receipt: RestReceipt; observation: DisputeObservation; submitted: boolean }> {
    const body = evidenceBody(request);
    return this.bounded(async signal => {
      const path = `${ROOT}/${request.disputeId}`;
      const current = await this.request(path, signal);
      const observation = normalizeDispute(current.value, request.disputeId, request, current.receipt.debugId);
      if(request.expectedBodyHash && observation.bodyHash!==request.expectedBodyHash && !evidenceObserved(observation,request))throw new ProviderError('encode','The case changed after its exact evidence review. Prepare a fresh manifest.','not_sent',409);
      if (observation.status !== 'WAITING_FOR_SELLER_RESPONSE' || !['INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'].includes(observation.stage) ||
        !observation.actions.includes('provide-evidence') || observation.sellerResponseDueAt !== null && Date.parse(observation.sellerResponseDueAt) <= Date.now() ||
        !observation.evidence.some(item => item.source === 'REQUESTED_FROM_SELLER' && item.type === 'PROOF_OF_FULFILLMENT' && item.itemId === null)) {
        throw new ProviderError('encode', 'The current owned case does not permit this exact fulfillment evidence.', 'not_sent', 409);
      }
      if (evidenceObserved(observation, request)) throw new ProviderError('encode', 'The original evidence is already present; reconcile its receipt.', 'not_sent', 409);
      signal.throwIfAborted();
      const form = new FormData();
      form.append('input', new Blob([JSON.stringify(body)], { type: 'application/json' }));
      const response = await this.transport.run(request.operationId, `${path}/provide-evidence`, () => this.request(`${path}/provide-evidence`, signal, form),async()=>{
        try{await authorize();}catch{throw new ProviderError('encode','Current application authority did not permit the original evidence write.','not_sent',403);}
      });
      links(object(response.value).links);
      const reread = await this.request(path, signal);
      const verified = normalizeDispute(reread.value, request.disputeId, request, reread.receipt.debugId);
      return { receipt: response.receipt, observation: verified, submitted: evidenceObserved(verified, request) };
    }, caller);
  }
}

function untilSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
