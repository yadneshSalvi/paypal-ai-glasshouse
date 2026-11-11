import type { PaypalClient, Order, CapturedPayment } from 'paypal';
import { fromProviderMoney, ProviderError } from '@fracture/paypal-core';
import type { SeedManifestEntry } from '@/packages/payments/types';
import { digest } from '@/packages/payments/security';

export interface OwnedOrderEvidence {
  id: string; status: string; customId: string; amountMinor: number; currency: 'USD';
  captureIds: string[]; refundIds: string[]; approvalUrl: string | null;
  trackers: Array<{id:string;status:string;createdAt:string|null;updatedAt:string|null}>;
  observedAt: string; bodyHash: string; debugId: string | null;
}
export interface CaptureEvidence {
  id: string; orderId: string; status: string; amountMinor: number; currency: 'USD';
  occurredAt: string; observedAt: string; bodyHash: string; debugId: string | null;
}
type Result<T> = {ok:true;value:T;status:number;headers:Headers}|{ok:false;status:number;headers:Headers;payload:unknown};
const mismatch = () => new ProviderError('decode', 'The provider resource does not match this exact Glasshouse order.', 'unknown', 409);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{3,128}$/.test(value);

export class OrderEvidenceGateway {
  constructor(private readonly client: PaypalClient) {}
  private async read<T>(work: (signal: AbortSignal) => Promise<Result<T>>, caller?: AbortSignal) {
    const deadline = AbortSignal.timeout(25_000);
    try {
      const result = await work(caller ? AbortSignal.any([caller, deadline]) : deadline);
      if (!result.ok) throw new ProviderError('api', 'The independent provider read did not confirm this resource.', 'unknown', result.status, result.headers.get('paypal-debug-id'));
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('connection', 'The independent provider read could not finish. The saved operation will be reconciled.', 'unknown', 502);
    }
  }
  async order(id: string, expected: SeedManifestEntry, customId: string, caller?: AbortSignal): Promise<OwnedOrderEvidence> {
    if (!validId(id)) throw mismatch();
    const result = await this.read<Order>(signal => this.client.orders.getOrder({ id }, { signal }).asApiResult(), caller);
    const value = result.value;
    const unit = value.purchaseUnits?.length === 1 ? value.purchaseUnits[0] : undefined;
    if (value.id !== id || !value.status || !unit?.amount || unit.customId !== customId) throw mismatch();
    const amount = fromProviderMoney(unit.amount);
    if (amount.currency !== expected.currency || amount.minor !== expected.amountMinor) throw mismatch();
    const captureIds = (unit.payments?.captures ?? []).map(item => item.id);
    const refundIds = (unit.payments?.refunds ?? []).map(item => item.id);
    if (captureIds.some(id => !validId(id)) || refundIds.some(id => !validId(id)) || new Set(captureIds).size !== captureIds.length || new Set(refundIds).size !== refundIds.length) throw mismatch();
    const trackers=(unit.shipping?.trackers??[]).map(tracker=>{
      if(typeof tracker.id!=='string'||!/^[A-Za-z0-9_-]{1,255}$/.test(tracker.id)||typeof tracker.status!=='string'||!/^[A-Z_]{1,64}$/.test(tracker.status))throw mismatch();
      const time=(value:string|undefined)=>{if(value===undefined)return null;if(!Number.isFinite(Date.parse(value)))throw mismatch();return new Date(value).toISOString();};
      return {id:tracker.id,status:tracker.status,createdAt:time(tracker.createTime),updatedAt:time(tracker.updateTime)};
    });
    if(trackers.length>100||new Set(trackers.map(tracker=>tracker.id)).size!==trackers.length)throw mismatch();
    const link = value.links?.find(link => ['approve', 'payer-action'].includes(link.rel));
    let approvalUrl: string | null = null;
    if (link) {
      const url = new URL(link.href);
      if (url.protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname) || url.username || url.password) throw mismatch();
      approvalUrl = url.href;
    }
    const safe = { id, status: value.status, customId, amountMinor: amount.minor, currency: 'USD' as const, captureIds: captureIds as string[], refundIds: refundIds as string[], trackers, approvalUrl };
    return { ...safe, observedAt: new Date().toISOString(), bodyHash: digest(safe), debugId: result.headers.get('paypal-debug-id') };
  }
  async capture(id: string, order: OwnedOrderEvidence, expected: SeedManifestEntry, caller?: AbortSignal): Promise<CaptureEvidence> {
    if (!validId(id) || order.captureIds.length !== 1 || order.captureIds[0] !== id) throw mismatch();
    const result = await this.read<CapturedPayment>(signal => this.client.payments.getCapturedPayment({ captureId: id }, { signal }).asApiResult(), caller);
    const value = result.value;
    if (value.id !== id || !value.amount || value.status !== 'COMPLETED' || !value.createTime || !Number.isFinite(Date.parse(value.createTime))) throw mismatch();
    if (value.supplementaryData?.relatedIds?.orderId && value.supplementaryData.relatedIds.orderId !== order.id) throw mismatch();
    const money = fromProviderMoney(value.amount);
    if (money.currency !== expected.currency || money.minor !== expected.amountMinor) throw mismatch();
    const safe = { id, orderId: order.id, status: value.status, amountMinor: money.minor, currency: 'USD' as const, occurredAt: new Date(value.createTime).toISOString() };
    return { ...safe, observedAt: new Date().toISOString(), bodyHash: digest(safe), debugId: result.headers.get('paypal-debug-id') };
  }
}
