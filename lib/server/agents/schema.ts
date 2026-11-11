import type {Database} from '@/packages/db/client';

/** Additive only. Encrypting legacy documents is a separate, explicit migration. */
export const agentsSchema=`
CREATE TABLE IF NOT EXISTS gh_agent_runs (
 tenant_id text NOT NULL,id text NOT NULL,thread_id text NOT NULL,user_message_id text NOT NULL,
 actor_id text NOT NULL,membership_version integer NOT NULL,agent_id text NOT NULL,
 parent_run_id text,parent_tool_call_id text,snapshot_hash text NOT NULL,
 state text NOT NULL DEFAULT 'running',reason text,private_document text NOT NULL,
 lease_owner text,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,thread_id,user_message_id),
 CHECK(state IN ('running','completed','held','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gh_agent_child_identity ON gh_agent_runs(tenant_id,parent_tool_call_id) WHERE parent_tool_call_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS gh_agent_model_turns (
 tenant_id text NOT NULL,run_id text NOT NULL,turn_index integer NOT NULL,
 state text NOT NULL DEFAULT 'prepared',request_hash text NOT NULL,private_document text NOT NULL,
 has_provider_id boolean NOT NULL DEFAULT false,provider_stored boolean,dispatch_count integer NOT NULL DEFAULT 0,
 lease_owner text,lease_until timestamptz,reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id,turn_index),FOREIGN KEY(tenant_id,run_id) REFERENCES gh_agent_runs(tenant_id,id),
 CHECK(turn_index>=0),CHECK(dispatch_count BETWEEN 0 AND 1),
 CHECK(state IN ('prepared','dispatching','pending','completed','failed','unknown','unavailable'))
);
ALTER TABLE gh_agent_model_turns ADD COLUMN IF NOT EXISTS provider_stored boolean;
ALTER TABLE gh_agent_model_turns DROP CONSTRAINT IF EXISTS gh_agent_model_turns_state_check;
ALTER TABLE gh_agent_model_turns ADD CONSTRAINT gh_agent_model_turns_state_check CHECK(state IN ('prepared','dispatching','pending','completed','failed','unknown','unavailable'));
CREATE TABLE IF NOT EXISTS gh_agent_tool_calls (
 tenant_id text NOT NULL,id text NOT NULL,run_id text NOT NULL,turn_index integer NOT NULL,
 name text NOT NULL,input_hash text NOT NULL,transport text NOT NULL,state text NOT NULL DEFAULT 'issued',
 private_document text NOT NULL,dispatch_count integer NOT NULL DEFAULT 0,
 lease_token text,mutation_id text,layout_version integer,layout_hash text,reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,run_id,turn_index) REFERENCES gh_agent_model_turns(tenant_id,run_id,turn_index),
 CHECK(dispatch_count BETWEEN 0 AND 1),CHECK(state IN ('issued','running','completed','unknown','denied'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gh_agent_mutation_identity ON gh_agent_tool_calls(tenant_id,mutation_id) WHERE mutation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS gh_agent_durable_events (
 sequence bigserial NOT NULL,tenant_id text NOT NULL,id text NOT NULL,run_id text NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS gh_agent_events_workspace ON gh_agent_durable_events(tenant_id,sequence);
CREATE TABLE IF NOT EXISTS gh_agent_documents (
 tenant_id text NOT NULL,id text NOT NULL,run_id text NOT NULL,kind text NOT NULL,
 snapshot_hash text NOT NULL,private_document text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
ALTER TABLE gh_threads ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE gh_threads ADD COLUMN IF NOT EXISTS actor_id text;
INSERT INTO gh_schema_version(version) VALUES(7) ON CONFLICT DO NOTHING;
`;
const migrations=new WeakMap<Database,Promise<void>>();
export function ensureAgentsSchema(db:Database){
  let work=migrations.get(db);
  if(!work){work=db.transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-agents-schema-v7'))");
    for(const statement of agentsSchema.split(';').map(v=>v.trim()).filter(Boolean))await tx.query(statement);
  }).catch(error=>{migrations.delete(db);throw error;});migrations.set(db,work);}
  return work;
}
