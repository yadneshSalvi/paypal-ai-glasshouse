import { createHash, randomUUID } from 'node:crypto';
import type { Actor, AuditEvent, SeedDataset, RecoveryPlan, Operation, Snapshot } from '@/packages/domain/types';
import { createSeedDataset } from '@/packages/domain';
import { database, type Database } from '@/packages/db/client';
import {assertWorkspaceContext,assertWorkspaceWritable} from './workspaces/authority';
import {validateCommerceFacts} from '@/packages/domain/commerce-resources';

export function hash(value: unknown): string {
  function canonical(input: unknown): string {
    if (Array.isArray(input)) return '[' + input.map(canonical).join(',') + ']';
    if (input && typeof input === 'object') return '{' + Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).filter(([, v]) => v !== undefined).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
    return JSON.stringify(input) ?? 'null';
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export async function audit(tx: Database, actor: Pick<Actor,'id'|'tenantId'>, type: string, summary: string, refId: string | null = null, data: Record<string, unknown> = {}) {
  const event: AuditEvent = { id: randomUUID(), tenantId: actor.tenantId, actorId: actor.id, timestamp: new Date().toISOString(), type, summary, refId, data };
  await tx.query('INSERT INTO gh_audit (tenant_id,id,timestamp,actor_id,event_type,body) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [event.tenantId,event.id,event.timestamp,event.actorId,event.type,JSON.stringify(event)]);
  return event;
}
export async function persistDataset(tx: Database, dataset: SeedDataset) {
  const previous=await tx.query<{body:SeedDataset}>('SELECT body FROM gh_datasets WHERE tenant_id=$1 FOR UPDATE',[dataset.tenantId]);
  if(dataset.commerceFacts?.length||previous[0]?.body.commerceFacts?.length){
    validateCommerceFacts(dataset);
    if(!(await tx.query('SELECT version FROM gh_schema_version WHERE version=11'))[0])throw new Error('Commerce observations require schema11.');
    const saved=await tx.query<{id:string;observation_hash:string}>('SELECT id,observation_hash FROM gh_commerce_observations WHERE tenant_id=$1',[dataset.tenantId]);
    const incoming=new Map((dataset.commerceFacts??[]).map(fact=>[fact.id,hash(fact)]));
    if(saved.some(fact=>incoming.get(fact.id)!==fact.observation_hash))throw new Error('Previously admitted commerce observations cannot be removed or changed.');
    await tx.query(`INSERT INTO gh_commerce_observations(tenant_id,id,order_id,kind,resource_id,observed_at,known_at,observation_hash,body)
      SELECT $1,e->>'id',e->>'orderId',e->>'kind',e->>'resourceId',(e->>'occurredAt')::timestamptz,(e->>'ingestedAt')::timestamptz,e->>'observationHash',e->'body'
      FROM jsonb_array_elements($2::jsonb) e ON CONFLICT(tenant_id,id) DO NOTHING`,[dataset.tenantId,JSON.stringify((dataset.commerceFacts??[]).map(fact=>({...fact,observationHash:hash(fact),body:fact})))]);
  }
  await tx.query(`INSERT INTO gh_datasets(tenant_id,revision,body) VALUES ($1,$2,$3::jsonb)
    ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,updated_at=now()`, [dataset.tenantId,dataset.revision,JSON.stringify(dataset)]);
  await tx.query(`INSERT INTO gh_source_events(tenant_id,id,order_id,occurred_at,ingested_at,source_class,body)
    SELECT $1,e->>'id',e->>'orderId',(e->>'occurredAt')::timestamptz,(e->>'ingestedAt')::timestamptz,e->>'sourceClass',e
    FROM jsonb_array_elements($2::jsonb) e ON CONFLICT(tenant_id,id) DO NOTHING`, [dataset.tenantId,JSON.stringify(dataset.events)]);
  await tx.query('DELETE FROM gh_state_intervals WHERE tenant_id=$1', [dataset.tenantId]);
  await tx.query(`INSERT INTO gh_state_intervals(tenant_id,id,order_id,dimension,state,valid_from,valid_to,knowledge_from,knowledge_to,clock_domain,source_class,source_event_id,revision)
    SELECT $1,e->>'id',e->>'orderId',e->>'dimension',e->>'state',(e->>'validFrom')::timestamptz,(e->>'validTo')::timestamptz,
    (e->>'knowledgeFrom')::timestamptz,(e->>'knowledgeTo')::timestamptz,e->>'clockDomain',e->>'sourceClass',e->>'sourceEventId',(e->>'revision')::int
    FROM jsonb_array_elements($2::jsonb) e`, [dataset.tenantId,JSON.stringify(dataset.intervals)]);
}
export async function datasetFor(actor: Actor, tx?: Database): Promise<SeedDataset> {
  const db = tx ?? await database();
  const rows = await db.query<{ body: SeedDataset }>('SELECT body FROM gh_datasets WHERE tenant_id=$1', [actor.tenantId]);
  if (rows[0]) return rows[0].body;
  const seed = createSeedDataset(actor.tenantId);
  const initialize = async (locked: Database) => {
    await assertWorkspaceContext(locked,actor,true);await assertWorkspaceWritable(locked,actor.tenantId);
    // The transaction advisory lock serializes simultaneous first requests for one session.
    await locked.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.tenantId]);
    const existing = await locked.query<{ body: SeedDataset }>('SELECT body FROM gh_datasets WHERE tenant_id=$1', [actor.tenantId]);
    if (existing[0]) return existing[0].body;
    await persistDataset(locked, seed);
    await audit(locked, actor, 'session.started', 'Fernwood investigation workspace created', null, { seedVersion: seed.version, source: 'sample' });
    return seed;
  };
  return tx ? initialize(tx) : db.transaction(initialize);
}
export async function saveSnapshot(snapshot: Snapshot) {
  const db = await database();
  await db.query('INSERT INTO gh_snapshots (tenant_id,id,hash,context,table_hashes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT DO NOTHING', [snapshot.context.tenantId,snapshot.id,snapshot.hash,JSON.stringify(snapshot.context),JSON.stringify(snapshot.tableHashes)]);
}
export async function plansFor(actor: Actor): Promise<RecoveryPlan[]> {
  const db = await database();
  return (await db.query<{body: RecoveryPlan}>('SELECT body FROM gh_plans WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100', [actor.tenantId])).map(row=>row.body);
}
export async function operationsFor(actor: Actor, planId?: string): Promise<Operation[]> {
  const db = await database();
  const rows = await db.query<{body: Operation}>(`SELECT body FROM gh_operations WHERE tenant_id=$1${planId ? ' AND plan_id=$2' : ''} ORDER BY updated_at DESC LIMIT 1000`, planId ? [actor.tenantId,planId] : [actor.tenantId]);
  return rows.map(row=>row.body);
}
export async function auditFor(actor: Actor, after = 0): Promise<(AuditEvent & {sequence: number})[]> {
  const db = await database();
  return (await db.query<{body: AuditEvent; sequence: string}>('SELECT body,sequence FROM gh_audit WHERE tenant_id=$1 AND sequence>$2 ORDER BY sequence DESC LIMIT 150', [actor.tenantId,after])).map(row=>({...row.body,sequence:Number(row.sequence)}));
}
export async function storePlan(tx: Database, plan: RecoveryPlan) {
  await tx.query(`INSERT INTO gh_plans(tenant_id,id,version,status,plan_hash,cohort_version,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT(tenant_id,id) DO UPDATE SET version=excluded.version,status=excluded.status,body=excluded.body`, [plan.tenantId,plan.id,plan.version,plan.status,plan.hash,plan.cohortVersion,JSON.stringify(plan)]);
}
