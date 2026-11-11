import type { Database } from '@/packages/db/client';
import type { Actor, Role } from '@/packages/domain/types';
import type { SeedManifest, SeedManifestEntry, SeedRunStatus, ConsentStatus, SeedItemStatus } from '@/packages/payments/types';
import type { PaymentSecrets } from '@/packages/payments/security';
import type { SetupObservation, TokenObservation, VaultReceipt } from './vault';
import { HttpError } from '../errors';
import {assertWorkspaceContext,assertWorkspaceProviderScope,assertWorkspaceWritable} from '../workspaces/authority';

export type RunRecord = Record<string, unknown> & {
  tenant_id: string; id: string; manifest: SeedManifest; manifest_hash: string; status: SeedRunStatus;
  created_by: string; membership_version: number; consent_id: string | null; approval_version: number;
  approval_digest: string | null; approved_by: string | null; approved_at: string | Date | null;
  approval_expires_at: string | Date | null; created_at: string | Date;
};
export type ConsentRecord = Record<string, unknown> & {
  tenant_id: string; id: string; run_id: string; version: number; digest: string; status: ConsentStatus;
  created_by: string; membership_version: number; expires_at: string | Date;
  verified_at: string | Date | null; reason: string | null; private_document: string;
};
export type ItemRecord = Record<string, unknown> & {
  tenant_id: string; run_id: string; order_id: string; entry: SeedManifestEntry; status: SeedItemStatus;
  provider_order_id: string | null; provider_capture_id: string | null;
  create_operation_id: string | null; capture_operation_id: string | null;
  lease_owner: string | null; lease_until: string | Date | null; attempts: number;
  reason: string | null; observed_at: string | Date | null; receipt: Record<string, unknown> | null;
};
export interface ConsentPrivate {
  origin: string; nonce: string; nonceHash: string; merchantCustomerId: string; runHash: string;
  callbackVerified: boolean; setup?: SetupObservation; token?: TokenObservation; baselineTokenIds?: string[];
  baselineAbsence?: VaultReceipt | null;
}
export const iso = (value: string | Date | null): string | null => value === null ? null : new Date(value).toISOString();
export const consentIdentity = (tenant: string, id: string) => JSON.stringify(['glasshouse', tenant, 'consent', id]);
export const commandIdentity = (tenant: string, id: string) => JSON.stringify(['glasshouse', tenant, 'command', id]);
export const vaultIdentity = (tenant: string, id: string) => JSON.stringify(['glasshouse', tenant, 'vault-operation', id]);
export const openConsent = (secrets: PaymentSecrets, row: ConsentRecord) => secrets.open<ConsentPrivate>(row.private_document, consentIdentity(row.tenant_id, row.id));

export async function currentMember(db: Database, tenantId: string, actorId: string, expectedVersion?: number,requestActor?:Actor): Promise<Actor> {
  if(requestActor&&requestActor.tenantId!==tenantId)throw new HttpError(403,'CURRENT_AUTHORITY_REQUIRED','The requesting workspace does not own this operation.');
  if(requestActor)await assertWorkspaceContext(db,requestActor,true);
  await assertWorkspaceWritable(db,tenantId);await assertWorkspaceProviderScope(db,tenantId);
  const row = (await db.query<{ role: Role; version: number; active: boolean }>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE', [tenantId, actorId]))[0];
  if (!row?.active || !['owner','operator','judge'].includes(row.role) || expectedVersion !== undefined && row.version !== expectedVersion) throw new HttpError(403, 'CURRENT_AUTHORITY_REQUIRED', 'Current workspace authority is required for this sandbox operation.');
  return { id: actorId, tenantId, role: row.role, membershipVersion: row.version };
}
export async function runRecord(db: Database, tenantId: string, id: string, lock = false): Promise<RunRecord> {
  const row = (await db.query<RunRecord>(`SELECT * FROM gh_seed_runs WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]))[0];
  if (!row) throw new HttpError(404, 'SEED_RUN_NOT_FOUND', 'This sandbox batch is outside your workspace.');
  return row;
}
export async function consentRecord(db: Database, tenantId: string, id: string, lock = false): Promise<ConsentRecord> {
  const row = (await db.query<ConsentRecord>(`SELECT * FROM gh_payment_consents WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]))[0];
  if (!row) throw new HttpError(404, 'CONSENT_NOT_FOUND', 'This saved-payment consent is outside your workspace.');
  return row;
}
