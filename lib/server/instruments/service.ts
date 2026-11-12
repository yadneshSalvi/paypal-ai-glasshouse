import type {Actor,CommerceFact,QueryContext,RecoveryPlan} from '@/packages/domain/types';
import {buildSnapshot} from '@/packages/domain';
import {validateCommerceFacts} from '@/packages/domain/commerce-resources';
import {database,type Database} from '@/packages/db/client';
import {audit,datasetFor,persistDataset,storePlan,hash} from '../repository';
import {HttpError} from '../errors';
import {assertWorkspaceContext,assertWorkspaceRequestWrite} from '../workspaces/authority';
import {recoveryMember} from '../recovery/authority';
import {requireRole} from '../auth';
import {recordFindingSourceChange} from '../findings/sources';
import {snapshotContext} from '../snapshots';

async function ready(tx:Database){if(!(await tx.query('SELECT version FROM gh_schema_version WHERE version=11'))[0])throw new HttpError(503,'INSTRUMENT_MIGRATION_REQUIRED','Source selection and resource observations need the additive instrument migration.');}
async function writer(tx:Database,actor:Actor){await assertWorkspaceRequestWrite(tx,actor);const current=await recoveryMember(tx,actor);requireRole(current,['owner','operator','judge','investigator']);await ready(tx);}

/** A per-member source preference is independent of native layout/undo history.
 * Authority is always re-derived on read; this preference can never grant access. */
export async function sourceSelection(actor:Actor,db?:Database):Promise<{search:URLSearchParams;followLatest:boolean}|null>{
  const tx=db??await database();await assertWorkspaceContext(tx,actor);
  if(!(await tx.query('SELECT version FROM gh_schema_version WHERE version=11'))[0])return null;
  const row=(await tx.query<{context:QueryContext;follow_latest:boolean;membership_version:number}>('SELECT context,follow_latest,membership_version FROM gh_instrument_source_selections WHERE tenant_id=$1 AND actor_id=$2',[actor.tenantId,actor.id]))[0];
  if(!row||row.membership_version!==actor.membershipVersion||row.context.tenantId!==actor.tenantId||row.context.roleScope!==actor.role)return null;
  const search=new URLSearchParams({asOf:row.context.asOf,clock:row.context.clockDomain,currency:row.context.currency});
  if(!row.follow_latest)search.set('knownAt',row.context.knownAt);
  return {search,followLatest:row.follow_latest};
}
export async function saveSourceSelection(actor:Actor,input:{snapshotHash?:unknown;followLatest?:unknown}){
  if(typeof input.snapshotHash!=='string'||!/^[a-f0-9]{64}$/.test(input.snapshotHash)||typeof input.followLatest!=='boolean')throw new HttpError(400,'INVALID_SOURCE_SELECTION','Choose an admitted snapshot and whether knowledge follows new sources.');
  const db=await database();return db.transaction(async tx=>{
    await writer(tx,actor);
    const row=(await tx.query<{context:QueryContext}>('SELECT context FROM gh_snapshots WHERE tenant_id=$1 AND hash=$2',[actor.tenantId,input.snapshotHash]))[0];
    if(!row||row.context.roleScope!==actor.role||row.context.rolePolicyVersion!==`roles-v1:${actor.membershipVersion}`)throw new HttpError(409,'SOURCE_SELECTION_CHANGED','This source selection is not admitted under the current membership.');
    const snapshot=buildSnapshot(await datasetFor(actor,tx),row.context);
    if(snapshot.hash!==input.snapshotHash)throw new HttpError(409,'SOURCE_SELECTION_CHANGED','The source selection no longer reconstructs exactly. Open a new snapshot before saving it.');
    await tx.query(`INSERT INTO gh_instrument_source_selections(tenant_id,actor_id,membership_version,snapshot_hash,context,follow_latest)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,actor_id) DO UPDATE SET membership_version=excluded.membership_version,
      snapshot_hash=excluded.snapshot_hash,context=excluded.context,follow_latest=excluded.follow_latest,updated_at=now()`,[actor.tenantId,actor.id,actor.membershipVersion,snapshot.hash,JSON.stringify(snapshot.context),input.followLatest]);
    return {snapshotHash:snapshot.hash,followLatest:input.followLatest};
  });
}

/** Authored sample resources use the same persisted, append-only representation as
 * trusted ingestion. This endpoint cannot claim a sandbox provider observation. */
export async function appendSampleCommerce(actor:Actor,raw:unknown){
  if(!Array.isArray(raw)||!raw.length||raw.length>2000)throw new HttpError(400,'INVALID_COMMERCE_OBSERVATIONS','Submit 1–2,000 explicitly Sample resource observations.');
  const db=await database();return db.transaction(async tx=>{
    await writer(tx,actor);await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[actor.tenantId]);
    const dataset=await datasetFor(actor,tx),now=new Date().toISOString();
    const existing=new Map((dataset.commerceFacts??[]).map(fact=>[fact.id,fact]));
    const incoming=raw.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'INVALID_COMMERCE_OBSERVATION','Every source observation must be an object.');
      const fact=value as CommerceFact,order=dataset.orders.find(order=>order.id===fact.orderId);
      if(!order||fact.tenantId!==actor.tenantId)throw new HttpError(404,'COMMERCE_ORDER_NOT_FOUND','A source observation refers to an order outside this workspace.');
      if(fact.sourceClass!=='sample'||typeof fact.id!=='string'||typeof fact.resourceId!=='string'||fact.id.length>200||fact.resourceId.length>200||typeof fact.state!=='string'||fact.state.length>60||typeof fact.sourceRef!=='string'||fact.sourceRef.length>1000||!fact.id.startsWith('sample:')||!fact.resourceId.startsWith('sample:')||fact.parentResourceId!==null&&(typeof fact.parentResourceId!=='string'||!fact.parentResourceId.startsWith('sample:')))throw new HttpError(400,'SAMPLE_SOURCE_REQUIRED','Authored resource facts need Sample provenance and sample-prefixed identities. Provider facts require verified ingestion.');
      if(dataset.events.some(event=>event.orderId===fact.orderId&&event.sourceClass==='sandbox')&&(fact.kind==='capture'||fact.kind==='refund'))throw new HttpError(409,'PROVIDER_RESOURCE_PROTECTED','A Sample fact cannot replace verified provider payment or refund resources.');
      // Retries retain their original clocks. A new authored fact receives knowledge
      // time now, so it cannot rewrite what an older immutable edition knew.
      const prior=existing.get(fact.id);return {...fact,ingestedAt:prior?.ingestedAt??now,revision:prior?.revision??dataset.revision+1};
    });
    const merged=new Map(existing);for(const fact of incoming){const old=merged.get(fact.id);if(old&&hash(old)!==hash(fact))throw new HttpError(409,'COMMERCE_OBSERVATION_IMMUTABLE','An observation identity cannot be changed. Append a new knowledge revision.');merged.set(fact.id,fact);}
    const next={...dataset,commerceFacts:[...merged.values()],revision:incoming.some(fact=>!existing.has(fact.id))?dataset.revision+1:dataset.revision};
    try{validateCommerceFacts(next);buildSnapshot(next,snapshotContext(actor,next));}catch(error){throw new HttpError(400,'INVALID_COMMERCE_OBSERVATIONS',error instanceof Error?error.message:'The resource ledger is inconsistent.');}
    await persistDataset(tx,next);
    const changed=next.revision!==dataset.revision;
    if(changed){
      await recordFindingSourceChange(tx,actor,dataset,next,{kind:'commerce_resources',reason:'Resource observations changed. Review the factual scope and any proposed actions.',sourceId:'commerce:'+next.revision});
      for(const {body:plan} of await tx.query<{body:RecoveryPlan}>("SELECT body FROM gh_plans WHERE tenant_id=$1 AND status IN ('draft','ready_for_review','approved') FOR UPDATE",[actor.tenantId]))await storePlan(tx,{...plan,status:'stale',staleReason:'Resource observations changed. Review a current exact source snapshot.'});
      await audit(tx,actor,'source.sample_resources_appended',`${incoming.length} Sample resource observations admitted`,null,{revision:next.revision,observationIds:incoming.map(fact=>fact.id),source:'sample'});
    }
    return {revision:next.revision,observations:incoming,alreadyPresent:!changed};
  });
}
