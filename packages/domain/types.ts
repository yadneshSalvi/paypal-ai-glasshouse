export type Currency = 'USD' | 'EUR' | 'GBP';
export type SourceClass = 'sample' | 'fixture_shipping' | 'fixture_support' | 'sandbox' | 'replay' | 'modelled';
export type ClockDomain = 'observed' | 'narrative_replay';
export type Role = 'owner' | 'operator' | 'investigator' | 'viewer' | 'judge';
export type Dimension = 'payment' | 'fulfillment' | 'remediation' | 'dispute';
export type ActionKind = 'refund' | 'tracking' | 'dispute_response';
export type OperationStatus = 'queued' | 'submitting' | 'provider_pending' | 'provider_success' | 'provider_failed' | 'unknown_outcome' | 'reconciled' | 'blocked';

export interface Actor {
  id: string; tenantId: string; role: Role; membershipVersion: number;
  grantId?: string; allowedResourceIds?: string[];
}
export interface SourceEvent {
  id: string; tenantId: string; orderId: string; type: string; dimension: Dimension;
  state: string; occurredAt: string; ingestedAt: string; narrativeTime: string;
  sourceClass: SourceClass; sourceLabel: string; sourceRef: string;
  payload: Record<string, unknown>; revision: number;
}
export interface StateInterval {
  id: string; tenantId: string; orderId: string; dimension: Dimension; state: string;
  validFrom: string; validTo: string | null; knowledgeFrom: string; knowledgeTo: string | null;
  clockDomain: ClockDomain; sourceEventId: string; sourceClass: SourceClass; revision: number;
}
export interface Order {
  id: string; tenantId: string; reference: string; customerAlias: string; product: string;
  region: string; regionCode: string; amountMinor: number; currency: Currency;
  createdAt: string; narrativeCreatedAt: string; promisedAt: string;
  captureId: string | null; paypalOrderId: string | null; providerOccurredAt: string | null;
  paymentSource: SourceClass; refundableMinor: number; refundedMinor: number; goodwillCreditMinor: number;
  shipmentRef: string; carrier: string; trackingNumber: string; trackingInPayPal: boolean;
  disputeId: string | null; disputeOpen: boolean; disputeSource: SourceClass;
  disputeDueAt: string | null; disputeState: string | null;
  disputeEvidenceHash?: string | null;
  shipmentEvidenceId?: string; disputeEvidenceId?: string;
  incidentMember: boolean; seedGroup: 'delivered_revision' | 'disputed' | 'eligible' | 'grace' | 'context';
  resourceVersion: number; costMinor: number; supportContacts: number;
}
export interface Evidence {
  id: string; tenantId: string; orderId: string | null; title: string; excerpt: string;
  sourceClass: SourceClass; sourceLabel: string; occurredAt: string; ingestedAt: string;
  kind: 'shipment' | 'payment' | 'support' | 'finding' | 'contradiction' | 'policy' | 'dispute';
  supports: string[]; contradicts: string[]; untrusted?: boolean;
}
export interface SeedDataset {
  version: string; tenantId: string; orders: Order[]; events: SourceEvent[];
  evidence: Evidence[]; intervals: StateInterval[]; revision: number;
}
export interface QueryContext {
  tenantId: string; rolePolicyVersion: string; roleScope: Role;
  clockDomain: ClockDomain; sourceMode: 'sample' | 'mixed' | 'sandbox' | 'replay';
  asOf: string; knownAt: string; cohortId: string; cohortVersion: number; currency: Currency;
  semanticModelVersion: string; projectionVersion: number; filterHash: string;
}
export interface SnapshotOrder extends Order {
  paymentState: string; fulfillmentState: string; remediationState: string;
  affected: boolean; lateHours: number; ageDays: number; snapshotHash: string;
}
export interface ConditionResult { key: 'undelivered' | 'grace' | 'dispute' | 'prior_remedy' | 'balance'; passed: boolean; label: string }
export interface EligibilityRow { orderId: string; eligible: boolean; conditions: ConditionResult[]; excludedReasons: string[] }
export interface ActionRow {
  id: string; orderId: string; reference: string; kind: ActionKind; amountMinor: number; currency: Currency;
  resourceId: string | null; resourceVersion: number; sourceClass: SourceClass;
  eligibility: 'eligible' | 'blocked'; blockedReason: string | null;
  evidenceIds: string[]; payload: Record<string, unknown>;
}
export interface RecoveryBranch {
  id: 'targeted' | 'comprehensive'; name: string; policyId: string; graceHours: number;
  amountMinor: number; currency: Currency; budgetMinor: number; withinBudget: boolean;
  eligibleCount: number; refundTotalMinor: number; trackingCount: number; disputeCount: number;
  rows: EligibilityRow[]; actions: ActionRow[]; exclusionCounts: Record<string, number>;
  snapshotHash: string;
}
export interface Detector {
  id: string; kind: 'carrier_delay' | 'margin_leak' | 'checkout_decline'; title: string;
  status: 'detected' | 'insufficient_evidence' | 'normal'; formulaVersion: string;
  baselineNumerator: number; baselineDenominator: number; currentNumerator: number; currentDenominator: number;
  delta: number; threshold: number; window: string; sourceClass: SourceClass; explanation: string;
}
export type TableRow = Record<string, string | number | boolean | null>;
export interface Snapshot {
  id: string; hash: string; context: QueryContext; generationId: number; createdAt: string;
  tables: { order_snapshot: TableRow[]; transition_snapshot: TableRow[]; finding_snapshot: TableRow[]; action_snapshot: TableRow[]; regional_snapshot: TableRow[]; deadline_snapshot: TableRow[] };
  tableHashes: Record<string, string>; sourceCoverage: { samplePayments: number; sandboxPayments: number; fixtureShipments: number; providerDisputes: number; complete: boolean };
  orders: SnapshotOrder[]; evidence: Evidence[]; affectedOrderIds: string[]; removedOrderIds: string[];
  branches: RecoveryBranch[]; detectors: Detector[];
  totals: { orders: number; captures: number; capturedMinor: number; affected: number; delivered: number; inTransit: number; refundMinor: number; openDisputes: number };
}
export interface RecoveryPlan {
  id: string; tenantId: string; version: number; createdBy: string; createdAt: string;
  status: 'draft' | 'ready_for_review' | 'approved' | 'stale' | 'executing' | 'partially_complete' | 'completed' | 'blocked' | 'expired';
  branch: RecoveryBranch; snapshotId: string; snapshotHash: string; cohortVersion: number;
  hash: string; expiresAt: string; staleReason: string | null; approvedBy: string | null; approvedAt: string | null;
  executionMode: 'sandbox' | 'sample';
  contractVersion?: 2; context?: QueryContext;
  approvalMembershipVersion?: number; fixtureShippingAcknowledged?: boolean;
}
export interface Operation {
  id: string; tenantId: string; planId: string; actionId: string; orderId: string; kind: ActionKind;
  amountMinor: number; currency: Currency; status: OperationStatus; providerRequestId: string;
  payloadHash: string; providerId: string | null; attempts: number; updatedAt: string;
  sourceClass: SourceClass; result: Record<string, unknown> | null; reason: string | null;
}
export interface AuditEvent {
  id: string; tenantId: string; timestamp: string; actorId: string;
  type: string; summary: string; refId: string | null; data: Record<string, unknown>;
}
export interface AgentRunEvent {
  eventId: string; runId: string; parentRunId: string | null; agentId: string;
  eventType: string; toolName: string | null; transportKind: 'Studio' | 'Toolkit' | 'SDK' | 'REST' | 'application' | 'OpenAI' | 'Gemini';
  inputHash: string; redactedResultRef: string | null; resultStatus: 'running' | 'success' | 'error' | 'denied';
  sourceContextHash: string; timestamp: string; summary: string;
}
