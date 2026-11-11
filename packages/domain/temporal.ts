import { createHash } from 'node:crypto';
import type { Dimension, Evidence, QueryContext, SeedDataset, Snapshot, SnapshotOrder, SourceEvent, StateInterval, TableRow } from './types';
import { CARRIER_BASELINE_AT, runDetectors } from './detectors';
import { DEFAULT_BUDGET_MINOR, evaluateBranches } from './policy';
import { DELIVERY_REVISION_KNOWN_AT, INCIDENT_ID, INITIAL_KNOWN_AT, isStateEvent, REGIONS, STORY_END, STORY_START } from './seed';
import { fixtureProfile } from './scenario';

function canonical(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Hash inputs must contain finite numbers.');
    return Object.is(value,-0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') throw new Error('Unsupported canonical hash value.');
  if (seen.has(value)) throw new Error('Canonical hash input cannot contain cycles.');
  seen.add(value);
  const normalized = Array.isArray(value) ? value.map(item => item === undefined ? null : canonical(item,seen)) :
    Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string,unknown>)[key] !== undefined)
      .map(key => [key, canonical((value as Record<string,unknown>)[key],seen)]));
  seen.delete(value);
  return normalized;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value,new Set()))).digest('hex');
}

/** A row's context stamp is excluded from its content hash, preventing a self-reference. */
export function withoutSnapshotHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSnapshotHashes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'snapshotHash').map(([key,item]) => [key,withoutSnapshotHashes(item)]));
  return value;
}

function timestamp(value: string, field: string): string {
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be a valid timestamp with an explicit UTC offset.`);
  return new Date(value).toISOString();
}
const eventTime = (event: SourceEvent, context: QueryContext) => context.clockDomain === 'observed' ? event.occurredAt : event.narrativeTime;
const known = (from: string, to: string | null, at: string) => Date.parse(from) <= Date.parse(at) && (to === null || Date.parse(at) < Date.parse(to));

export function intervalContains(interval: StateInterval, context: Pick<QueryContext,'asOf'|'knownAt'|'clockDomain'|'tenantId'>): boolean {
  return interval.tenantId === context.tenantId && interval.clockDomain === context.clockDomain &&
    known(interval.validFrom,interval.validTo,context.asOf) && known(interval.knowledgeFrom,interval.knowledgeTo,context.knownAt);
}

export function stateAt(intervals: readonly StateInterval[], orderId: string, dimension: Dimension,
  context: Pick<QueryContext,'asOf'|'knownAt'|'clockDomain'|'tenantId'>): StateInterval | null {
  const matching = intervals.filter(interval => interval.orderId === orderId && interval.dimension === dimension && intervalContains(interval,context));
  // A deterministic conflict winner is retained for imported source revisions. Seed intervals never overlap.
  return matching.sort((a,b) => b.revision-a.revision || Date.parse(b.knowledgeFrom)-Date.parse(a.knowledgeFrom) ||
    Date.parse(b.validFrom)-Date.parse(a.validFrom) || b.sourceEventId.localeCompare(a.sourceEventId))[0] ?? null;
}

function eventVisible(event: SourceEvent, context: QueryContext): boolean {
  return event.tenantId === context.tenantId && Date.parse(event.ingestedAt) <= Date.parse(context.knownAt) && Date.parse(eventTime(event,context)) <= Date.parse(context.asOf);
}

export function projectOrders(dataset: SeedDataset, context: QueryContext): SnapshotOrder[] {
  const visibleEvents = dataset.events.filter(event => eventVisible(event,context));
  const eventById = new Map(dataset.events.map(event=>[event.id,event]));
  const intervalsByDimension=new Map<string,StateInterval>();
  for(const interval of dataset.intervals.filter(row=>intervalContains(row,context)).sort((a,b)=>b.revision-a.revision||Date.parse(b.knowledgeFrom)-Date.parse(a.knowledgeFrom)||Date.parse(b.validFrom)-Date.parse(a.validFrom)||b.sourceEventId.localeCompare(a.sourceEventId))){
    const key=`${interval.orderId}:${interval.dimension}`;if(!intervalsByDimension.has(key))intervalsByDimension.set(key,interval);
  }
  const evidenceBySource=new Map<string,string>();
  for(const row of dataset.evidence)if(row.orderId&&['shipment','dispute'].includes(row.kind)&&Date.parse(row.ingestedAt)<=Date.parse(context.knownAt))for(const sourceId of row.supports){
    const key=`${row.orderId}:${row.kind}:${sourceId}`;if(!evidenceBySource.has(key))evidenceBySource.set(key,row.id);
  }
  const providerRemediation = new Set(dataset.events.filter(event=>event.sourceClass==='sandbox'&&event.dimension==='remediation').map(event=>event.orderId));
  const created = new Set(visibleEvents.filter(event => event.type === 'order.created').map(event => event.orderId));
  const byOrder = new Map<string,SourceEvent[]>();
  for (const event of visibleEvents) { const list = byOrder.get(event.orderId) ?? []; list.push(event); byOrder.set(event.orderId,list); }
  return dataset.orders.filter(order => order.tenantId === context.tenantId && order.currency === context.currency && created.has(order.id))
    .map(order => {
      const paymentInterval = intervalsByDimension.get(`${order.id}:payment`);
      const paymentState = paymentInterval?.state ?? 'unknown';
      const paymentEvent = paymentInterval ? eventById.get(paymentInterval.sourceEventId) : undefined;
      const paymentSource = paymentInterval?.sourceClass ?? 'sample';
      const captureId = paymentSource==='sandbox' && typeof paymentEvent?.payload.captureId==='string' ? paymentEvent.payload.captureId : null;
      const paypalOrderId = paymentSource==='sandbox' && typeof paymentEvent?.payload.paypalOrderId==='string' ? paymentEvent.payload.paypalOrderId : null;
      const providerOccurredAt = paymentSource==='sandbox' ? paymentEvent?.occurredAt ?? null : null;
      const fulfillmentInterval = intervalsByDimension.get(`${order.id}:fulfillment`);
      const fulfillmentState = fulfillmentInterval?.state ?? 'unknown';
      const remediationState = intervalsByDimension.get(`${order.id}:remediation`)?.state ?? 'unknown';
      const disputeInterval = intervalsByDimension.get(`${order.id}:dispute`);
      const disputeState = disputeInterval?.state ?? null;
      const disputeEvent = disputeInterval ? eventById.get(disputeInterval.sourceEventId) : undefined;
      const disputeSource = disputeInterval?.sourceClass ?? 'sample';
      const disputeId = disputeSource === 'sandbox' && typeof disputeEvent?.payload.disputeId === 'string' ? disputeEvent.payload.disputeId : null;
      const disputeDueAt = disputeSource === 'sandbox' && typeof disputeEvent?.payload.sellerResponseDueAt === 'string' ? disputeEvent.payload.sellerResponseDueAt : null;
      const disputeEvidenceHash = disputeSource === 'sandbox' && typeof disputeEvent?.payload.receiptHash === 'string' ? disputeEvent.payload.receiptHash : null;
      const caseCapabilities = disputeSource === 'sandbox' ? disputeEvent?.payload.disputeCapabilities : undefined;
      const disputeCapabilities = caseCapabilities && typeof caseCapabilities === 'object' &&
        'version' in caseCapabilities && caseCapabilities.version === 1 &&
        'mayProvideFulfillment' in caseCapabilities && typeof caseCapabilities.mayProvideFulfillment === 'boolean' &&
        'reason' in caseCapabilities && typeof caseCapabilities.reason === 'string'
        ? { version: 1 as const, mayProvideFulfillment: caseCapabilities.mayProvideFulfillment, reason: caseCapabilities.reason } : undefined;
      const source = (byOrder.get(order.id) ?? []).sort((a,b) => Date.parse(eventTime(a,context))-Date.parse(eventTime(b,context)) || a.id.localeCompare(b.id));
      const scenarioEvent=source.filter(event=>event.sourceClass==='fixture_shipping'&&event.payload.fixtureShipping===true&&event.payload.scenarioRevisionId)
        .sort((a,b)=>b.revision-a.revision||b.ingestedAt.localeCompare(a.ingestedAt))[0];
      const profile=fixtureProfile(scenarioEvent?.payload.fixtureProfile);
      const currentOrder=profile?{...order,...profile}:order;
      const evidenceFor=(sourceId:string|undefined,kind:'shipment'|'dispute')=>sourceId?evidenceBySource.get(`${order.id}:${kind}:${sourceId}`):undefined;
      const shipmentEvidenceId=evidenceFor(fulfillmentInterval?.sourceEventId,'shipment');
      const disputeEvidenceId=evidenceFor(disputeInterval?.sourceEventId,'dispute');
      const resourceVersion = source.reduce((version,event) => Number.isSafeInteger(event.payload.resourceVersion) ? Math.max(version,Number(event.payload.resourceVersion)) : version,1);
      const trackingInPayPal = source.some(event => event.sourceClass === 'sandbox' && event.type === 'remediation.tracking_added' && event.payload.trackingInPayPal === true);
      const recoveryReviewVersion = source.some(event => event.sourceClass === 'sandbox' && event.type === 'recovery.capabilities_observed' && event.payload.version === 1) ? 1 as const : undefined;
      const remedy = source.filter(event => event.dimension === 'remediation' && isStateEvent(event));
      const observedRefunds = remedy.filter(event => event.type === 'remediation.refunded');
      const observedCredits = remedy.filter(event => event.type === 'remediation.credited');
      const refundAmounts = observedRefunds.map(event => Number(event.payload.amountMinor ?? event.payload.refundMinor ?? 0));
      const creditAmounts = observedCredits.map(event => Number(event.payload.amountMinor ?? event.payload.creditMinor ?? 0));
      const capacity = source.filter(event => event.sourceClass === 'sandbox' && event.type === 'payment.refund_balance_observed' && event.payload.complete === true)
        .sort((a,b) => b.revision-a.revision)[0];
      const refundHistoryMinor = observedRefunds.length ? refundAmounts.reduce((sum,value) => sum+value,0) : providerRemediation.has(order.id) ? 0 : order.refundedMinor;
      const inventory = Array.isArray(capacity?.payload.refunds) ? capacity.payload.refunds.filter((value):value is {id:string;status:string;amountMinor:number} =>
        value !== null && typeof value === 'object' && typeof value.id === 'string' && typeof value.status === 'string' && Number.isSafeInteger(value.amountMinor) && value.amountMinor > 0) : null;
      const completedIds = new Set(inventory?.filter(refund=>refund.status==='COMPLETED').map(refund=>refund.id));
      const consumedIds = new Set(inventory?.filter(refund=>['COMPLETED','PENDING'].includes(refund.status)).map(refund=>refund.id));
      // A complete inventory may precede a later original receipt. Union their identities:
      // taking the larger total loses distinct refunds; adding totals counts shared ones twice.
      const receiptAmounts = new Map(observedRefunds.map(event=>[String(event.payload.refundId??event.payload.providerResourceId??event.id),Number(event.payload.amountMinor??event.payload.refundMinor??0)]));
      const outsideInventory = (ids:Set<string>) => inventory ? [...receiptAmounts].reduce((sum,[id,amount])=>sum+(ids.has(id)?0:amount),0) : 0;
      const refundedMinor = Math.max(refundHistoryMinor,capacity && Number.isSafeInteger(capacity.payload.completedMinor) ? Number(capacity.payload.completedMinor)+outsideInventory(completedIds) : 0);
      const providerRefundConsumedMinor = capacity && Number.isSafeInteger(capacity.payload.consumedMinor) ? Math.max(refundedMinor,Number(capacity.payload.consumedMinor)+outsideInventory(consumedIds)) : undefined;
      const providerRefundInventoryHash = capacity && typeof capacity.payload.receiptHash === 'string' ? capacity.payload.receiptHash : undefined;
      const goodwillCreditMinor = observedCredits.length ? creditAmounts.reduce((sum,value) => sum+value,0) : providerRemediation.has(order.id) ? 0 : order.goodwillCreditMinor;
      const remaining = Math.max(0,order.amountMinor-(providerRefundConsumedMinor ?? refundedMinor));
      const refundableMinor = ['captured','completed'].includes(paymentState) ? providerRemediation.has(order.id) ? remaining : Math.min(order.refundableMinor,remaining) : 0;
      const promised = Date.parse(currentOrder.promisedAt);
      const lateHours = Number.isFinite(promised) ? (Date.parse(context.asOf)-promised)/3_600_000 : -1;
      const disputeOpen = disputeState !== null && !['none','resolved','closed','cancelled'].includes(disputeState);
      return { ...currentOrder, paymentSource, captureId, paypalOrderId, providerOccurredAt, resourceVersion, refundedMinor, goodwillCreditMinor, refundableMinor,
        shipmentEvidenceId,disputeEvidenceId,disputeCapabilities,recoveryReviewVersion,providerRefundConsumedMinor,providerRefundInventoryHash,
        disputeState, disputeOpen, disputeSource, disputeId, disputeDueAt, disputeEvidenceHash, trackingInPayPal, paymentState, fulfillmentState, remediationState,
        affected: currentOrder.incidentMember && ['delayed','in_transit','shipped'].includes(fulfillmentState) && lateHours >= 0,
        lateHours, ageDays: Math.max(0,(Date.parse(context.asOf)-Date.parse(context.clockDomain === 'observed' ? order.createdAt : order.narrativeCreatedAt))/86_400_000),
        supportContacts: profile?.supportContacts??source.filter(event => event.type === 'support.message').reduce((sum,event) => sum+Number(event.payload.contactCount ?? 0),0), snapshotHash: '' };
    }).sort((a,b) => a.id.localeCompare(b.id));
}

function snapshotEvidence(dataset: SeedDataset, orders: readonly SnapshotOrder[], context: QueryContext): Evidence[] {
  const ids = new Set(orders.map(order => order.id));
  const sources = new Map(dataset.events.map(event => [event.id,event]));
  const evidence = dataset.evidence.filter(row => row.tenantId === context.tenantId && (!row.orderId || ids.has(row.orderId)) &&
    Date.parse(row.occurredAt) <= Date.parse(context.asOf) && Date.parse(row.ingestedAt) <= Date.parse(context.knownAt) &&
    // A fixed aggregate excerpt cannot be reused for a narrower currency/order scope.
    (row.orderId !== null || row.supports.every(id => {
      const source = sources.get(id);
      return !source || ids.has(source.orderId) && eventVisible(source,context);
    })));
  const hasRevision = evidence.some(row => row.id === 'evidence-finding-carrier-v2');
  const selected = evidence.filter(row => !hasRevision || row.id !== 'evidence-finding-carrier-v1').map(row => ({ ...row, supports: [...row.supports], contradicts: [...row.contradicts] }));
  // Historic reports cite the actual then-visible state source, rather than a future final seed scan.
  for (const order of orders) {
    for (const [dimension,kind] of [['fulfillment','shipment'],['payment','payment']] as const) {
      const interval = stateAt(dataset.intervals,order.id,dimension,context);
      const source = interval && dataset.events.find(event => event.id === interval.sourceEventId && eventVisible(event,context));
      if (!source) continue;
      const id = `evidence-${kind}-${order.id}`;
      if (!selected.some(row => row.id === id)) selected.push({ id, tenantId: context.tenantId, orderId: order.id, kind,
        title: `${order.reference} · ${source.state.replaceAll('_',' ')}`, excerpt: `Then-visible ${source.sourceLabel} observation ${source.id}. This source is ${source.sourceClass}; no provider resource is implied.`,
        sourceClass: source.sourceClass, sourceLabel: source.sourceLabel, occurredAt: source.occurredAt, ingestedAt: source.ingestedAt, supports: [source.id], contradicts: [] });
    }
  }
  return selected.sort((a,b) => Number(a.orderId !== null)-Number(b.orderId !== null) ||
    (a.orderId === null && b.orderId === null ? 0 : a.id.localeCompare(b.id)));
}

function makeContext(dataset: SeedDataset, options: Partial<QueryContext>): QueryContext {
  if (options.tenantId !== undefined && options.tenantId !== dataset.tenantId) throw new Error('The query tenant does not match the authorized dataset.');
  const knownAt = timestamp(options.knownAt ?? (dataset.revision > 1 ? DELIVERY_REVISION_KNOWN_AT : INITIAL_KNOWN_AT),'knownAt');
  const knownRevision = dataset.events.filter(event => event.tenantId === dataset.tenantId && Date.parse(event.ingestedAt) <= Date.parse(knownAt))
    .reduce((revision,event) => Math.max(revision,event.revision),1);
  const context: QueryContext = { tenantId: dataset.tenantId, rolePolicyVersion: options.rolePolicyVersion ?? 'roles-v1:1',
    roleScope: options.roleScope ?? 'investigator', clockDomain: options.clockDomain ?? 'narrative_replay', sourceMode: options.sourceMode ?? 'sample',
    asOf: timestamp(options.asOf ?? STORY_END,'asOf'), knownAt, cohortId: options.cohortId ?? INCIDENT_ID,
    cohortVersion: options.cohortVersion ?? knownRevision, currency: options.currency ?? 'USD',
    semanticModelVersion: options.semanticModelVersion ?? 'commerce-semantic-v1', projectionVersion: options.projectionVersion ?? knownRevision,
    filterHash: options.filterHash ?? 'all-authorized-orders-v1' };
  if (!['USD','EUR','GBP'].includes(context.currency)) throw new Error('Unsupported snapshot currency.');
  if (!['observed','narrative_replay'].includes(context.clockDomain)) throw new Error('Unsupported clock domain.');
  return context;
}

function transitions(dataset: SeedDataset, orders: readonly SnapshotOrder[], context: QueryContext): TableRow[] {
  const ids = new Set(orders.map(order => order.id));
  const previous = new Map<string,string>();
  const visible = dataset.events.filter(event => ids.has(event.orderId) && isStateEvent(event) && eventVisible(event,context));
  const superseded = new Set(visible.map(event=>event.payload.supersedesEventId).filter((id):id is string=>typeof id==='string'));
  const events = visible.filter(event=>!superseded.has(event.id))
    .sort((a,b) => Date.parse(eventTime(a,context))-Date.parse(eventTime(b,context)) || a.revision-b.revision || a.id.localeCompare(b.id));
  return events.map(event => {
    const key = `${event.orderId}:${event.dimension}`;
    const fromState = previous.get(key) ?? 'unknown';
    previous.set(key,event.state);
    const financial = event.type === 'payment.captured' || event.type === 'remediation.refunded' || event.type === 'remediation.credited';
    return { id: event.id, orderId: event.orderId, grain: 'state_transition', dimension: event.dimension, fromState, toState: event.state,
      transitionTime: eventTime(event,context), occurredAt: event.occurredAt, narrativeTime: event.narrativeTime,
      ingestedAt: event.ingestedAt, sourceClass: event.sourceClass, sourceLabel: event.sourceLabel, sourceEventId: event.id,
      transitionCount: 1, captureCount: event.type === 'payment.captured' ? 1 : 0,
      amountMinor: financial ? Number(event.payload.amountMinor ?? 0) : 0, currency: context.currency, snapshotHash: '' };
  });
}

function regionalRows(dataset: SeedDataset, context: QueryContext): TableRow[] {
  const rows: TableRow[] = [];
  const start = Date.parse(STORY_START), cutoff = Date.parse(context.asOf);
  const baselineContext = { ...context, asOf: new Date(Math.min(Date.parse(CARRIER_BASELINE_AT),cutoff)).toISOString() };
  const baseline = projectOrders(dataset,baselineContext);
  for (let day = start; day <= cutoff && day < Date.parse(STORY_END)+86_400_000; day += 86_400_000) {
    const at = new Date(Math.min(day+86_400_000-1,cutoff)).toISOString();
    const daily = projectOrders(dataset,{ ...context, asOf: at });
    for (const region of REGIONS) {
      const orders = daily.filter(order => order.regionCode === region.code);
      const due = orders.filter(order => Date.parse(order.promisedAt) <= Date.parse(at) && order.fulfillmentState !== 'unknown');
      const late = due.filter(order => ['in_transit','delayed','shipped'].includes(order.fulfillmentState));
      const baselineDue = baseline.filter(order => order.regionCode === region.code && Date.parse(order.promisedAt) <= Date.parse(baselineContext.asOf) && order.fulfillmentState !== 'unknown');
      const baselineLate = baselineDue.filter(order => ['in_transit','delayed','shipped'].includes(order.fulfillmentState));
      rows.push({ id: `region:${region.code}:${new Date(day).toISOString().slice(0,10)}`, grain: 'region_day_inventory',
        region: region.name, regionCode: region.code, day: new Date(day).toISOString().slice(0,10), inventoryAt: at,
        orderCount: orders.length, eligibleShipmentCount: due.length, lateCount: late.length,
        lateShare: due.length ? late.length/due.length : null, baselineAt: baselineContext.asOf,
        baselineNumerator: baselineLate.length, baselineDenominator: baselineDue.length,
        baselineShare: baselineDue.length ? baselineLate.length/baselineDue.length : null, snapshotHash: '' });
    }
  }
  return rows;
}

export function buildSnapshot(dataset: SeedDataset, options: Partial<QueryContext> & { generationId?: number } = {}): Snapshot {
  const context = makeContext(dataset,options);
  const generationId = options.generationId ?? 0;
  if (!Number.isSafeInteger(generationId) || generationId < 0) throw new Error('generationId must be a non-negative integer.');
  const orders = projectOrders(dataset,context);
  const evidence = snapshotEvidence(dataset,orders,context);
  const affectedOrderIds = orders.filter(order => order.affected).map(order => order.id);
  const removedOrderIds = orders.filter(order => order.incidentMember && order.fulfillmentState === 'delivered').map(order => order.id);
  const branches = evaluateBranches(orders,DEFAULT_BUDGET_MINOR,'');
  const visibleEvidenceIds = new Set(evidence.map(row => row.id));
  for (const branch of branches) for (const action of branch.actions) {
    const missing = action.evidenceIds.some(id => !visibleEvidenceIds.has(id));
    action.evidenceIds = action.evidenceIds.filter(id => visibleEvidenceIds.has(id));
    if (missing) {
      action.eligibility = 'blocked';
      action.blockedReason = `${action.blockedReason ?? ''} Required source evidence is unavailable at this snapshot cutoff.`.trim();
    }
  }
  // An empty authorized currency scope still reports that currency, without manufacturing orders.
  for (const branch of branches) branch.currency = context.currency;
  const baselineContext = { ...context, asOf: new Date(Math.min(Date.parse(CARRIER_BASELINE_AT),Date.parse(context.asOf))).toISOString() };
  const detectors = runDetectors(orders,projectOrders(dataset,baselineContext),dataset.events,context);
  const captured = orders.filter(order => ['captured','completed'].includes(order.paymentState));
  const totals: Snapshot['totals'] = { orders: orders.length, captures: captured.length,
    capturedMinor: captured.reduce((sum,order) => sum+order.amountMinor,0), affected: affectedOrderIds.length,
    delivered: orders.filter(order => order.fulfillmentState === 'delivered').length,
    inTransit: orders.filter(order => ['in_transit','delayed','shipped'].includes(order.fulfillmentState)).length,
    refundMinor: orders.reduce((sum,order) => sum+order.refundedMinor,0), openDisputes: orders.filter(order => order.disputeOpen).length };
  const sourceCoverage: Snapshot['sourceCoverage'] = { samplePayments: captured.filter(order => order.paymentSource === 'sample').length,
    sandboxPayments: captured.filter(order => order.paymentSource === 'sandbox' && order.captureId !== null).length,
    fixtureShipments: orders.filter(order => stateAt(dataset.intervals,order.id,'fulfillment',context)?.sourceClass === 'fixture_shipping').length,
    providerDisputes: orders.filter(order => order.disputeOpen && order.disputeSource === 'sandbox' && order.disputeId !== null).length,
    complete: orders.length > 0 && orders.every(order => order.paymentSource === 'sandbox' && order.captureId !== null && order.paypalOrderId !== null && order.fulfillmentState !== 'unknown') };
  const tables: Snapshot['tables'] = {
    order_snapshot: orders.map(order => ({ id: order.id, orderId: order.id, grain: 'order', reference: order.reference,
      region: order.region, regionCode: order.regionCode, fulfillmentState: order.fulfillmentState, paymentState: order.paymentState,
      remediationState: order.remediationState, disputeState: order.disputeState, disputeOpen: order.disputeOpen,
      amountMinor: order.amountMinor, refundableMinor: order.refundableMinor, refundedMinor: order.refundedMinor,
      goodwillCreditMinor: order.goodwillCreditMinor, currency: order.currency, paymentSource: order.paymentSource,
      seedGroup: order.seedGroup, supportContacts: order.supportContacts, narrativeCreatedAt: order.narrativeCreatedAt,
      promisedAt: order.promisedAt, lateHours: order.lateHours, affected: order.affected, incidentMember: order.incidentMember,
      captureId: order.captureId, paypalOrderId: order.paypalOrderId, providerOccurredAt: order.providerOccurredAt,
      captureCount: ['captured','completed'].includes(order.paymentState) ? 1 : 0,
      providerCaptureCount: order.captureId !== null ? 1 : 0, orderCount: 1, resourceVersion: order.resourceVersion, snapshotHash: '' })),
    transition_snapshot: transitions(dataset,orders,context),
    finding_snapshot: [
      ...evidence.map(row => ({ id: row.id, orderId: row.orderId, grain: 'evidence_record', kind: row.kind, title: row.title,
        excerpt: row.excerpt, sourceClass: row.sourceClass, sourceLabel: row.sourceLabel, occurredAt: row.occurredAt, ingestedAt: row.ingestedAt,
        supports: JSON.stringify(row.supports), contradicts: JSON.stringify(row.contradicts), untrusted: row.untrusted ?? false, snapshotHash: '' })),
      ...detectors.map(detector => ({ id: detector.id, orderId: null, grain: 'detector_window', kind: detector.kind,
        title: detector.title, status: detector.status, formulaVersion: detector.formulaVersion,
        baselineNumerator: detector.baselineNumerator, baselineDenominator: detector.baselineDenominator,
        currentNumerator: detector.currentNumerator, currentDenominator: detector.currentDenominator,
        delta: detector.delta, threshold: detector.threshold, window: detector.window, sourceClass: detector.sourceClass,
        explanation: detector.explanation, snapshotHash: '' })),
    ],
    // One proposed policy is materialized at a time. Branch B stays in branches, avoiding a doubled money total.
    action_snapshot: branches[0].actions.map(action => ({ id: action.id, orderId: action.orderId, grain: 'proposed_action',
      branchId: 'targeted', policyId: branches[0].policyId, reference: action.reference, kind: action.kind,
      amountMinor: action.amountMinor, currency: action.currency, resourceId: action.resourceId, resourceVersion: action.resourceVersion,
      sourceClass: action.sourceClass, eligibility: action.eligibility, blockedReason: action.blockedReason,
      payload: JSON.stringify(action.payload), evidenceIds: JSON.stringify(action.evidenceIds), snapshotHash: '' })),
    regional_snapshot: regionalRows(dataset,context),
    deadline_snapshot: orders.filter(order => order.disputeOpen).map(order => ({ id: `deadline:${order.id}`, orderId: order.id,
      grain: 'open_dispute', reference: order.reference, disputeId: order.disputeId, state: order.disputeState,
      sourceClass: order.disputeSource, dueAt: order.disputeDueAt, dueDateVerified: order.disputeSource === 'sandbox' && order.disputeDueAt !== null,
      deadlineCount: 1, snapshotHash: '' })),
  };
  const tableHashes = Object.fromEntries(Object.entries(tables).map(([name,rows]) => [name,stableHash(withoutSnapshotHashes(rows))]));
  const hash = stableHash(withoutSnapshotHashes({ context, tables, tableHashes, orders, evidence, affectedOrderIds, removedOrderIds, branches, detectors, totals, sourceCoverage }));
  for (const order of orders) order.snapshotHash = hash;
  for (const branch of branches) branch.snapshotHash = hash;
  for (const rows of Object.values(tables)) for (const row of rows) row.snapshotHash = hash;
  return { id: `snapshot-${hash.slice(0,28)}`, hash, context, generationId, createdAt: context.knownAt,
    tables, tableHashes, orders, evidence, affectedOrderIds, removedOrderIds, branches, detectors, totals, sourceCoverage };
}
