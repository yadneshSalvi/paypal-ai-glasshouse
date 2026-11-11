import type {Database} from '@/packages/db/client';

/** Additive metadata only; existing sessions, roles, financial resources and
 * immutable history are never rewritten by this migration. */
export const workspacesSchema=`
CREATE TABLE IF NOT EXISTS gh_people (
 id text PRIMARY KEY,display_name text NOT NULL,identity_kind text NOT NULL DEFAULT 'browser_capability',
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(identity_kind='browser_capability')
);
CREATE TABLE IF NOT EXISTS gh_organizations (
 id text PRIMARY KEY,name text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL REFERENCES gh_people(id),created_at timestamptz NOT NULL DEFAULT now(),CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS gh_organization_members (
 organization_id text NOT NULL REFERENCES gh_organizations(id),person_id text NOT NULL REFERENCES gh_people(id),
 role text NOT NULL,version integer NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,person_id),
 CHECK(role IN ('owner','member')),CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS gh_workspaces (
 tenant_id text PRIMARY KEY,organization_id text NOT NULL REFERENCES gh_organizations(id),
 name text NOT NULL,merchant_name text NOT NULL,description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active',source_kind text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL REFERENCES gh_people(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status IN ('active','archived')),CHECK(source_kind IN ('sample','existing')),CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS gh_actor_people (
 tenant_id text NOT NULL,actor_id text NOT NULL,person_id text NOT NULL REFERENCES gh_people(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,actor_id),UNIQUE(tenant_id,person_id)
);
CREATE TABLE IF NOT EXISTS gh_workspace_access_sessions (
 id text PRIMARY KEY,person_id text NOT NULL REFERENCES gh_people(id),current_session_hash text NOT NULL,
 context_id text NOT NULL,version integer NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS gh_workspace_session_links (
 session_hash text PRIMARY KEY REFERENCES gh_sessions(token_hash),access_id text NOT NULL REFERENCES gh_workspace_access_sessions(id),
 tenant_id text NOT NULL,actor_id text NOT NULL,private_token text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(access_id,tenant_id)
);
CREATE TABLE IF NOT EXISTS gh_workspace_invitations (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES gh_workspaces(tenant_id),organization_id text NOT NULL REFERENCES gh_organizations(id),
 role text NOT NULL,token_hash text NOT NULL UNIQUE,created_by_person text NOT NULL REFERENCES gh_people(id),
 created_by_actor text NOT NULL,issuer_membership_version integer NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
 accepted_at timestamptz,accepted_by_person text REFERENCES gh_people(id),accept_request_id text,accept_request_hash text,private_acceptance text,
 CHECK(role IN ('owner','operator','investigator','viewer')),
 CHECK((accepted_at IS NULL AND accepted_by_person IS NULL AND accept_request_id IS NULL AND accept_request_hash IS NULL AND private_acceptance IS NULL)
 OR (accepted_at IS NOT NULL AND accepted_by_person IS NOT NULL AND accept_request_id IS NOT NULL AND accept_request_hash IS NOT NULL AND private_acceptance IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS gh_workspace_commands (
 access_id text NOT NULL REFERENCES gh_workspace_access_sessions(id),id text NOT NULL,kind text NOT NULL,
 request_hash text NOT NULL,private_result text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(access_id,id)
);
CREATE INDEX IF NOT EXISTS gh_workspace_invitation_tenant ON gh_workspace_invitations(tenant_id,created_at);
CREATE INDEX IF NOT EXISTS gh_actor_people_person ON gh_actor_people(person_id,tenant_id);
INSERT INTO gh_schema_version(version) VALUES(8) ON CONFLICT DO NOTHING;
`;
const pending=new WeakMap<Database,Promise<void>>();
export function ensureWorkspacesSchema(db:Database){
  let work=pending.get(db);
  if(!work){work=db.transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-workspaces-schema-v8'))");
    for(const statement of workspacesSchema.split(';').map(value=>value.trim()).filter(Boolean))await tx.query(statement);
  }).catch(error=>{pending.delete(db);throw error;});pending.set(db,work);}
  return work;
}
