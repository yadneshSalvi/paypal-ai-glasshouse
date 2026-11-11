import type { Detector, QueryContext, SnapshotOrder, SourceEvent } from './types';
import { STORY_START } from './seed';

export const CARRIER_BASELINE_AT = '2026-11-03T07:59:59.999Z';
export const COMPARISON_SPLIT_AT = '2026-11-04T00:00:00.000Z';
const MIN_OBSERVATIONS = 20;
const finiteMoney = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const time = (event: SourceEvent, context: QueryContext) => Date.parse(context.clockDomain === 'observed' ? event.occurredAt : event.narrativeTime);
const visible = (events: readonly SourceEvent[], context: QueryContext) => events.filter(event => event.tenantId === context.tenantId &&
  Date.parse(event.ingestedAt) <= Date.parse(context.knownAt) && time(event, context) <= Date.parse(context.asOf));
const share = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : 0;

export function detectCarrierDelay(currentOrders: readonly SnapshotOrder[], baselineOrders: readonly SnapshotOrder[], context: QueryContext): Detector {
  function measure(orders: readonly SnapshotOrder[], cutoff: string) {
    const region = orders.filter(order => order.regionCode === 'PNW');
    const missing = region.some(order => !Number.isFinite(Date.parse(order.promisedAt)) || order.fulfillmentState === 'unknown');
    const due = region.filter(order => Number.isFinite(Date.parse(order.promisedAt)) && Date.parse(order.promisedAt) <= Date.parse(cutoff) && order.fulfillmentState !== 'unknown');
    return { numerator: due.filter(order => ['delayed','in_transit','shipped'].includes(order.fulfillmentState)).length, denominator: due.length, missing };
  }
  const baselineAt = new Date(Math.min(Date.parse(CARRIER_BASELINE_AT), Date.parse(context.asOf))).toISOString();
  const baseline = measure(baselineOrders, baselineAt);
  const current = measure(currentOrders, context.asOf);
  const delta = share(current.numerator, current.denominator) - share(baseline.numerator, baseline.denominator);
  const insufficient = baseline.missing || current.missing || baseline.denominator < MIN_OBSERVATIONS || current.denominator < MIN_OBSERVATIONS;
  return { id: 'detector-carrier-delay', kind: 'carrier_delay', title: 'Pacific Northwest carrier delay',
    status: insufficient ? 'insufficient_evidence' : delta >= 0.15 && current.numerator >= 10 ? 'detected' : 'normal',
    formulaVersion: 'carrier-late-share-v1', baselineNumerator: baseline.numerator, baselineDenominator: baseline.denominator,
    currentNumerator: current.numerator, currentDenominator: current.denominator, delta, threshold: 0.15,
    window: `PNW due-shipment inventory at ${baselineAt} versus ${context.asOf}; knowledge ${context.knownAt}`,
    sourceClass: 'fixture_shipping', explanation: insufficient ?
      `Insufficient evidence: each window needs ${MIN_OBSERVATIONS} observed due shipments and complete promised-date/state inputs.` :
      `${current.numerator}/${current.denominator} currently due PNW shipments are undelivered versus ${baseline.numerator}/${baseline.denominator} at baseline. The rule requires a 15 percentage-point increase and 10 affected orders. Fixture carrier scans support a shared handoff hypothesis; warehouse backlog and stale scans remain alternatives.` };
}

export function detectMarginLeak(events: readonly SourceEvent[], orders: readonly SnapshotOrder[], context: QueryContext): Detector {
  const allowed = new Set(orders.map(order => order.id));
  const priced = visible(events, context).filter(event => event.type === 'order.priced' && allowed.has(event.orderId) && event.payload.currency === context.currency);
  // One latest source-priced record per order. Duplicate observations cannot multiply revenue.
  const byOrder = new Map<string, SourceEvent>();
  for (const event of priced.slice().sort((a,b) => time(a,context) - time(b,context) || a.id.localeCompare(b.id))) byOrder.set(event.orderId,event);
  const split = Date.parse(COMPARISON_SPLIT_AT);
  function measure(current: boolean) {
    const rows = [...byOrder.values()].filter(event => time(event,context) >= Date.parse(STORY_START) && (time(event,context) >= split) === current);
    const missing = rows.some(event => !finiteMoney(event.payload.amountMinor) || !finiteMoney(event.payload.costMinor) || !event.payload.costSource || !event.payload.pricingRuleId);
    const valid = rows.filter(event => finiteMoney(event.payload.amountMinor) && finiteMoney(event.payload.costMinor) && event.payload.costSource && event.payload.pricingRuleId);
    const revenue = valid.reduce((sum,event) => sum + Number(event.payload.amountMinor),0);
    const cost = valid.reduce((sum,event) => sum + Number(event.payload.costMinor),0);
    return { count: valid.length, numerator: revenue-cost, denominator: revenue, missing };
  }
  const baseline = measure(false), current = measure(true);
  const missingOrders = orders.some(order => ['captured','completed'].includes(order.paymentState) && !byOrder.has(order.id));
  const insufficient = missingOrders || baseline.missing || current.missing || baseline.count < MIN_OBSERVATIONS || current.count < MIN_OBSERVATIONS || baseline.denominator <= 0 || current.denominator <= 0;
  const delta = share(baseline.numerator,baseline.denominator) - share(current.numerator,current.denominator);
  return { id: 'detector-margin-leak', kind: 'margin_leak', title: 'Source-priced gross margin change',
    status: insufficient ? 'insufficient_evidence' : delta >= 0.08 ? 'detected' : 'normal', formulaVersion: 'source-priced-gross-margin-v1',
    baselineNumerator: baseline.numerator, baselineDenominator: baseline.denominator, currentNumerator: current.numerator,
    currentDenominator: current.denominator, delta, threshold: 0.08,
    window: `${STORY_START} to ${COMPARISON_SPLIT_AT} versus ${COMPARISON_SPLIT_AT} to ${context.asOf}; ${context.currency} only`,
    sourceClass: 'sample', explanation: insufficient ?
      `Insufficient evidence: source-priced revenue, supplier cost, pricing rule and at least ${MIN_OBSERVATIONS} orders are required in each window.` :
      `Measured gross margin (revenue minus fixture supplier cost, divided by revenue) fell by ${(delta*100).toFixed(2)} percentage points across ${baseline.count} baseline and ${current.count} current orders. This excludes payment fees and is not booked net profit. Discount-rule changes and product mix are competing explanations.` };
}

export function detectCheckoutDecline(events: readonly SourceEvent[], context: QueryContext): Detector {
  const attempts = visible(events,context).filter(event => event.type === 'checkout.attempt' && event.payload.currency === context.currency);
  const unique = new Map<string, SourceEvent>();
  let missing = false;
  for (const event of attempts.slice().sort((a,b) => Date.parse(a.ingestedAt)-Date.parse(b.ingestedAt) || a.id.localeCompare(b.id))) {
    if (typeof event.payload.attemptId !== 'string' || !['approved','declined','error'].includes(String(event.payload.status)) ||
      event.payload.status === 'declined' && !['payer_declined','payment_denied'].includes(String(event.payload.errorCategory))) { missing = true; continue; }
    unique.set(event.payload.attemptId,event);
  }
  const split = Date.parse(COMPARISON_SPLIT_AT);
  const baseline = [...unique.values()].filter(event => time(event,context) >= Date.parse(STORY_START) && time(event,context) < split);
  const current = [...unique.values()].filter(event => time(event,context) >= split);
  const b = baseline.filter(event => event.payload.status === 'declined').length;
  const c = current.filter(event => event.payload.status === 'declined').length;
  const delta = share(c,current.length)-share(b,baseline.length);
  const insufficient = missing || baseline.length < MIN_OBSERVATIONS || current.length < MIN_OBSERVATIONS;
  return { id: 'detector-checkout-decline', kind: 'checkout_decline', title: 'Checkout decline cluster',
    status: insufficient ? 'insufficient_evidence' : delta >= 0.15 && c >= 10 ? 'detected' : 'normal',
    formulaVersion: 'checkout-attempt-decline-share-v1', baselineNumerator: b, baselineDenominator: baseline.length,
    currentNumerator: c, currentDenominator: current.length, delta, threshold: 0.15,
    window: `${STORY_START} to ${COMPARISON_SPLIT_AT} versus ${COMPARISON_SPLIT_AT} to ${context.asOf}; distinct attempt IDs`,
    sourceClass: 'sample', explanation: insufficient ?
      `Insufficient evidence: each window requires ${MIN_OBSERVATIONS} distinct attempts with known outcomes and a documented decline taxonomy.` :
      `${c}/${current.length} current attempts declined versus ${b}/${baseline.length} at baseline. Payer declines and payment denials count; transport errors do not. These Sample adapter attempts did not create PayPal transactions. Payer mix and a checkout integration change remain alternative explanations.` };
}

export function runDetectors(orders: readonly SnapshotOrder[], baselineOrders: readonly SnapshotOrder[], events: readonly SourceEvent[], context: QueryContext): Detector[] {
  return [detectCarrierDelay(orders,baselineOrders,context),detectMarginLeak(events,orders,context),detectCheckoutDecline(events,context)];
}
