import type { ActionRow, ConditionResult, EligibilityRow, RecoveryBranch, SnapshotOrder } from './types';

export const GOODWILL_POLICY_ID = 'goodwill-delay-v1';
export const GOODWILL_AMOUNT_MINOR = 500;
export const DEFAULT_BUDGET_MINOR = 30_000;
const money = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const undelivered = (state: string) => ['in_transit', 'delayed', 'shipped'].includes(state);
const closedDispute = (state: string | null) => state !== null && ['none', 'resolved', 'closed', 'cancelled'].includes(state);

export function evaluateBranches(snapshotOrders: readonly SnapshotOrder[], budgetMinor = DEFAULT_BUDGET_MINOR, snapshotHash = ''): RecoveryBranch[] {
  if (!money(budgetMinor)) throw new Error('The refund budget must be a non-negative integer in minor units.');
  const currencies = new Set(snapshotOrders.map(order => order.currency));
  if (currencies.size > 1) throw new Error('Recovery branches cannot combine currencies.');
  const currency = snapshotOrders[0]?.currency ?? 'USD';
  const orders = snapshotOrders.filter(order => order.incidentMember).slice().sort((a,b) => a.id.localeCompare(b.id));
  return ([{ id: 'targeted', name: 'Targeted goodwill', graceHours: 48 },
    { id: 'comprehensive', name: 'Every non-disputed delayed order', graceHours: 0 }] as const).map(definition => {
    const rows: EligibilityRow[] = orders.map(order => {
      const conditions: ConditionResult[] = [
        { key: 'undelivered', passed: undelivered(order.fulfillmentState), label: 'Shipment is still undelivered' },
        { key: 'grace', passed: Number.isFinite(order.lateHours) && Number.isFinite(Date.parse(order.promisedAt)) && order.lateHours >= definition.graceHours,
          label: definition.graceHours ? 'At least 48 hours past promise on the snapshot clock' : 'Promise has passed; no grace window' },
        { key: 'dispute', passed: order.disputeOpen === false && closedDispute(order.disputeState), label: 'No open dispute' },
        { key: 'prior_remedy', passed: money(order.refundedMinor) && money(order.goodwillCreditMinor) && order.refundedMinor === 0 && order.goodwillCreditMinor === 0 &&
          (order.providerRefundConsumedMinor === undefined || order.providerRefundConsumedMinor === 0) &&
          ['none', 'tracking_added'].includes(order.remediationState), label: 'No earlier refund or goodwill credit' },
        { key: 'balance', passed: currency === 'USD' && order.currency === 'USD' && money(order.amountMinor) && money(order.refundableMinor) &&
          order.refundableMinor >= GOODWILL_AMOUNT_MINOR && order.refundableMinor <= order.amountMinor &&
          ['captured', 'completed'].includes(order.paymentState), label: 'At least $5 remains refundable' },
      ];
      return { orderId: order.id, eligible: conditions.every(condition => condition.passed), conditions,
        excludedReasons: conditions.filter(condition => !condition.passed).map(condition => condition.key) };
    });
    const eligibleIds = new Set(rows.filter(row => row.eligible).map(row => row.orderId));
    const actions: ActionRow[] = [];
    const action = (order: SnapshotOrder, kind: ActionRow['kind'], amountMinor: number, payload: Record<string, unknown>, evidenceIds: string[]) => {
      const sample = order.paymentSource !== 'sandbox' || !order.captureId || !order.paypalOrderId;
      const sourceClass = kind === 'tracking' ? 'fixture_shipping' : kind === 'dispute_response' ? order.disputeSource : order.paymentSource;
      const resourceId = sample ? null : kind === 'dispute_response' ? order.disputeId : kind === 'tracking' ? order.paypalOrderId : order.captureId;
      const missingTracking = kind === 'tracking' && (!order.trackingNumber || !order.carrier || !order.shipmentRef || !['delivered','delayed','in_transit','shipped'].includes(order.fulfillmentState));
      const missingDispute = kind === 'dispute_response' && (!order.disputeId || order.disputeSource !== 'sandbox' ||
        (order.disputeCapabilities ? !order.disputeCapabilities.mayProvideFulfillment : !order.disputeDueAt));
      const reason = sample ? 'Sample payment has no verified PayPal order or capture. Provider execution is blocked.' :
        missingTracking ? 'Tracking evidence is missing or the shipment state is unknown.' :
        missingDispute ? 'A provider dispute ID, current permitted state, and verified response deadline are required.' :
        kind === 'tracking' ? 'Fixture shipping must be verified by an authorized merchant before provider submission.' :
        'Current provider eligibility, capability, and an exact approved manifest must be revalidated before execution.';
      actions.push({ id: `${definition.id}:${kind}:${order.id}`, orderId: order.id, reference: order.reference, kind,
        amountMinor, currency: order.currency, resourceId, resourceVersion: order.resourceVersion, sourceClass,
        eligibility: 'blocked', blockedReason: reason, evidenceIds, payload });
    };
    for (const order of orders) {
      const common = { orderId: order.id, currency: order.currency, resourceVersion: order.resourceVersion,
        policyId: GOODWILL_POLICY_ID, sourceMode: order.paymentSource === 'sample' ? 'sample' : 'mixed', proposalOnly: true };
      if (eligibleIds.has(order.id)) action(order, 'refund', GOODWILL_AMOUNT_MINOR,
        { ...common, captureId: order.paymentSource === 'sandbox' ? order.captureId : null,
          amountMinor: GOODWILL_AMOUNT_MINOR, graceHours: definition.graceHours, reason: 'Delay goodwill',
          amount: { currencyCode: order.currency, value: '5.00' } },
        [`evidence-payment-${order.id}`, order.shipmentEvidenceId??`evidence-shipment-${order.id}`, 'evidence-policy-goodwill-v1']);
      if (!(order.recoveryReviewVersion === 1 && order.trackingInPayPal)) action(order, 'tracking', 0, { ...common, paypalOrderId: order.paymentSource === 'sandbox' ? order.paypalOrderId : null,
        captureId: order.paymentSource === 'sandbox' ? order.captureId : null, shipmentRef: order.shipmentRef,
        carrier: order.carrier, trackingNumber: order.trackingNumber,
        status: order.fulfillmentState === 'delivered' ? 'DELIVERED' : ['in_transit','delayed','shipped'].includes(order.fulfillmentState) ? 'SHIPPED' : 'UNKNOWN',
        fixtureShipping: true, notifyPayer: false },
        [order.shipmentEvidenceId??(order.fulfillmentState === 'delivered' && order.seedGroup === 'delivered_revision' ? `evidence-delivery-${order.id}-v2` : `evidence-shipment-${order.id}`)]);
      if (order.disputeOpen && (!order.disputeCapabilities || order.disputeCapabilities.mayProvideFulfillment)) action(order, 'dispute_response', 0, { ...common,
        disputeId: order.disputeSource === 'sandbox' ? order.disputeId : null,
        providerDisputeHash: order.disputeSource === 'sandbox' ? order.disputeEvidenceHash ?? null : null,
        responseType: 'PROVIDE_EVIDENCE', reason: 'ITEM_NOT_RECEIVED',
        trackingNumber: order.trackingNumber, carrier: order.carrier,
        statement: 'Proposed response: provide the authorized shipment record and current tracking. This proposal does not close the dispute.',
        sellerResponseDueAt: order.disputeSource === 'sandbox' ? order.disputeDueAt : null },
        [order.disputeEvidenceId??`evidence-dispute-${order.id}`, order.shipmentEvidenceId??`evidence-shipment-${order.id}`]);
    }
    const exclusionCounts: Record<string, number> = { delivered_or_unknown_shipment: 0, inside_grace_or_missing_promise: 0,
      open_dispute_or_unknown_dispute_state: 0, prior_refund_credit_or_unknown_remediation: 0, insufficient_balance_currency_or_payment: 0 };
    const descriptions: Record<ConditionResult['key'], string> = { undelivered: 'delivered_or_unknown_shipment', grace: 'inside_grace_or_missing_promise',
      dispute: 'open_dispute_or_unknown_dispute_state', prior_remedy: 'prior_refund_credit_or_unknown_remediation', balance: 'insufficient_balance_currency_or_payment' };
    for (const row of rows) for (const condition of row.conditions) if (!condition.passed) exclusionCounts[descriptions[condition.key]]++;
    const eligibleCount = eligibleIds.size;
    return { ...definition, policyId: GOODWILL_POLICY_ID, amountMinor: GOODWILL_AMOUNT_MINOR, currency, budgetMinor,
      withinBudget: eligibleCount * GOODWILL_AMOUNT_MINOR <= budgetMinor, eligibleCount,
      refundTotalMinor: eligibleCount * GOODWILL_AMOUNT_MINOR, trackingCount: actions.filter(row => row.kind === 'tracking').length,
      disputeCount: actions.filter(row => row.kind === 'dispute_response').length, rows, actions, exclusionCounts, snapshotHash };
  });
}
