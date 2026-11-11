import type {Database} from '@/packages/db/client';
import {HttpError} from '../errors';

const statements=[
`CREATE TABLE IF NOT EXISTS gh_report_editions (
 tenant_id text NOT NULL,id text NOT NULL,created_by text NOT NULL,membership_version integer NOT NULL,
 request_id text NOT NULL,request_hash text NOT NULL,document_hash text NOT NULL,snapshot_hash text NOT NULL,
 layout_version integer NOT NULL,layout_hash text NOT NULL,parent_id text,
 private_document text NOT NULL CHECK(private_document LIKE 'v1.%'),private_summary text NOT NULL CHECK(private_summary LIKE 'v1.%'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,created_by,request_id),
 FOREIGN KEY(tenant_id,parent_id) REFERENCES gh_report_editions(tenant_id,id),CHECK(layout_version>0))`,
`CREATE INDEX IF NOT EXISTS gh_reports_directory ON gh_report_editions(tenant_id,created_at DESC,id DESC)`,
`CREATE OR REPLACE FUNCTION gh_report_editions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Saved report editions are immutable; create a separately identified edition'; END $$`,
`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='gh_report_editions_immutable' AND tgrelid='gh_report_editions'::regclass) THEN
 CREATE TRIGGER gh_report_editions_immutable BEFORE UPDATE OR DELETE ON gh_report_editions FOR EACH ROW EXECUTE FUNCTION gh_report_editions_immutable(); END IF; END $$`,
`CREATE TABLE IF NOT EXISTS gh_report_pdf (
 tenant_id text NOT NULL,report_id text NOT NULL,paper text NOT NULL CHECK(paper IN ('A4','LETTER')),renderer_version text NOT NULL,
 state text NOT NULL CHECK(state IN ('rendering','ready','failed')),lease_id text,lease_until timestamptz,attempts integer NOT NULL DEFAULT 1,
 private_bytes text CHECK(private_bytes IS NULL OR private_bytes LIKE 'v1.%'),byte_hash text,page_count integer,reason_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,report_id,paper,renderer_version),
 FOREIGN KEY(tenant_id,report_id) REFERENCES gh_report_editions(tenant_id,id),
 CHECK(state<>'ready' OR (private_bytes IS NOT NULL AND byte_hash IS NOT NULL AND page_count>0)))`,
`INSERT INTO gh_schema_version(version) VALUES(9) ON CONFLICT DO NOTHING`,
];
export async function ensureReportsSchema(db:Database){await db.transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-reports-schema-v9'))");
  if(!(await tx.query('SELECT version FROM gh_schema_version WHERE version=8'))[0])throw new Error('Complete the schema8 workspace migration before report editions.');
  for(const sql of statements)await tx.query(sql);
});}
const ready=new WeakSet<Database>();
export async function requireReportsSchema(db:Database){if(ready.has(db))return;if(!(await db.query('SELECT version FROM gh_schema_version WHERE version=9'))[0])throw new HttpError(503,'REPORT_MIGRATION_REQUIRED','Private report storage is being prepared. Your saved investigation is preserved.');ready.add(db);}
