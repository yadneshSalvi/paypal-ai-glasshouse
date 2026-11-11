import type {Actor} from '@/packages/domain/types';
import type {Database} from '@/packages/db/client';
import {HttpError} from './errors';
import {audit,hash} from './repository';
import {recoveryMember} from './recovery/authority';
import type {AgentLayoutReceipt} from '@/packages/agents/contracts';

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
/** Transport shape checks complement the registered native schema admission.
 * Unknown widget settings are preserved, never normalized into a new document. */
export function validateHistory(value:unknown){
  const fail=()=>{throw new HttpError(400,'INVALID_LAYOUT','Save a complete native report with its current page and both history stacks.');};
  if(!object(value)||value.type!=='AgReportHistory'||!Array.isArray(value.undo)||!Array.isArray(value.redo))return fail();
  const states=[value.current];const ids=new Set<string>();
  for(const entry of [...value.undo,...value.redo]){
    if(!object(entry)||typeof entry.id!=='string'||!entry.id||ids.has(entry.id)||!Number.isFinite(entry.at)||!object(entry.source))return fail();
    ids.add(entry.id);states.push(entry.state);
  }
  if(states.length>501)throw new HttpError(413,'LAYOUT_HISTORY_LIMIT','This report exceeds the 500-entry history limit. Your existing saved report is unchanged.');
  for(const state of states){
    if(!object(state)||!Array.isArray(state.pages)||state.pages.length===0||state.pages.length>50||typeof state.selectedPageId!=='string')return fail();
    const pages=new Set<string>();
    for(const page of state.pages){
      if(!object(page)||typeof page.id!=='string'||!page.id||pages.has(page.id))return fail();pages.add(page.id);
      if(page.widgets!==undefined){if(!object(page.widgets)||Object.keys(page.widgets).length>200)return fail();for(const widget of Object.values(page.widgets))if(widget!==null&&widget!==undefined&&(!object(widget)||typeof widget.type!=='string'))return fail();}
    }
    if(!pages.has(state.selectedPageId))return fail();
  }
  return value;
}
export async function readLayout(db:Database,actor:Actor){
  await recoveryMember(db,actor);
  const row=(await db.query<{body:unknown;version:number}>('SELECT body,version FROM gh_layouts WHERE tenant_id=$1 AND id=$2',[actor.tenantId,'incident-room']))[0];
  return {history:row?.body??null,version:row?.version??0};
}
export async function saveLayout(db:Database,actor:Actor,input:{history:unknown;expectedVersion:number;label?:string;agentMutation?:AgentLayoutReceipt},commitAgent?:(tx:Database,actor:Actor,receipt:AgentLayoutReceipt,history:unknown,version:number,previous:{body:unknown;version:number})=>Promise<void>){
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)throw new HttpError(409,'LAYOUT_VERSION_REQUIRED','Reload the saved investigation before saving changes from this tab.');
  const history=validateHistory(input.history),digest=hash(history);
  if(input.agentMutation&&!commitAgent)throw new HttpError(409,'AGENT_LAYOUT_JOURNAL_REQUIRED','An agent workspace change requires its durable tool journal.');
  return db.transaction(async tx=>{
    await tx.query('SELECT actor_id FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE',[actor.tenantId,actor.id]);
    const member=await recoveryMember(tx,actor);
    if(member.role==='viewer')throw new HttpError(403,'LAYOUT_READ_ONLY','This workspace role can read reports but cannot change their saved history.');
    await tx.query("INSERT INTO gh_layouts(tenant_id,id,body,version) VALUES($1,$2,'null'::jsonb,0) ON CONFLICT DO NOTHING",[actor.tenantId,'incident-room']);
    const row=(await tx.query<{body:unknown;version:number}>('SELECT body,version FROM gh_layouts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,'incident-room']))[0];
    // A repeated exact save can recover a response loss, but cannot overwrite a later edit.
    const acknowledge=async(version:number)=>{if(input.agentMutation)await commitAgent!(tx,actor,input.agentMutation,history,version,row);};
    if(row.version===input.expectedVersion+1&&hash(row.body)===digest){await acknowledge(row.version);return {saved:true,version:row.version,replayed:true};}
    if(row.version!==input.expectedVersion)throw new HttpError(409,'LAYOUT_CHANGED','Another tab saved a newer investigation. Your local edits are held; export them or reload the saved workspace.');
    if(hash(row.body)===digest){await acknowledge(row.version);return {saved:true,version:row.version,replayed:true};}
    const version=row.version+1;
    await acknowledge(version);
    await tx.query('UPDATE gh_layouts SET body=$3::jsonb,version=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2',[actor.tenantId,'incident-room',JSON.stringify(history),version]);
    await audit(tx,actor,'layout.saved',typeof input.label==='string'?input.label.slice(0,100):'Investigation layout saved','incident-room',{historyHash:digest,version});
    return {saved:true,version,replayed:false};
  });
}
