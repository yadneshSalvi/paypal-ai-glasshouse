import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeliveryRevision, buildSnapshot, createSeedDataset, evaluateBranches } from '../packages/domain';
import { appendStateObservation } from '../packages/domain/seed';
import type { SnapshotOrder, SourceEvent } from '../packages/domain';

const dataset = applyDeliveryRevision(createSeedDataset('tenant-policy-tests'));
const latest = buildSnapshot(dataset);
const eligible = latest.orders.find(order => order.seedGroup === 'eligible')!;
const decision = (patch: Partial<SnapshotOrder> = {}) => evaluateBranches([{ ...eligible, ...patch }],30_000,'policy-test-snapshot');
const fails = (patch: Partial<SnapshotOrder>, key: string) => {
  const row = decision(patch)[0].rows[0];
  assert.equal(row.eligible,false);
  assert(row.excludedReasons.includes(key));
};

test('48-hour eligibility has an exact inclusive boundary on the supplied snapshot clock', () => {
  assert.equal(decision({ lateHours: 47+59/60 })[0].eligibleCount,0);
  assert.equal(decision({ lateHours: 48 })[0].eligibleCount,1);
  assert.equal(decision({ lateHours: 0 })[1].eligibleCount,1);
  assert.equal(decision({ lateHours: -1/60 })[1].eligibleCount,0);
  const boundary = Date.parse(eligible.promisedAt)+48*3_600_000;
  const before = buildSnapshot(dataset,{ asOf: new Date(boundary-1).toISOString() }).orders.find(order => order.id === eligible.id)!;
  const exact = buildSnapshot(dataset,{ asOf: new Date(boundary).toISOString() }).orders.find(order => order.id === eligible.id)!;
  assert.equal(evaluateBranches([before])[0].eligibleCount,0);
  assert.equal(evaluateBranches([exact])[0].eligibleCount,1);
});

test('ordinary refunds exclude delivery, disputes, earlier remedies, and inadequate balances independently', () => {
  fails({ fulfillmentState: 'delivered' },'undelivered');
  fails({ fulfillmentState: 'unknown' },'undelivered');
  fails({ disputeOpen: true, disputeState: 'open' },'dispute');
  fails({ disputeOpen: false, disputeState: 'open' },'dispute');
  fails({ refundedMinor: 1 },'prior_remedy');
  fails({ goodwillCreditMinor: 500 },'prior_remedy');
  fails({ remediationState: 'refunded' },'prior_remedy');
  fails({ refundableMinor: 499 },'balance');
  fails({ refundableMinor: eligible.amountMinor+1 },'balance');
  fails({ paymentState: 'pending' },'balance');
  assert.equal(decision({ refundableMinor: 500 })[0].eligibleCount,1);
  for (const branch of latest.branches) {
    assert(branch.actions.filter(action => action.kind === 'refund').every(action => !latest.orders.find(order => order.id === action.orderId)!.disputeOpen));
  }
});

test('missing and malformed policy inputs fail closed with the same five condition keys', () => {
  fails({ lateHours: Number.NaN },'grace');
  fails({ promisedAt: '' },'grace');
  fails({ disputeState: null },'dispute');
  fails({ disputeOpen: undefined as unknown as boolean },'dispute');
  fails({ refundedMinor: undefined as unknown as number },'prior_remedy');
  fails({ goodwillCreditMinor: -1 },'prior_remedy');
  fails({ remediationState: 'unknown' },'prior_remedy');
  fails({ refundableMinor: Number.NaN },'balance');
  fails({ refundableMinor: 500.5 },'balance');
  fails({ amountMinor: undefined as unknown as number },'balance');
  assert.equal(decision()[0].rows[0].conditions.length,5);
});

test('currency boundaries and exact budgets never alter the eligible cohort or manufacture conversion', () => {
  assert.throws(() => evaluateBranches([eligible,{ ...eligible, id: 'euro-order', currency: 'EUR' }]),/combine currencies/);
  assert.equal(decision({ currency: 'EUR' })[0].eligibleCount,0);
  assert.equal(evaluateBranches(latest.orders,18_999)[0].withinBudget,false);
  assert.equal(evaluateBranches(latest.orders,19_000)[0].withinBudget,true);
  assert.equal(evaluateBranches(latest.orders,0)[0].eligibleCount,38);
  assert.throws(() => evaluateBranches(latest.orders,-1),/non-negative integer/);
  assert.throws(() => evaluateBranches(latest.orders,1.1),/non-negative integer/);
  const euro = buildSnapshot(dataset,{ currency: 'EUR' });
  assert.equal(euro.orders.length,0);
  assert.equal(euro.totals.capturedMinor,0);
  assert.equal(euro.evidence.length,0);
  assert(euro.branches.every(branch => branch.currency === 'EUR' && branch.refundTotalMinor === 0));
});

test('mixed-currency source data is partitioned before any money is aggregated', () => {
  const mixed = structuredClone(dataset);
  const euroOrder = mixed.orders.find(order => order.seedGroup === 'context')!;
  euroOrder.currency = 'EUR';
  for (const event of mixed.events) if (event.orderId === euroOrder.id && 'currency' in event.payload) event.payload.currency = 'EUR';
  const dollarScope = buildSnapshot(mixed,{ currency: 'USD' });
  const euroScope = buildSnapshot(mixed,{ currency: 'EUR' });
  assert.equal(dollarScope.orders.length,599);
  assert.equal(euroScope.orders.length,1);
  assert.equal(euroScope.totals.capturedMinor,euroOrder.amountMinor);
  assert.equal(dollarScope.totals.capturedMinor+euroScope.totals.capturedMinor,latest.totals.capturedMinor);
  assert(euroScope.tables.order_snapshot.every(row => row.currency === 'EUR'));
  assert(euroScope.tables.transition_snapshot.every(row => row.currency === 'EUR'));
  assert.equal(euroScope.branches[0].refundTotalMinor,0);
  assert(!euroScope.evidence.some(row => row.id === 'evidence-finding-carrier-v2'));
});

test('a refund observation changes remediation and headroom without delivering or closing a dispute', () => {
  const copy = structuredClone(dataset);
  const disputed = copy.orders.find(order => order.seedGroup === 'disputed')!;
  const event: SourceEvent = { id: 'event:independent-refund-observation', tenantId: copy.tenantId, orderId: disputed.id,
    type: 'remediation.refunded', dimension: 'remediation', state: 'refunded', occurredAt: '2026-11-06T09:50:00.000Z',
    narrativeTime: '2026-11-06T09:50:00.000Z', ingestedAt: '2026-11-06T10:05:00.000Z', sourceClass: 'sample',
    sourceLabel: 'Sample independent remediation test', sourceRef: 'fixture://domain-tests/refund-observation',
    payload: { amountMinor: 500, currency: 'USD', providerResourceId: null }, revision: 2 };
  copy.events.push(event); appendStateObservation(copy.intervals,event);
  const after = buildSnapshot(copy).orders.find(order => order.id === disputed.id)!;
  assert.equal(after.refundedMinor,500);
  assert.equal(after.refundableMinor,disputed.amountMinor-500);
  assert.equal(after.paymentState,'captured');
  assert.equal(after.fulfillmentState,'delayed');
  assert.equal(after.remediationState,'refunded');
  assert.equal(after.disputeState,'open');
  assert.equal(after.disputeOpen,true);
  assert.equal(after.disputeDueAt,null);
  assert.equal(evaluateBranches([after])[0].eligibleCount,0);
  const before = buildSnapshot(copy,{ asOf: '2026-11-06T09:49:59.999Z' }).orders.find(order => order.id === disputed.id)!;
  assert.equal(before.refundedMinor,0);
  assert.equal(before.remediationState,'none');
});

test('policy outcomes are deterministic and never consult Date.now', () => {
  const prior = Date.now;
  Date.now = () => { throw new Error('Wall clock must not influence a historical policy.'); };
  try {
    const branch = evaluateBranches(latest.orders,30_000,latest.hash)[0];
    assert.equal(branch.refundTotalMinor,19_000);
    assert.equal(branch.snapshotHash,latest.hash);
    assert(branch.actions.every(action => action.eligibility === 'blocked'));
  } finally { Date.now = prior; }
});
