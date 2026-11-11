export type SeedRunStatus = 'draft' | 'awaiting_consent' | 'ready' | 'approved' | 'running' | 'complete' | 'held' | 'revoked';
export type SeedItemStatus = 'queued' | 'creating' | 'awaiting_buyer' | 'capturing' | 'verifying' | 'captured' | 'unknown' | 'refused' | 'held';
export type ConsentStatus = 'preparing' | 'awaiting_buyer' | 'exchanging' | 'verified' | 'unknown' | 'refused' | 'revoked';

export interface SeedManifestEntry {
  orderId: string;
  reference: string;
  product: string;
  amountMinor: number;
  currency: 'USD';
  resourceVersion: number;
}
export interface SeedManifest {
  schemaVersion: 'glasshouse.seed.v1';
  tenantId: string;
  seedVersion: string;
  currency: 'USD';
  entryCount: number;
  totalMinor: number;
  maximumOrderMinor: number;
  entries: SeedManifestEntry[];
  hash: string;
}
export interface SeedRun {
  id: string;
  status: SeedRunStatus;
  manifest: SeedManifest;
  createdAt: string;
  approvedAt: string | null;
  approvalExpiresAt: string | null;
  approvalVersion: number;
  consent: null | {
    id: string;
    status: ConsentStatus;
    verifiedAt: string | null;
    expiresAt: string;
    approvalUrl: string | null;
    reason: string | null;
  };
  progress: {
    captured: number;
    capturedMinor: number;
    pending: number;
    unknown: number;
    refused: number;
    held: number;
  };
  items: Array<SeedManifestEntry & {
    status: SeedItemStatus;
    providerOrderId: string | null;
    providerCaptureId: string | null;
    reason: string | null;
    observedAt: string | null;
  }>;
}
export interface SandboxStatus {
  environment: 'sandbox';
  isolated: boolean;
  configured: boolean;
  role: string;
  canApprove: boolean;
  run: SeedRun | null;
  suggestedManifest: SeedManifest;
}
