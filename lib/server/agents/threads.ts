import type {AgAiThread,AgAiChatMessage,AgAiChatMessagePart} from 'ag-studio';
import type {Actor} from '@/packages/domain/types';
import type {Database} from '@/packages/db/client';
import {HttpError} from '../errors';
import {hash} from '../repository';
import {AgentJournal,type RunRow} from './journal';
import {agentMember,bounded,safeId,type AgentSecrets} from './security';

interface Envelope {format:'glasshouse-encrypted-agent-v1';ciphertext:string}
const envelope=(value:unknown):value is Envelope=>!!value&&typeof value==='object'&&(value as Envelope).format==='glasshouse-encrypted-agent-v1'&&typeof (value as Envelope).ciphertext==='string';
function clean(thread:AgAiThread):AgAiThread {
  if(!thread?.summary||!Array.isArray(thread.messages)||thread.messages.length>3000)throw new HttpError(400,'AGENT_THREAD_INVALID','A complete native conversation is required.');
  safeId(thread.summary.threadId,'thread');
  // Native visible history carries no private reasoning continuation, even if a
  // future renderer starts supporting reasoning message parts.
  return {...thread,messages:thread.messages.map((message:AgAiChatMessage)=>({...message,parts:message.parts.filter((part:AgAiChatMessagePart)=>part.type!=='reasoning')}))};
}
export class AgentThreads {
  constructor(readonly journal:AgentJournal){}
  private decode(tenant:string,id:string,body:unknown){
    if(!envelope(body))throw new HttpError(503,'AGENT_LEGACY_ENCRYPTION_REQUIRED','The saved conversation is preserved. Its private storage migration must finish before it can be opened.');
    return clean(this.journal.secrets.open<AgAiThread>(tenant,'thread',id,body.ciphertext));
  }
  async list(actor:Actor){return this.journal.db.transaction(async tx=>{
    await agentMember(tx,actor);
    const rows=await tx.query<{id:string;body:unknown}>('SELECT id,body FROM gh_threads WHERE tenant_id=$1 AND (actor_id=$2 OR actor_id IS NULL) ORDER BY updated_at DESC LIMIT 150',[actor.tenantId,actor.id]);
    return rows.map(row=>this.decode(actor.tenantId,row.id,row.body).summary);
  });}
  async load(actor:Actor,id:string){return this.journal.db.transaction(async tx=>{
    await agentMember(tx,actor);
    const row=(await tx.query<{body:unknown;version:number}>('SELECT body,version FROM gh_threads WHERE tenant_id=$1 AND id=$2 AND (actor_id=$3 OR actor_id IS NULL)',[actor.tenantId,safeId(id,'thread'),actor.id]))[0];
    return {thread:row?this.decode(actor.tenantId,id,row.body):null,version:row?.version??0};
  });}
  async save(actor:Actor,id:string,input:{thread:AgAiThread;expectedVersion:number}){
    bounded(input,2000000,'This conversation exceeds the saved history limit.');const thread=clean(input.thread);
    if(id!==thread.summary.threadId||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)throw new HttpError(409,'AGENT_THREAD_VERSION','Reload the saved investigation before replacing its history.');
    return this.journal.db.transaction(async tx=>{
      await agentMember(tx,actor,actor.membershipVersion,true);await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`agent-thread-save:${actor.tenantId}:${id}`]);
      const row=(await tx.query<{body:unknown;version:number;actor_id:string|null}>('SELECT body,version,actor_id FROM gh_threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,id]))[0];
      if(row?.actor_id&&row.actor_id!==actor.id)throw new HttpError(403,'AGENT_THREAD_OWNER','This conversation belongs to another workspace member.');
      if(thread.summary.parentThreadId){
        const child=(await tx.query<RunRow>('SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND thread_id=$2 AND actor_id=$3',[actor.tenantId,id,actor.id]))[0];
        const parent=child?.parent_run_id?await this.journal.run(tx,actor,child.parent_run_id):null;
        if(!parent||parent.thread_id!==thread.summary.parentThreadId||thread.summary.agentId!==child.agent_id)throw new HttpError(403,'AGENT_THREAD_LINEAGE','This transcript does not match a recorded native child session.');
      }else if(thread.summary.agentId!=='coordinator')throw new HttpError(403,'AGENT_THREAD_AGENT','Only the Coordinator owns user investigation threads.');
      if(row){
        const previous=this.decode(actor.tenantId,id,row.body);
        if(row.version===input.expectedVersion+1&&hash(previous)===hash(thread)||row.version===input.expectedVersion&&hash(previous)===hash(thread))return {saved:true,version:row.version,replayed:true};
      }
      if((row?.version??0)!==input.expectedVersion)throw new HttpError(409,'AGENT_THREAD_CHANGED','A newer native transcript is already saved. This tab cannot overwrite it.');
      const version=(row?.version??0)+1,body:Envelope={format:'glasshouse-encrypted-agent-v1',ciphertext:this.journal.secrets.seal(actor.tenantId,'thread',id,thread)};
      await tx.query('INSERT INTO gh_threads(tenant_id,id,body,version,actor_id) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(tenant_id,id) DO UPDATE SET body=excluded.body,version=excluded.version,actor_id=excluded.actor_id,updated_at=now()',[actor.tenantId,id,JSON.stringify(body),version,actor.id]);
      return {saved:true,version,replayed:false};
    });
  }
  async remove(actor:Actor,id:string){return this.journal.db.transaction(async tx=>{await agentMember(tx,actor,actor.membershipVersion,true);const active=await tx.query("SELECT id FROM gh_agent_runs WHERE tenant_id=$1 AND thread_id=$2 AND state='running'",[actor.tenantId,id]);if(active.length)throw new HttpError(409,'AGENT_THREAD_ACTIVE','Stop the active investigation before removing its visible transcript.');await tx.query('DELETE FROM gh_threads WHERE tenant_id=$1 AND id=$2 AND (actor_id=$3 OR actor_id IS NULL)',[actor.tenantId,id,actor.id]);return {deleted:true,evidenceRetained:true};});}
}

/** Explicit root-owned migration. Verify ciphertext before replacing plaintext in
 * the same transaction. It never imports a provider or touches financial tables. */
export async function encryptLegacyAgentDocuments(db:Database,secrets:AgentSecrets){
  return db.transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('glasshouse-agent-private-migration-v1'))");
    const counts={threads:0,modelItems:0};
    for(const table of ['gh_threads','gh_model_items'] as const){
      const rows=await tx.query<{tenant_id:string;id:string;body:unknown}>(`SELECT tenant_id,id,body FROM ${table} FOR UPDATE`);
      for(const row of rows){
        if(envelope(row.body))continue;
        const kind=table==='gh_threads'?'thread':'legacy-model-item';
        const cipher=secrets.seal(row.tenant_id,kind,row.id,row.body);
        if(hash(secrets.open(row.tenant_id,kind,row.id,cipher))!==hash(row.body))throw new Error('Legacy agent encryption verification failed.');
        await tx.query(`UPDATE ${table} SET body=$3::jsonb WHERE tenant_id=$1 AND id=$2`,[row.tenant_id,row.id,JSON.stringify({format:'glasshouse-encrypted-agent-v1',ciphertext:cipher})]);
        if(table==='gh_threads')counts.threads++;else counts.modelItems++;
      }
      // Fence old deployments too: after the explicit cutover no stale writer
      // may reintroduce plaintext history or private reasoning continuations.
      const constraint=`${table}_agent_envelope_v1`;
      const present=await tx.query('SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid=$2::regclass',[constraint,table]);
      if(!present.length)await tx.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (jsonb_typeof(body)='object' AND body ? 'format' AND body ? 'ciphertext' AND body->>'format'='glasshouse-encrypted-agent-v1' AND jsonb_typeof(body->'ciphertext')='string')`);
    }
    return counts;
  });
}
