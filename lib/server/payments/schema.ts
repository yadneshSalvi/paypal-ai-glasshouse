import type { Database } from '@/packages/db/client';
import type { SqlDatabase, SqlConnection } from '@fracture/paypal-core';

export const paymentsSchema = `
CREATE TABLE IF NOT EXISTS gh_memberships (
 tenant_id text NOT NULL, actor_id text NOT NULL, role text NOT NULL, version integer NOT NULL,
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(tenant_id,actor_id)
);
CREATE TABLE IF NOT EXISTS gh_seed_runs (
 tenant_id text NOT NULL, id text NOT NULL, seed_version text NOT NULL, manifest_hash text NOT NULL,
 manifest jsonb NOT NULL, status text NOT NULL, created_by text NOT NULL, membership_version integer NOT NULL,
 consent_id text, approval_version integer NOT NULL DEFAULT 0, approval_digest text,
 approved_by text, approved_at timestamptz, approval_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,seed_version)
);
CREATE TABLE IF NOT EXISTS gh_payment_consents (
 tenant_id text NOT NULL, id text NOT NULL, run_id text NOT NULL, version integer NOT NULL,
 digest text NOT NULL, status text NOT NULL, created_by text NOT NULL, membership_version integer NOT NULL,
 expires_at timestamptz NOT NULL, verified_at timestamptz, reason text,
 private_document text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,run_id)
);
CREATE TABLE IF NOT EXISTS gh_vault_operations (
 tenant_id text NOT NULL, id text NOT NULL, consent_id text NOT NULL, kind text NOT NULL,
 status text NOT NULL, provider_request_id text NOT NULL, request_hash text NOT NULL,
 private_document text NOT NULL, receipt jsonb, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,consent_id,kind), UNIQUE(provider_request_id)
);
CREATE TABLE IF NOT EXISTS gh_seed_items (
 tenant_id text NOT NULL, run_id text NOT NULL, order_id text NOT NULL, entry jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued', provider_order_id text, provider_capture_id text,
 create_operation_id text, capture_operation_id text, lease_owner text, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 reason text, observed_at timestamptz, receipt jsonb,
 PRIMARY KEY(tenant_id,run_id,order_id), UNIQUE(tenant_id,order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS gh_seed_provider_orders ON gh_seed_items(provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gh_seed_provider_captures ON gh_seed_items(provider_capture_id) WHERE provider_capture_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS gh_payment_commands (
 tenant_id text NOT NULL, operation_id text NOT NULL, business_key text NOT NULL,
 run_id text, order_id text NOT NULL, plan_id text, action_kind text NOT NULL,
 created_by text NOT NULL, membership_version integer NOT NULL, payload_hash text NOT NULL,
 private_document text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,operation_id), UNIQUE(tenant_id,business_key)
);
CREATE TABLE IF NOT EXISTS gh_provider_resources (
 tenant_id text NOT NULL, kind text NOT NULL, provider_id text NOT NULL, order_id text NOT NULL,
 run_id text NOT NULL, version integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 observed_at timestamptz NOT NULL, body jsonb NOT NULL,
 PRIMARY KEY(tenant_id,kind,provider_id), UNIQUE(kind,provider_id)
);
CREATE TABLE IF NOT EXISTS gh_provider_observations (
 tenant_id text NOT NULL, id text NOT NULL, order_id text NOT NULL, resource_id text NOT NULL,
 kind text NOT NULL, observed_at timestamptz NOT NULL, body_hash text NOT NULL, body jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,kind,resource_id,body_hash)
);
CREATE INDEX IF NOT EXISTS gh_seed_work ON gh_seed_items(status,next_attempt_at,lease_until);
INSERT INTO gh_schema_version(version) VALUES(2) ON CONFLICT DO NOTHING;
`;

const migrations = new WeakMap<Database, Promise<void>>();
export function ensurePaymentsSchema(db: Database): Promise<void> {
  let promise = migrations.get(db);
  if (!promise) {
    promise = db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-payments-schema-v2'))");
      for (const statement of paymentsSchema.split(';').map(value => value.trim()).filter(Boolean)) await tx.query(statement);
    }).catch(error => { migrations.delete(db); throw error; });
    migrations.set(db, promise);
  }
  return promise;
}

/** Preserve real affected-row counts for the core's webhook deduplication contract. */
export function coreDatabase(db: Database): SqlDatabase {
  const connection = (client: Database): SqlConnection => ({
    dialect: 'postgres',
    async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)) sql += ' RETURNING 1';
      const rows = await client.query<T>(sql, values);
      return { rows, rowCount: rows.length };
    },
  });
  return { ...connection(db), transaction: work => db.transaction(tx => work(connection(tx))), async close() {} };
}
