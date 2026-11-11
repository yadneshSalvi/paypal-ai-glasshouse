import type { Database } from '@/packages/db/client';

export const observationSchema = `
CREATE TABLE IF NOT EXISTS gh_paypal_connectors (
 id text PRIMARY KEY, tenant_id text NOT NULL, credential_hash text NOT NULL UNIQUE,
 webhook_id text NOT NULL UNIQUE, merchant_id text NOT NULL, config_hash text NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gh_webhook_deliveries (
 id text PRIMARY KEY, connector_id text NOT NULL, event_id text, received_at timestamptz NOT NULL DEFAULT now(),
 raw_hash text NOT NULL, transmission_id text, verified boolean NOT NULL, outcome text NOT NULL,
 private_document text NOT NULL
);
CREATE INDEX IF NOT EXISTS gh_webhook_delivery_connector ON gh_webhook_deliveries(connector_id,received_at);
CREATE TABLE IF NOT EXISTS gh_webhook_events (
 connector_id text NOT NULL, event_id text NOT NULL, tenant_id text NOT NULL, event_type text NOT NULL,
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), raw_hash text NOT NULL,
 state text NOT NULL, reason text, private_document text NOT NULL,
 PRIMARY KEY(connector_id,event_id)
);
CREATE TABLE IF NOT EXISTS gh_observation_jobs (
 tenant_id text NOT NULL, id text NOT NULL, kind text NOT NULL, connector_id text, event_id text,
 subject jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', result jsonb,
 attempts integer NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(connector_id,event_id)
);
CREATE INDEX IF NOT EXISTS gh_observation_work ON gh_observation_jobs(state,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS gh_status_checks (
 tenant_id text NOT NULL, id text NOT NULL, operation_id text NOT NULL, job_id text NOT NULL,
 checked_at timestamptz NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS gh_status_checks_operation ON gh_status_checks(tenant_id,operation_id,checked_at);
INSERT INTO gh_schema_version(version) VALUES(5) ON CONFLICT DO NOTHING;
`;
const migrations = new WeakMap<Database,Promise<void>>();
export function ensureObservationSchema(db: Database): Promise<void> {
  let work = migrations.get(db);
  if (!work) {
    work = db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-observation-schema-v5'))");
      for (const statement of observationSchema.split(';').map(value => value.trim()).filter(Boolean)) await tx.query(statement);
    }).catch(error => { migrations.delete(db); throw error; });
    migrations.set(db,work);
  }
  return work;
}
