import type {Actor,Role} from '@/packages/domain/types';
import type {Database} from '@/packages/db/client';
import {HttpError} from '../errors';

const contextKey=Symbol.for('glasshouse.workspace-request-context');
export interface WorkspaceRequestContext {accessId:string;contextId:string;sessionHash:string;tenantId:string;actorId:string;membershipVersion:number;role:Role}
type ScopedActor=Actor&{[contextKey]?:WorkspaceRequestContext};
export function withWorkspaceContext<T extends Actor>(actor:T,context:Pick<WorkspaceRequestContext,'accessId'|'contextId'|'sessionHash'>&Partial<WorkspaceRequestContext>):T{
  // Symbol keys survive object spreads but are never serialized into a public
  // actor or model prompt. Durable agents separately bind their exact hash.
  return Object.assign(actor,{[contextKey]:{tenantId:actor.tenantId,actorId:actor.id,membershipVersion:actor.membershipVersion,role:actor.role,...context}});
}
export function workspaceContext(actor:Actor){return (actor as ScopedActor)[contextKey];}
const schemaReady=new WeakSet<Database>();
export async function workspaceTablesExist(tx:Database){if(schemaReady.has(tx))return true;const present=!!(await tx.query<{present:boolean}>("SELECT to_regclass('gh_workspace_session_links') IS NOT NULL AS present"))[0]?.present;if(present)schemaReady.add(tx);return present;}
export async function requireWorkspaceSchema(tx:Database){if(!await workspaceTablesExist(tx))throw new HttpError(503,'WORKSPACE_MIGRATION_REQUIRED','The workspace directory is being prepared. Existing saved work is preserved.');}
export async function assertWorkspaceWritable(tx:Database,tenantId:string){
  if(!await workspaceTablesExist(tx))return;
  const row=(await tx.query<{status:string}>('SELECT status FROM gh_workspaces WHERE tenant_id=$1 FOR SHARE',[tenantId]))[0];
  if(row?.status==='archived')throw new HttpError(409,'WORKSPACE_ARCHIVED','This workspace is archived. Its saved evidence remains readable; restore it before making changes.');
}
/** User-initiated workspace changes are distinct from preserving a previously
 * dispatched provider receipt. Read-only jobs still validate their own grants. */
export async function assertWorkspaceRequestWrite(tx:Database,actor:Actor){
  await assertWorkspaceContext(tx,actor,true);await assertWorkspaceWritable(tx,actor.tenantId);
  if(actor.role==='viewer')throw new HttpError(403,'WORKSPACE_READ_ONLY','This workspace role can read saved evidence but cannot start or change workspace work.');
}
export async function assertWorkspaceContext(tx:Database,actor:Actor,write=false){
  const expected=workspaceContext(actor);
  if(!expected)return; // Explicitly admitted legacy sessions keep their old contract.
  const row=(await tx.query<{context_id:string;current_session_hash:string;tenant_id:string;actor_id:string;status:string|null}>(`
    SELECT a.context_id,a.current_session_hash,l.tenant_id,l.actor_id,w.status
    FROM gh_workspace_access_sessions a JOIN gh_workspace_session_links l ON l.access_id=a.id AND l.session_hash=$2
    JOIN gh_sessions s ON s.token_hash=l.session_hash AND s.expires_at>now()
    LEFT JOIN gh_workspaces w ON w.tenant_id=l.tenant_id
    WHERE a.id=$1 AND a.active=true AND a.expires_at>now() FOR SHARE OF a,l,s`,[expected.accessId,expected.sessionHash]))[0];
  if(!row||row.context_id!==expected.contextId||row.current_session_hash!==expected.sessionHash||row.tenant_id!==expected.tenantId||row.actor_id!==expected.actorId||actor.tenantId!==expected.tenantId)throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','This tab belongs to an earlier workspace context. Choose the current workspace before continuing.');
  if(write)await assertWorkspaceWritable(tx,actor.tenantId);
  // A server-side approval check may inspect another actor in this same tenant.
  // Keep the original requesting membership separate and current throughout.
  const member=(await tx.query<{role:Role;version:number;active:boolean}>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE',[expected.tenantId,expected.actorId]))[0];
  if(!member?.active||member.version!==expected.membershipVersion||member.role!==expected.role)throw new HttpError(403,'CURRENT_AUTHORITY_REQUIRED','The membership that authorized this request changed. Its saved work remains preserved.');
}
export async function sessionWorkspaceContext(tx:Database,actor:Actor,sessionHash:string,expectedContext?:string,allowBootstrap=false,write=false){
  if(!await workspaceTablesExist(tx))return actor;
  const link=(await tx.query<{access_id:string;context_id:string}>(`SELECT l.access_id,a.context_id FROM gh_workspace_session_links l
    JOIN gh_workspace_access_sessions a ON a.id=l.access_id WHERE l.session_hash=$1`,[sessionHash]))[0];
  if(!link)return actor;
  if(!allowBootstrap&&expectedContext!==link.context_id)throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','This tab has not admitted the current workspace. Open its current directory before continuing.');
  const scoped=withWorkspaceContext(actor,{accessId:link.access_id,contextId:allowBootstrap?link.context_id:expectedContext!,sessionHash});
  await assertWorkspaceContext(tx,scoped,write);return scoped;
}
export async function workspaceProviderAvailable(tx:Database,tenantId:string){
  if(!await workspaceTablesExist(tx))return true;
  const row=(await tx.query<{source_kind:string}>('SELECT source_kind FROM gh_workspaces WHERE tenant_id=$1',[tenantId]))[0];
  return row?.source_kind!=='sample';
}
export async function assertWorkspaceProviderScope(tx:Database,tenantId:string){
  if(!await workspaceProviderAvailable(tx,tenantId))throw new HttpError(403,'WORKSPACE_CONNECTOR_REQUIRED','This Sample workspace has no qualified merchant connection. Creating a workspace does not grant access to the existing PayPal account.');
}
/** A saved agent request has no browser-supplied context. Its original session
 * must still be the active one in its admitted access family. */
export async function assertAgentWorkspaceContext(tx:Database,actor:Actor,sessionHash:string,write=false){
  if(!await workspaceTablesExist(tx))return;
  const row=(await tx.query<{context_id:string;access_id:string}>(`
    SELECT a.context_id,l.access_id FROM gh_workspace_session_links l
    JOIN gh_workspace_access_sessions a ON a.id=l.access_id WHERE l.session_hash=$1`,[sessionHash]))[0];
  if(row)await assertWorkspaceContext(tx,withWorkspaceContext({...actor},{accessId:row.access_id,contextId:row.context_id,sessionHash}),write);
  if(write)await assertWorkspaceWritable(tx,actor.tenantId);
}
