import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeliveryRevision, buildSnapshot, createSeedDataset, detectCarrierDelay, detectCheckoutDecline, detectMarginLeak } from '../packages/domain';
import { CARRIER_BASELINE_AT } from '../packages/domain/detectors';

const dataset = applyDeliveryRevision(createSeedDataset('tenant-detector-tests'));
const snapshot = buildSnapshot(dataset);
const baseline = buildSnapshot(dataset,{ asOf: CARRIER_BASELINE_AT });

test('carrier detection uses measured due-shipment counts and a declared baseline', () => {
  const detector = snapshot.detectors.find(value => value.kind === 'carrier_delay')!;
  assert.equal(detector.status,'detected');
  assert.equal(detector.baselineNumerator,0);
  assert.equal(detector.baselineDenominator,48);
  assert.equal(detector.currentNumerator,54);
  assert.equal(detector.currentDenominator,111);
  assert.equal(detector.delta,54/111);
  assert.equal(detector.threshold,0.15);
  assert.equal(detector.sourceClass,'fixture_shipping');
  assert.equal(detector.formulaVersion,'carrier-late-share-v1');
  assert.equal(detectCarrierDelay(snapshot.orders,[],snapshot.context).status,'insufficient_evidence');
  assert.equal(detectCarrierDelay(baseline.orders,baseline.orders,baseline.context).status,'normal');
});

test('margin detection computes source-priced gross margin and refuses absent or zero revenue', () => {
  const detector = snapshot.detectors.find(value => value.kind === 'margin_leak')!;
  assert.equal(detector.status,'normal');
  assert.equal(detector.baselineNumerator,835_210);
  assert.equal(detector.baselineDenominator,1_695_400);
  assert.equal(detector.currentNumerator,440_390);
  assert.equal(detector.currentDenominator,1_064_600);
  assert.equal(detector.delta,835_210/1_695_400-440_390/1_064_600);
  assert.equal(detectMarginLeak([],snapshot.orders,snapshot.context).status,'insufficient_evidence');
  const unpriced = dataset.events.map(event => event.type === 'order.priced' ? { ...event, payload: { ...event.payload, costSource: null } } : event);
  assert.equal(detectMarginLeak(unpriced,snapshot.orders,snapshot.context).status,'insufficient_evidence');
  const zero = dataset.events.map(event => event.type === 'order.priced' ? { ...event, payload: { ...event.payload, amountMinor: 0 } } : event);
  const insufficient = detectMarginLeak(zero,snapshot.orders,snapshot.context);
  assert.equal(insufficient.status,'insufficient_evidence');
  assert(Number.isFinite(insufficient.delta));
  const expensive = dataset.events.map(event => event.type === 'order.priced' && event.occurredAt >= '2026-11-04T00:00:00.000Z' ?
    { ...event, payload: { ...event.payload, costMinor: Number(event.payload.costMinor)+1000 } } : event);
  assert.equal(detectMarginLeak(expensive,snapshot.orders,snapshot.context).status,'detected');
});

test('checkout decline attempts have distinct denominators and cannot create payment inventory', () => {
  const detector = snapshot.detectors.find(value => value.kind === 'checkout_decline')!;
  assert.equal(detector.status,'detected');
  assert.equal(detector.baselineNumerator,3);
  assert.equal(detector.baselineDenominator,60);
  assert.equal(detector.currentNumerator,15);
  assert.equal(detector.currentDenominator,60);
  assert.equal(detector.delta,0.2);
  assert.equal(dataset.orders.length,600);
  assert.equal(snapshot.totals.captures,600);
  assert(dataset.events.filter(event => event.type === 'checkout.attempt').every(event => event.payload.providerResourceId === null));
  assert.equal(detectCheckoutDecline([],snapshot.context).status,'insufficient_evidence');
  const broken = dataset.events.map(event => event.type === 'checkout.attempt' && event.state === 'declined' ?
    { ...event, payload: { ...event.payload, errorCategory: null } } : event);
  assert.equal(detectCheckoutDecline(broken,snapshot.context).status,'insufficient_evidence');
  const attempts = dataset.events.filter(event => event.type === 'checkout.attempt');
  const duplicated = [...dataset.events,...attempts.map(event => ({ ...event, id: event.id+':duplicate' }))];
  const deduplicated = detectCheckoutDecline(duplicated,snapshot.context);
  assert.equal(deduplicated.currentDenominator,60);
  assert.equal(deduplicated.baselineDenominator,60);
  assert.equal(deduplicated.delta,detector.delta);
});

test('a historical cutoff does not observe future windows and never reports an invented anomaly', () => {
  const historic = buildSnapshot(dataset,{ asOf: '2026-11-03T10:00:00.000Z' });
  for (const kind of ['margin_leak','checkout_decline']) {
    const detector = historic.detectors.find(value => value.kind === kind)!;
    assert.equal(detector.status,'insufficient_evidence');
    assert.equal(detector.currentDenominator,0);
  }
});
