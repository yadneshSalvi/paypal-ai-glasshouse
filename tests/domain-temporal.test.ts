import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeliveryRevision, buildSnapshot, createSeedDataset, DELIVERY_REVISION_KNOWN_AT, intervalContains, stateAt } from '../packages/domain';
import type { QueryContext } from '../packages/domain';

const original = createSeedDataset('tenant-temporal-tests');
const dataset = applyDeliveryRevision(original);
const context: QueryContext = buildSnapshot(dataset).context;

test('valid intervals are half-open at a known delivery timestamp', () => {
  const order = dataset.orders.find(order => order.seedGroup === 'delivered_revision')!;
  const delivery = dataset.events.find(event => event.orderId === order.id && event.type === 'fulfillment.delivered')!;
  const before = { ...context, asOf: new Date(Date.parse(delivery.occurredAt)-1).toISOString() };
  const exact = { ...context, asOf: delivery.occurredAt };
  assert.equal(stateAt(dataset.intervals,order.id,'fulfillment',before)?.state,'delayed');
  assert.equal(stateAt(dataset.intervals,order.id,'fulfillment',exact)?.state,'delivered');
  const old = dataset.intervals.find(interval => interval.orderId === order.id && interval.clockDomain === context.clockDomain &&
    interval.dimension === 'fulfillment' && interval.validTo === delivery.occurredAt)!;
  assert(intervalContains(old,before));
  assert.equal(intervalContains(old,exact),false);
  assert.equal(buildSnapshot(dataset,before).totals.affected,63);
  assert.equal(buildSnapshot(dataset,exact).totals.affected,62);
});

test('knowledge intervals switch at the exact ingestion boundary and T remains unchanged', () => {
  const before = buildSnapshot(dataset,{ knownAt: new Date(Date.parse(DELIVERY_REVISION_KNOWN_AT)-1).toISOString() });
  const exact = buildSnapshot(dataset,{ knownAt: DELIVERY_REVISION_KNOWN_AT });
  assert.equal(before.context.asOf,exact.context.asOf);
  assert.equal(before.totals.affected,63);
  assert.equal(exact.totals.affected,54);
  assert.equal(before.context.cohortVersion,1);
  assert.equal(exact.context.cohortVersion,2);
  assert.notEqual(before.hash,exact.hash);
  const order = dataset.orders[0];
  const replaced = dataset.intervals.find(interval => interval.orderId === order.id && interval.dimension === 'fulfillment' &&
    interval.clockDomain === context.clockDomain && interval.state === 'delayed' && interval.knowledgeTo === DELIVERY_REVISION_KNOWN_AT)!;
  assert(intervalContains(replaced,before.context));
  assert.equal(intervalContains(replaced,exact.context),false);
});

test('no order or future evidence leaks before its first observation or knowledge', () => {
  const early = buildSnapshot(dataset,{ asOf: '2026-11-02T00:00:00.000Z' });
  assert.equal(early.orders.length,0);
  assert.equal(early.evidence.length,0);
  assert.equal(early.tables.transition_snapshot.length,0);
  assert.equal(early.totals.capturedMinor,0);
  const unknown = buildSnapshot(dataset,{ knownAt: '2026-11-02T00:00:00.000Z' });
  assert.equal(unknown.orders.length,0);
  const historic = buildSnapshot(dataset,{ asOf: '2026-11-03T10:00:00.000Z' });
  assert(historic.orders.length < 600);
  assert(historic.evidence.every(row => Date.parse(row.occurredAt) <= Date.parse(historic.context.asOf) && Date.parse(row.ingestedAt) <= Date.parse(historic.context.knownAt)));
  assert(historic.tables.transition_snapshot.every(row => Date.parse(String(row.transitionTime)) <= Date.parse(historic.context.asOf)));
  assert(historic.branches.flatMap(branch => branch.actions).every(action => action.evidenceIds.every(id => historic.evidence.some(row => row.id === id))));
});

test('each seed dimension has exactly one interval at T/K, including knowledge corrections', () => {
  const checks = [context,{ ...context, knownAt: '2026-11-06T10:00:00.000Z' },
    { ...context, asOf: '2026-11-03T10:00:00.000Z' }, { ...context, clockDomain: 'observed' as const }];
  for (const query of checks) {
    const snapshot = buildSnapshot(dataset,query);
    for (const order of snapshot.orders) for (const dimension of ['payment','fulfillment','remediation','dispute'] as const) {
      assert.equal(dataset.intervals.filter(interval => interval.orderId === order.id && interval.dimension === dimension && intervalContains(interval,query)).length,1,
        `${order.id} ${dimension} ${query.asOf} ${query.knownAt}`);
    }
  }
});

test('a missing dimension is explicitly unknown and cannot become refund eligible', () => {
  const copy = structuredClone(dataset);
  const order = copy.orders.find(value => value.seedGroup === 'eligible')!;
  copy.intervals = copy.intervals.filter(interval => interval.orderId !== order.id || interval.dimension !== 'fulfillment');
  const snapshot = buildSnapshot(copy);
  const projected = snapshot.orders.find(value => value.id === order.id)!;
  assert.equal(projected.fulfillmentState,'unknown');
  assert.equal(projected.paymentState,'captured');
  assert.equal(projected.affected,false);
  assert.equal(snapshot.branches[0].rows.find(row => row.orderId === order.id)?.eligible,false);
  assert.equal(snapshot.branches[0].actions.find(action => action.orderId === order.id && action.kind === 'tracking')?.eligibility,'blocked');
  assert.equal(snapshot.detectors.find(detector => detector.kind === 'carrier_delay')?.status,'insufficient_evidence');
});
