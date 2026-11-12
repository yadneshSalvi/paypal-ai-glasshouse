import type {Database} from '@/packages/db/client';

export const instrumentSchemaVersion=11;
export async function ensureInstrumentSchema(db:Database){
  await db.transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-instruments-schema-v11'))");
    if(!(await tx.query('SELECT version FROM gh_schema_version WHERE version=10'))[0])throw new Error('Complete schema10 before instrument observations.');
    await tx.query(`CREATE TABLE IF NOT EXISTS gh_commerce_observations(
      tenant_id text NOT NULL,id text NOT NULL,order_id text NOT NULL,kind text NOT NULL,
      resource_id text NOT NULL,observed_at timestamptz NOT NULL,known_at timestamptz NOT NULL,
      observation_hash text NOT NULL,body jsonb NOT NULL,
      PRIMARY KEY(tenant_id,id),CHECK(kind IN ('line','capture','refund','shipment')))`);
    await tx.query('CREATE INDEX IF NOT EXISTS gh_commerce_resource_clocks ON gh_commerce_observations(tenant_id,kind,resource_id,known_at,observed_at)');
    await tx.query(`CREATE TABLE IF NOT EXISTS gh_instrument_source_selections(
      tenant_id text NOT NULL,actor_id text NOT NULL,membership_version integer NOT NULL,
      snapshot_hash text NOT NULL,context jsonb NOT NULL,follow_latest boolean NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,actor_id))`);
    await tx.query(`CREATE OR REPLACE FUNCTION gh_commerce_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Commerce source observations are append-only'; END $$`);
    await tx.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='gh_commerce_observations_immutable' AND tgrelid='gh_commerce_observations'::regclass) THEN CREATE TRIGGER gh_commerce_observations_immutable BEFORE UPDATE OR DELETE ON gh_commerce_observations FOR EACH ROW EXECUTE FUNCTION gh_commerce_immutable(); END IF; END $$`);
    await tx.query('INSERT INTO gh_schema_version(version) VALUES(11) ON CONFLICT DO NOTHING');
  });
}
