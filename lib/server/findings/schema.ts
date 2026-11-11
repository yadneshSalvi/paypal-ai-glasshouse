import type {Database} from '@/packages/db/client';
import {HttpError} from '../errors';

export const findingSchemaVersion=10;
const statements=[
`CREATE TABLE IF NOT EXISTS gh_findings (
 tenant_id text NOT NULL,id text NOT NULL,creator_id text NOT NULL,origin_document_id text,
 current_revision_id text NOT NULL,current_sequence integer NOT NULL CHECK(current_sequence>0),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,origin_document_id))`,
`CREATE TABLE IF NOT EXISTS gh_finding_revisions (
 tenant_id text NOT NULL,id text NOT NULL,finding_id text NOT NULL,sequence integer NOT NULL CHECK(sequence>0),
 previous_id text,revision_hash text NOT NULL,snapshot_hash text NOT NULL,cohort_version integer NOT NULL,
 actor_id text NOT NULL,state text NOT NULL,private_document text NOT NULL CHECK(private_document LIKE 'v1.%'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,finding_id,sequence),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES gh_findings(tenant_id,id),
 FOREIGN KEY(tenant_id,previous_id) REFERENCES gh_finding_revisions(tenant_id,id),
 CHECK(state IN ('proposed','supported_for_current_scope','challenged','revised','retracted')))`,
`CREATE TABLE IF NOT EXISTS gh_finding_events (
 tenant_id text NOT NULL,id text NOT NULL,finding_id text NOT NULL,revision_id text NOT NULL,event_type text NOT NULL,
 actor_id text NOT NULL,actor_role text NOT NULL,private_document text NOT NULL CHECK(private_document LIKE 'v1.%'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id) REFERENCES gh_finding_revisions(tenant_id,id))`,
`CREATE TABLE IF NOT EXISTS gh_finding_shares (
 tenant_id text NOT NULL,revision_id text NOT NULL,revision_hash text NOT NULL,shared_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,revision_id),
 FOREIGN KEY(tenant_id,revision_id) REFERENCES gh_finding_revisions(tenant_id,id))`,
`CREATE TABLE IF NOT EXISTS gh_finding_commands (
 tenant_id text NOT NULL,actor_id text NOT NULL,request_id text NOT NULL,request_hash text NOT NULL,
 revision_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,revision_id) REFERENCES gh_finding_revisions(tenant_id,id))`,
`CREATE TABLE IF NOT EXISTS gh_finding_source_changes (
 tenant_id text NOT NULL,id text NOT NULL,source_hash text NOT NULL,private_document text NOT NULL CHECK(private_document LIKE 'v1.%'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_hash))`,
`CREATE TABLE IF NOT EXISTS gh_plan_finding_dependencies (
 tenant_id text NOT NULL,plan_id text NOT NULL,finding_id text NOT NULL,revision_id text NOT NULL,revision_hash text NOT NULL,
 PRIMARY KEY(tenant_id,plan_id,finding_id),FOREIGN KEY(tenant_id,plan_id) REFERENCES gh_plans(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id) REFERENCES gh_finding_revisions(tenant_id,id))`,
`CREATE TABLE IF NOT EXISTS gh_plan_finding_authorities (
 tenant_id text NOT NULL,plan_id text NOT NULL,actor_id text NOT NULL,membership_version integer NOT NULL,
 private_document text NOT NULL CHECK(private_document LIKE 'v1.%'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,plan_id),FOREIGN KEY(tenant_id,plan_id) REFERENCES gh_plans(tenant_id,id))`,
`CREATE TABLE IF NOT EXISTS gh_plan_dependency_invalidations (
 tenant_id text NOT NULL,id text NOT NULL,plan_id text NOT NULL,finding_id text,revision_id text,source_change_id text,
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES gh_plans(tenant_id,id))`,
`CREATE INDEX IF NOT EXISTS gh_findings_creator ON gh_findings(tenant_id,creator_id,created_at DESC,id DESC)`,
`CREATE INDEX IF NOT EXISTS gh_finding_plan_revision ON gh_plan_finding_dependencies(tenant_id,revision_id)`,
`CREATE OR REPLACE FUNCTION gh_finding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Finding evidence is immutable; append a separately identified revision'; END $$`,
...['gh_finding_revisions','gh_finding_events','gh_finding_shares','gh_finding_commands','gh_finding_source_changes','gh_plan_finding_dependencies','gh_plan_finding_authorities','gh_plan_dependency_invalidations'].map(table=>`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='${table}_immutable' AND tgrelid='${table}'::regclass) THEN CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION gh_finding_immutable(); END IF; END $$`),
`INSERT INTO gh_schema_version(version) VALUES(10) ON CONFLICT DO NOTHING`,
];
export async function ensureFindingsSchema(db:Database){await db.transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-findings-schema-v10'))");
  if(!(await tx.query('SELECT version FROM gh_schema_version WHERE version=9'))[0])throw new Error('Complete schemas8/9 before the finding lifecycle migration.');
  for(const statement of statements)await tx.query(statement);
});}
const ready=new WeakSet<Database>();
export async function hasFindingsSchema(db:Database){if(ready.has(db))return true;const exists=!!(await db.query('SELECT version FROM gh_schema_version WHERE version=10'))[0];if(exists)ready.add(db);return exists;}
export async function requireFindingsSchema(db:Database){if(!await hasFindingsSchema(db))throw new HttpError(503,'FINDING_MIGRATION_REQUIRED','Finding review storage is being prepared. Earlier evidence and saved reports remain preserved.');}
