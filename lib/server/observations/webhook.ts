import { AsyncLocalStorage } from 'node:async_hooks';
import { PayPalWebhookVerifier, type SandboxConfig, type WebhookVerifier } from '@fracture/paypal-core';
import { HttpError } from '../errors';

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const ORIGIN = 'https://api-m.sandbox.paypal.com';
export const SIGNATURE_HEADERS = ['paypal-transmission-id','paypal-transmission-time','paypal-cert-url','paypal-auth-algo','paypal-transmission-sig'] as const;
export interface ResourceHint { kind:'order'|'capture'|'refund'|'dispute'; id:string }
export interface WebhookHint {
  eventId:string; eventType:string; occurredAt:string; primary:ResourceHint|null; resources:ResourceHint[];
  merchantIds:string[]; supported:boolean;
}
const object = (value: unknown): Record<string,unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const identity = (value: unknown): string|null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;

export async function boundedBody(body: ReadableStream<Uint8Array>|null, max: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new HttpError(400,'BODY_REQUIRED','A complete provider event body is required.');
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort',abort,{once:true});
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > max) { await reader.cancel(); throw new HttpError(413,'BODY_TOO_LARGE','The provider event exceeded the bounded receipt size.'); }
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort',abort);reader.releaseLock(); }
}

export async function rawWebhook(request: Request): Promise<string> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415,'JSON_REQUIRED','Send the original PayPal JSON event.');
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_WEBHOOK_BYTES)) throw new HttpError(413,'BODY_TOO_LARGE','The provider event exceeded the bounded receipt size.');
  const bytes = await boundedBody(request.body,MAX_WEBHOOK_BYTES,AbortSignal.any([request.signal,AbortSignal.timeout(10_000)]));
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); }
  catch { throw new HttpError(400,'INVALID_EVENT_ENCODING','The provider event must be complete UTF-8 JSON.'); }
}

export function validSignatureHeaders(headers: Headers): boolean {
  const id = headers.get('paypal-transmission-id'), time = headers.get('paypal-transmission-time'), cert = headers.get('paypal-cert-url');
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !time || time.length > 64 || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(time) ||
    !Number.isFinite(Date.parse(time)) || Date.parse(time) > Date.now()+300_000 || headers.get('paypal-auth-algo') !== 'SHA256withRSA') return false;
  const signature = headers.get('paypal-transmission-sig');
  if (!signature || signature.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try {
    const url = new URL(cert ?? '');
    return ['https://api.sandbox.paypal.com',ORIGIN].includes(url.origin) && !url.username && !url.password && !url.search && !url.hash &&
      /^\/v1\/notifications\/certs\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname);
  } catch { return false; }
}

/** The pinned core supplies the exact postback contract; this wrapper bounds its entire read. */
export class BoundedWebhookVerifier implements WebhookVerifier {
  private readonly deadline = new AsyncLocalStorage<AbortSignal>();
  private readonly verifier: PayPalWebhookVerifier;
  constructor(config: SandboxConfig, webhookId: string, transport: typeof fetch = fetch) {
    const bounded: typeof fetch = async (input,init) => {
      const request = new Request(input,init), url = new URL(request.url);
      if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password || request.method !== 'POST' ||
        !['/v1/oauth2/token','/v1/notifications/verify-webhook-signature'].includes(url.pathname)) throw new HttpError(502,'VERIFICATION_SCOPE_DENIED','The verification request escaped its fixed sandbox scope.');
      const deadline = this.deadline.getStore();
      if (!deadline) throw new HttpError(502,'VERIFICATION_DEADLINE_REQUIRED','The notification verifier needs a bounded request.');
      const signal = AbortSignal.any([request.signal,deadline]);
      const response = await transport(new Request(request,{signal,redirect:'error',cache:'no-store'}));
      const bytes = await boundedBody(response.body,128*1024,signal);
      return new Response(bytes as BodyInit,{status:response.status,headers:response.headers});
    };
    this.verifier = new PayPalWebhookVerifier(config,webhookId,bounded);
  }
  async verify(rawBody: string, headers: Headers) {
    if (!validSignatureHeaders(headers)) return {verified:false,transmissionId:headers.get('paypal-transmission-id') ?? 'missing'};
    return this.deadline.run(AbortSignal.timeout(25_000),() => this.verifier.verify(rawBody,headers));
  }
}

export function parseWebhook(raw: string): WebhookHint {
  let event: Record<string,unknown>;
  try { event = object(JSON.parse(raw)); } catch { throw new HttpError(400,'INVALID_EVENT_JSON','The original provider event is not valid JSON.'); }
  const eventId = identity(event.id), eventType = event.event_type, occurredAt = event.create_time;
  if (!eventId || typeof eventType !== 'string' || !/^[A-Z][A-Z0-9._-]{1,120}$/.test(eventType) || typeof occurredAt !== 'string' || occurredAt.length > 64 ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) throw new HttpError(400,'EVENT_IDENTITY_REQUIRED','The provider event identity, type and time must be complete.');
  const resource = object(event.resource), related = object(object(resource.supplementary_data).related_ids);
  const resources: ResourceHint[] = [], merchantIds: string[] = [];
  const add = (kind: ResourceHint['kind'], value: unknown) => { const id = identity(value);if (id && !resources.some(item => item.kind === kind && item.id === id)) resources.push({kind,id}); };
  const merchant = (value: unknown) => { if (value !== undefined) { const id = identity(value);if (!id) throw new HttpError(400,'MERCHANT_IDENTITY_INVALID','The provider merchant metadata is incomplete.');merchantIds.push(id); } };
  merchant(object(resource.payee).merchant_id);merchant(resource.seller_merchant_id);merchant(object(resource.seller).merchant_id);
  let kind: ResourceHint['kind']|null = null, primaryId: string|null = identity(resource.id);
  if (/^CUSTOMER\.DISPUTE\.(CREATED|UPDATED|RESOLVED)$/.test(eventType)) {
    kind = 'dispute';primaryId = identity(resource.dispute_id) ?? primaryId;
    const transactions = resource.disputed_transactions;
    if (Array.isArray(transactions) && transactions.length === 1) add('capture',object(transactions[0]).seller_transaction_id);
  } else if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || /^PAYMENT\.REFUND\.(COMPLETED|PENDING|FAILED|DENIED)$/.test(eventType)) kind = 'refund';
  else if (/^PAYMENT\.CAPTURE\.(COMPLETED|PENDING|DECLINED|DENIED|REVERSED)$/.test(eventType)) kind = 'capture';
  else if (/^CHECKOUT\.ORDER\.(APPROVED|COMPLETED|PROCESSED)$/.test(eventType)) kind = 'order';
  const primary = kind && primaryId ? {kind,id:primaryId} : null;
  if (primary) add(primary.kind,primary.id);
  add('order',related.order_id);add('capture',related.capture_id);
  if (kind === 'refund' && Array.isArray(resource.links)) for (const item of resource.links.slice(0,50)) {
    const link = object(item);
    if (link.rel !== 'up' || link.method !== 'GET' || typeof link.href !== 'string') continue;
    try {
      const url = new URL(link.href), match = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      if (match && [ORIGIN,'https://api.sandbox.paypal.com'].includes(url.origin) && !url.username && !url.password && !url.search && !url.hash) add('capture',match[1]);
    } catch { /* An untrusted URL never becomes a read target. */ }
  }
  return {eventId,eventType,occurredAt:new Date(occurredAt).toISOString(),primary,resources,merchantIds,supported:kind!==null && primary!==null};
}
