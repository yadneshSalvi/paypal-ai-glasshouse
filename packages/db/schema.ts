export const schema = `
CREATE TABLE IF NOT EXISTS gh_schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gh_sessions (
  token_hash text PRIMARY KEY, actor jsonb NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gh_datasets (
  tenant_id text PRIMARY KEY, revision integer NOT NULL, body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gh_source_events (
  tenant_id text NOT NULL, id text NOT NULL, order_id text NOT NULL,
  occurred_at timestamptz NOT NULL, ingested_at timestamptz NOT NULL,
  source_class text NOT NULL, body jsonb NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS gh_state_intervals (
  tenant_id text NOT NULL, id text NOT NULL, order_id text NOT NULL, dimension text NOT NULL,
  state text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
  knowledge_from timestamptz NOT NULL, knowledge_to timestamptz, clock_domain text NOT NULL,
  source_class text NOT NULL, source_event_id text NOT NULL, revision integer NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK(valid_to IS NULL OR valid_to > valid_from),
  CHECK(knowledge_to IS NULL OR knowledge_to > knowledge_from)
);
CREATE INDEX IF NOT EXISTS gh_intervals_query ON gh_state_intervals (tenant_id, clock_domain, valid_from, knowledge_from);
CREATE TABLE IF NOT EXISTS gh_snapshots (
  tenant_id text NOT NULL, id text NOT NULL, hash text NOT NULL, context jsonb NOT NULL,
  table_hashes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS gh_plans (
  tenant_id text NOT NULL, id text NOT NULL, version integer NOT NULL,
  status text NOT NULL, plan_hash text NOT NULL, cohort_version integer NOT NULL,
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS gh_operations (
  tenant_id text NOT NULL, id text NOT NULL, plan_id text NOT NULL, action_id text NOT NULL,
  status text NOT NULL, body jsonb NOT NULL, lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, plan_id, action_id)
);
CREATE TABLE IF NOT EXISTS gh_resource_claims (
  tenant_id text NOT NULL, resource_id text NOT NULL, action_kind text NOT NULL,
  operation_id text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, resource_id, action_kind, operation_id)
);
CREATE TABLE IF NOT EXISTS gh_audit (
  sequence bigserial PRIMARY KEY, tenant_id text NOT NULL, id text NOT NULL UNIQUE,
  timestamp timestamptz NOT NULL, actor_id text NOT NULL, event_type text NOT NULL,
  body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS gh_audit_tenant ON gh_audit (tenant_id, sequence);
CREATE TABLE IF NOT EXISTS gh_layouts (
  tenant_id text NOT NULL, id text NOT NULL, version integer NOT NULL DEFAULT 1,
  body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS gh_threads (
  tenant_id text NOT NULL, id text NOT NULL, body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS gh_agent_events (
  sequence bigserial PRIMARY KEY, tenant_id text NOT NULL, event_id text NOT NULL,
  run_id text NOT NULL, source_context_hash text NOT NULL, body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id,event_id)
);
CREATE TABLE IF NOT EXISTS gh_model_items (
  tenant_id text NOT NULL, id text NOT NULL, body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS gh_jobs (
  tenant_id text NOT NULL, id text NOT NULL, kind text NOT NULL, state text NOT NULL,
  body jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS gh_capabilities (
  id text PRIMARY KEY, available boolean NOT NULL, source text NOT NULL,
  evidence jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gh_schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
`;
