import type { Database } from '@/packages/db/client';
import type { Actor, Role } from '@/packages/domain/types';
import type { SeedManifest, SeedManifestEntry } from '@/packages/payments/types';
import { digest } from '@/packages/payments/security';
import { HttpError } from '../errors';
import { seedMarker } from '../payments/execution';
import {assertWorkspaceContext,assertWorkspaceWritable} from '../workspaces/authority';

export interface OwnedPayment {
  tenantId: string; orderId: string; runId: string; entry: SeedManifestEntry;
  providerOrderId: string; captureId: string; customId: string;
  orderGrantVersion: number; captureGrantVersion: number;
}
export async function recoveryMember(db: Database, actor: Actor, write = false, expectedVersion = actor.membershipVersion): Promise<Actor> {
  await assertWorkspaceContext(db,actor,write);
  if(write)await assertWorkspaceWritable(db,actor.tenantId);
  const membership = (await db.query<{ role: Role; version: number; active: boolean }>(
    'SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE', [actor.tenantId, actor.id]))[0];
  const roles: Role[] = write ? ['owner', 'operator', 'judge'] : ['owner', 'operator', 'judge', 'investigator', 'viewer'];
  if (!membership?.active || !roles.includes(membership.role) || membership.version !== expectedVersion) {
    throw new HttpError(403, 'CURRENT_AUTHORITY_REQUIRED', 'Current workspace membership is required for this operation.');
  }
  return { ...actor,role: membership.role, membershipVersion: membership.version };
}

/** The complete tenant seed manifest and active durable grants define the legal resource set. */
export async function ownedPayment(db: Database, actor: Actor, orderId: string): Promise<OwnedPayment> {
  await recoveryMember(db, actor);
  return ownedPaymentResource(db,actor.tenantId,orderId);
}
/** Internal reconciliation only: the persisted intent selects the exact tenant/order, never a browser resource ID. */
export async function ownedPaymentResource(db: Database, tenantId: string, orderId: string): Promise<OwnedPayment> {
  type Row = Record<string, unknown> & {
    entry: SeedManifestEntry; run_id: string; manifest: SeedManifest; manifest_hash: string;
    provider_order_id: string; provider_capture_id: string; order_version: number; capture_version: number;
  };
  const row = (await db.query<Row>(`SELECT i.entry,i.run_id,r.manifest,r.manifest_hash,i.provider_order_id,i.provider_capture_id,
    o.version AS order_version,c.version AS capture_version
    FROM gh_seed_items i JOIN gh_seed_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id
    JOIN gh_provider_resources o ON o.tenant_id=i.tenant_id AND o.kind='order' AND o.provider_id=i.provider_order_id AND o.order_id=i.order_id AND o.run_id=i.run_id AND o.active=true
    JOIN gh_provider_resources c ON c.tenant_id=i.tenant_id AND c.kind='capture' AND c.provider_id=i.provider_capture_id AND c.order_id=i.order_id AND c.run_id=i.run_id AND c.active=true
    WHERE i.tenant_id=$1 AND i.order_id=$2 AND i.status='captured'`, [tenantId, orderId]))[0];
  const expected = row?.manifest.entries.find(entry => entry.orderId === orderId);
  if (!row || !expected || row.manifest.hash !== row.manifest_hash || digest(expected) !== digest(row.entry) || row.entry.currency !== 'USD') {
    throw new HttpError(403, 'OWNED_CAPTURE_REQUIRED', 'This order has no current independently verified sandbox payment grant.');
  }
  return { tenantId, orderId, runId: row.run_id, entry: row.entry, providerOrderId: row.provider_order_id,
    captureId: row.provider_capture_id, customId: seedMarker(tenantId, row.run_id, orderId),
    orderGrantVersion: row.order_version, captureGrantVersion: row.capture_version };
}
