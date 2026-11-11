import type {Database} from '@/packages/db/client';
export const reportingSchema=`
CREATE TABLE IF NOT EXISTS gh_reporting_runs (
 tenant_id text NOT NULL,id text NOT NULL,request_id text NOT NULL,payload_hash text NOT NULL,
 connector_id text NOT NULL,config_hash text NOT NULL,actor jsonb NOT NULL,grants jsonb NOT NULL,grant_hash text NOT NULL,
 start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'active',
 reason text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS gh_reporting_one_active ON gh_reporting_runs(tenant_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS gh_reporting_windows (
 tenant_id text NOT NULL,run_id text NOT NULL,ordinal integer NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'queued',next_page integer NOT NULL DEFAULT 1,metadata jsonb,attempts integer NOT NULL DEFAULT 0,
 lease_id text,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),reason text,
 PRIMARY KEY(tenant_id,run_id,ordinal),FOREIGN KEY(tenant_id,run_id) REFERENCES gh_reporting_runs(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS gh_reporting_pages (
 tenant_id text NOT NULL,run_id text NOT NULL,ordinal integer NOT NULL,page integer NOT NULL,attempt_id text NOT NULL,
 state text NOT NULL DEFAULT 'reading',started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 body jsonb,reason text,PRIMARY KEY(tenant_id,run_id,attempt_id)
);
CREATE TABLE IF NOT EXISTS gh_reporting_evidence (
 tenant_id text NOT NULL,run_id text NOT NULL,transaction_id text NOT NULL,body_hash text NOT NULL,observed_at timestamptz NOT NULL,
 body jsonb NOT NULL,PRIMARY KEY(tenant_id,run_id,transaction_id,body_hash)
);
INSERT INTO gh_schema_version(version) VALUES(6) ON CONFLICT DO NOTHING;
`;
const pending=new WeakMap<Database,Promise<void>>();
export function ensureReportingSchema(db:Database){let work=pending.get(db);if(!work){work=db.transaction(async tx=>{await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-reporting-schema-v6'))");for(const statement of reportingSchema.split(';').map(s=>s.trim()).filter(Boolean))await tx.query(statement);}).catch(e=>{pending.delete(db);throw e;});pending.set(db,work);}return work;}
