import type { Database } from '@/packages/db/client';

export const recoverySchema = `
CREATE TABLE IF NOT EXISTS gh_dispute_inventories (
 tenant_id text NOT NULL, capture_id text NOT NULL, order_id text NOT NULL,
 observed_at timestamptz NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,capture_id)
);
CREATE TABLE IF NOT EXISTS gh_recovery_runs (
 tenant_id text NOT NULL, plan_id text NOT NULL, plan_hash text NOT NULL, membership_version integer NOT NULL,
 approved_by text NOT NULL, accepted_revision integer NOT NULL, accepted_resources jsonb NOT NULL,
 fixture_acknowledged boolean NOT NULL, status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,plan_id)
);
CREATE TABLE IF NOT EXISTS gh_recovery_intents (
 tenant_id text NOT NULL, id text NOT NULL, semantic_key text NOT NULL, plan_id text NOT NULL,
 action_id text NOT NULL, order_id text NOT NULL, kind text NOT NULL, payload_hash text NOT NULL,
 command jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', provider_id text,
 receipt jsonb, reason text, attempt integer NOT NULL DEFAULT 0,
 lease_owner text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,semantic_key), UNIQUE(tenant_id,plan_id,action_id)
);
CREATE INDEX IF NOT EXISTS gh_recovery_work ON gh_recovery_intents(status,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS gh_scenario_revisions (
 tenant_id text NOT NULL,id text NOT NULL,payload_hash text NOT NULL,actor_id text NOT NULL,
 observed_at timestamptz NOT NULL,body jsonb NOT NULL,PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS gh_dispute_scenario_bindings (
 tenant_id text NOT NULL,revision_id text NOT NULL,original_order_id text NOT NULL,target_order_id text NOT NULL,
 capture_id text NOT NULL,buyer_transaction_id text NOT NULL,amount_minor integer NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(tenant_id,target_order_id),UNIQUE(tenant_id,original_order_id),UNIQUE(tenant_id,buyer_transaction_id)
);
INSERT INTO gh_schema_version(version) VALUES(3) ON CONFLICT DO NOTHING;
INSERT INTO gh_schema_version(version) VALUES(4) ON CONFLICT DO NOTHING;
`;
const migrations = new WeakMap<Database, Promise<void>>();
export function ensureRecoverySchema(db: Database): Promise<void> {
  let migration = migrations.get(db);
  if (!migration) {
    migration = db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-recovery-schema-v4'))");
      for (const statement of recoverySchema.split(';').map(value => value.trim()).filter(Boolean)) await tx.query(statement);
    }).catch(error => { migrations.delete(db); throw error; });
    migrations.set(db, migration);
  }
  return migration;
}
