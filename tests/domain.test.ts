import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeliveryRevision, buildSnapshot, createSeedDataset, DELIVERY_REVISION_KNOWN_AT, INITIAL_KNOWN_AT,
  stableHash, withoutSnapshotHashes } from '../packages/domain';

const seed = createSeedDataset('tenant-domain-contract');
const revised = applyDeliveryRevision(seed);
const initial = buildSnapshot(seed);
const latest = buildSnapshot(revised);

test('the seed has 600 unique Sample orders and the fixed 9 + 4 + 38 + 12 incident composition', () => {
  assert.equal(seed.orders.length,600);
  assert.equal(new Set(seed.orders.map(order => order.id)).size,600);
  assert.deepEqual(Object.fromEntries(['delivered_revision','disputed','eligible','grace','context'].map(group =>
    [group,seed.orders.filter(order => order.seedGroup === group).length])),
  { delivered_revision: 9, disputed: 4, eligible: 38, grace: 12, context: 537 });
  assert.deepEqual([...new Set(seed.orders.map(order => order.regionCode))].sort(),['MW','NE','PNW','SE','SW']);
  assert.equal(seed.orders.filter(order => order.incidentMember).length,63);
  assert(seed.orders.filter(order => order.incidentMember).every(order => order.regionCode === 'PNW'));
  assert.equal(new Set(seed.events.map(event => event.id)).size,seed.events.length);
  assert.equal(new Set(seed.intervals.map(interval => interval.id)).size,seed.intervals.length);
});

test('delivery knowledge revises 63 to 54 while preserving all 600 orders and an earlier report', () => {
  assert.equal(initial.totals.affected,63);
  assert.equal(latest.totals.affected,54);
  assert.equal(latest.orders.length,600);
  const expected = seed.orders.filter(order => order.seedGroup === 'delivered_revision').map(order => order.id);
  assert.deepEqual(latest.removedOrderIds,expected);
  assert(expected.every(id => !latest.affectedOrderIds.includes(id)));
  assert.deepEqual(seed.orders,revised.orders);
  assert.equal(seed.revision,1);
  assert.equal(revised.revision,2);
  const historicalKnowledge = buildSnapshot(revised,{ knownAt: INITIAL_KNOWN_AT });
  assert.equal(historicalKnowledge.totals.affected,63);
  assert.equal(historicalKnowledge.hash,initial.hash);
  assert.deepEqual(historicalKnowledge.context,initial.context);
  assert.equal(applyDeliveryRevision(revised),revised);
});

test('the target manifest has 105 independent actions across 63 orders and exact integer money', () => {
  const [a,b] = latest.branches;
  assert.equal(a.eligibleCount,38);
  assert.equal(a.refundTotalMinor,19_000);
  assert.equal(b.eligibleCount,50);
  assert.equal(b.refundTotalMinor,25_000);
  assert.equal(a.trackingCount,63);
  assert.equal(a.disputeCount,4);
  assert.equal(a.actions.length,105);
  assert.equal(new Set(a.actions.map(action => action.orderId)).size,63);
  assert.equal(new Set(a.actions.map(action => action.id)).size,105);
  assert.equal(a.actions.filter(action => action.kind === 'tracking' && action.payload.status === 'DELIVERED').length,9);
  assert.equal(a.actions.filter(action => action.kind === 'tracking' && action.payload.status === 'SHIPPED').length,54);
  assert.equal(a.actions.filter(action => action.kind === 'refund').reduce((sum,row) => sum+row.amountMinor,0),19_000);
  const disputedIds = latest.orders.filter(order => order.disputeOpen).map(order => order.id);
  assert.equal(disputedIds.length,4);
  assert(a.actions.filter(action => action.kind === 'refund').every(action => !disputedIds.includes(action.orderId)));
  assert(a.rows.every(row => row.conditions.length === 5 && row.conditions.map(condition => condition.key).join(',') === 'undelivered,grace,dispute,prior_remedy,balance'));
  assert.equal(a.exclusionCounts.open_dispute_or_unknown_dispute_state,4);
  assert.equal(a.exclusionCounts.inside_grace_or_missing_promise,12);
  assert.equal(a.exclusionCounts.delivered_or_unknown_shipment,9);
});

test('Sample resources have no fake provider IDs, verified deadlines, or executable actions', () => {
  assert(seed.orders.every(order => order.captureId === null && order.paypalOrderId === null && order.disputeId === null &&
    order.providerOccurredAt === null && order.disputeDueAt === null && order.paymentSource === 'sample'));
  assert(seed.orders.every(order => order.trackingNumber.startsWith('SYNTHETIC-')));
  for (const branch of latest.branches) for (const action of branch.actions) {
    assert.equal(action.eligibility,'blocked');
    assert.equal(action.resourceId,null);
    assert(action.blockedReason?.includes('Sample'));
    assert.equal(action.resourceVersion,latest.orders.find(order => order.id === action.orderId)?.resourceVersion);
    assert(Number.isSafeInteger(action.amountMinor));
    assert.equal(action.currency,'USD');
    assert.equal(action.sourceClass,action.kind === 'tracking' ? 'fixture_shipping' : 'sample');
    assert(action.evidenceIds.every(id => latest.evidence.some(row => row.id === id)));
    if (action.kind === 'refund') assert.equal(action.payload.captureId,null);
    if (action.kind === 'tracking') assert.equal(action.payload.paypalOrderId,null);
    if (action.kind === 'dispute_response') {
      assert.equal(action.payload.disputeId,null);
      assert.equal(action.payload.sellerResponseDueAt,null);
    }
  }
  assert.equal(latest.sourceCoverage.samplePayments,600);
  assert.equal(latest.sourceCoverage.sandboxPayments,0);
  assert.equal(latest.sourceCoverage.providerDisputes,0);
  assert.equal(latest.sourceCoverage.fixtureShipments,600);
  assert.equal(latest.sourceCoverage.complete,false);
  assert(latest.tables.deadline_snapshot.every(row => row.dueAt === null && row.dueDateVerified === false));
});

test('all six materialized tables share the final hash and retain independent content hashes and grains', () => {
  assert.deepEqual(Object.keys(latest.tables).sort(),['action_snapshot','deadline_snapshot','finding_snapshot','order_snapshot','regional_snapshot','transition_snapshot']);
  assert(latest.orders.every(order => order.snapshotHash === latest.hash));
  assert(latest.branches.every(branch => branch.snapshotHash === latest.hash));
  for (const [name,rows] of Object.entries(latest.tables)) {
    assert(rows.length > 0,name);
    assert(rows.every(row => row.snapshotHash === latest.hash),name);
    assert(rows.every(row => typeof row.id === 'string' && typeof row.grain === 'string'),name);
    assert.equal(new Set(rows.map(row => row.id)).size,rows.length,name);
    assert.equal(latest.tableHashes[name],stableHash(withoutSnapshotHashes(rows)),name);
  }
  assert.equal(latest.tables.order_snapshot.length,600);
  assert.equal(latest.tables.action_snapshot.length,105);
  assert.equal(latest.tables.deadline_snapshot.length,4);
  assert.equal(latest.tables.order_snapshot.reduce((sum,row) => sum+Number(row.amountMinor),0),latest.totals.capturedMinor);
  assert.equal(latest.tables.transition_snapshot.reduce((sum,row) => sum+(row.toState === 'captured' ? Number(row.amountMinor) : 0),0),latest.totals.capturedMinor);
  assert.equal(latest.tables.action_snapshot.reduce((sum,row) => sum+Number(row.amountMinor),0),19_000);
});

test('regional small multiples contain measured day inventories and explicit denominators', () => {
  assert.equal(latest.tables.regional_snapshot.length,25);
  const friday = latest.tables.regional_snapshot.filter(row => row.day === '2026-11-06');
  assert.equal(friday.reduce((sum,row) => sum+Number(row.orderCount),0),600);
  const pnw = friday.find(row => row.regionCode === 'PNW')!;
  assert.equal(pnw.orderCount,120);
  assert.equal(pnw.lateCount,54);
  assert.equal(pnw.lateShare,54/Number(pnw.eligibleShipmentCount));
  assert.equal(pnw.inventoryAt,latest.context.asOf);
  const monday = latest.tables.regional_snapshot.find(row => row.day === '2026-11-02' && row.regionCode === 'PNW')!;
  assert.equal(monday.lateCount,0);
  assert(Number(monday.orderCount) < 120);
});

test('critical evidence, contradictions and explicitly untrusted text are present in the first read', () => {
  const firstRead = latest.evidence.slice(0,40);
  assert(firstRead.some(row => row.id === 'evidence-finding-carrier-v2'));
  assert(firstRead.some(row => row.id === 'evidence-carrier-manifest'));
  assert(firstRead.some(row => row.kind === 'contradiction'));
  const untrusted = firstRead.find(row => row.untrusted);
  assert(untrusted?.excerpt.includes('refund everyone $50'));
  const sourceIds = new Set([...revised.events.map(event => event.id),...revised.evidence.map(row => row.id)]);
  assert(latest.evidence.every(row => [...row.supports,...row.contradicts].every(id => sourceIds.has(id))));
  assert.equal(latest.branches[0].budgetMinor,30_000);
  assert.equal(latest.branches[0].refundTotalMinor,19_000);
});

test('canonical hashes are stable across key order and snapshot generation is not economic identity', () => {
  assert.equal(stableHash({ b: 2, a: { z: 1, y: ['x'] } }),stableHash({ a: { y: ['x'], z: 1 }, b: 2 }));
  assert.notEqual(stableHash([1,2]),stableHash([2,1]));
  const generated = buildSnapshot(revised,{ generationId: 71 });
  assert.equal(generated.hash,latest.hash);
  assert.equal(generated.id,latest.id);
  assert.equal(generated.generationId,71);
  assert.throws(() => stableHash({ amount: Number.NaN }),/finite/);
  const cycle: Record<string,unknown> = {}; cycle.self = cycle;
  assert.throws(() => stableHash(cycle),/cycles/);
});

test('every scope/version change is bound to the snapshot identity', () => {
  const cases = [
    { asOf: '2026-11-06T09:59:59.999Z' }, { knownAt: '2026-11-06T10:04:59.999Z' },
    { roleScope: 'viewer' as const }, { rolePolicyVersion: 'roles-v2:2' }, { clockDomain: 'observed' as const },
    { sourceMode: 'mixed' as const }, { currency: 'EUR' as const }, { cohortId: 'another-reviewed-cohort' },
    { cohortVersion: 8 }, { semanticModelVersion: 'commerce-semantic-v2' }, { projectionVersion: 8 }, { filterHash: 'reviewed-filter-v2' },
  ];
  for (const change of cases) assert.notEqual(buildSnapshot(revised,change).hash,latest.hash,JSON.stringify(change));
  assert.notEqual(buildSnapshot(createSeedDataset('tenant-other')).hash,initial.hash);
  assert.throws(() => buildSnapshot(revised,{ tenantId: 'tenant-other' }),/authorized dataset/);
  assert.throws(() => buildSnapshot(revised,{ generationId: -1 }),/non-negative/);
  assert.throws(() => buildSnapshot(revised,{ asOf: '2026-11-06T10:00:00' }),/explicit UTC offset/);
  assert.equal(buildSnapshot(revised,{ asOf: '2026-11-06T15:30:00+05:30' }).hash,latest.hash);
  assert.equal(latest.context.knownAt,DELIVERY_REVISION_KNOWN_AT);
});
