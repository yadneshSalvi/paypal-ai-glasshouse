import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Actor, Role } from '@/packages/domain/types';
import { database,type Database } from '@/packages/db/client';
import { HttpError, sameOrigin } from './errors';
import { ensurePaymentsSchema } from './payments/schema';
import {assertWorkspaceContext,assertWorkspaceRequestWrite,requireWorkspaceSchema,sessionWorkspaceContext,workspaceContext} from './workspaces/authority';

const COOKIE = process.env.GLASSHOUSE_SESSION_COOKIE&&/^[a-z][a-z0-9_]{0,60}$/.test(process.env.GLASSHOUSE_SESSION_COOKIE)?process.env.GLASSHOUSE_SESSION_COOKIE:'glasshouse_session';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const requestAuthority=new WeakMap<Request,{actor:Actor;sessionHash:string}>();
export function requestSessionToken(request:Request){return request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);}
export function sessionCookie(request:Request,token:string,expiresAt:string){
  const seconds=Math.max(0,Math.floor((Date.parse(expiresAt)-Date.now())/1000));
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
/** Agent jobs retain the exact authenticated session hash, never the cookie token. */
export function authenticatedSessionHash(request:Request){
  const token=requestSessionToken(request);
  if(!token||!/^[a-f0-9]{64}$/.test(token))throw new HttpError(401,'SESSION_REQUIRED','Start an investigation session to continue.');
  return digest(token);
}
async function assertSession(tx:Database,value:Actor,sessionHash:string){
  const row=(await tx.query("SELECT token_hash FROM gh_sessions WHERE token_hash=$1 AND actor->>'tenantId'=$2 AND actor->>'id'=$3 AND expires_at>now() FOR SHARE",[sessionHash,value.tenantId,value.id]))[0];
  if(!row)throw new HttpError(401,'SESSION_EXPIRED','This browser access expired. Saved work remains preserved; a new access invitation can restore access.');
  const member=(await tx.query<{role:Role;version:number;active:boolean}>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE',[value.tenantId,value.id]))[0];
  if(!member?.active||member.role!==value.role||member.version!==value.membershipVersion)throw new HttpError(403,'CURRENT_AUTHORITY_REQUIRED','Workspace access changed while this request was running. Reopen the current workspace.');
}
function remember(request:Request,value:Actor,sessionHash:string,bootstrap=false){
  const previous=requestAuthority.get(request);
  if(previous&&(previous.sessionHash!==sessionHash||previous.actor.id!==value.id||previous.actor.tenantId!==value.tenantId||previous.actor.role!==value.role||previous.actor.membershipVersion!==value.membershipVersion||!bootstrap&&workspaceContext(previous.actor)?.contextId!==workspaceContext(value)?.contextId))throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','The original request context changed. Its saved work remains preserved.');
  requestAuthority.set(request,{actor:value,sessionHash});
}
export async function actor(request: Request,options:{allowWorkspaceBootstrap?:boolean}={}): Promise<Actor> {
  const token = requestSessionToken(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'SESSION_REQUIRED', 'Start an investigation session to continue.');
  const db = await database();
  await requireWorkspaceSchema(db);
  const rows = await db.query<{ actor: Actor }>('SELECT actor FROM gh_sessions WHERE token_hash=$1 AND expires_at > now()', [digest(token)]);
  if (!rows[0]) throw new HttpError(401, 'SESSION_EXPIRED', 'This browser access expired. Saved work remains preserved; use an access invitation or explicitly start a new Sample workspace.');
  const saved = rows[0].actor;
  await ensurePaymentsSchema(db);
  // Only a valid server-issued session may bootstrap membership. Existing revocations win.
  await db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [saved.tenantId,saved.id,saved.role,saved.membershipVersion]);
  const members = await db.query<{role: Role; version: number; active: boolean}>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2', [saved.tenantId,saved.id]);
  if (!members[0]?.active) throw new HttpError(403, 'MEMBERSHIP_REVOKED', 'This workspace membership is no longer active.');
  const current={...saved,role:members[0].role,membershipVersion:members[0].version},sessionHash=digest(token),expectedContext=request.headers.get('X-Glasshouse-Context')??new URL(request.url).searchParams.get('workspaceContext')??undefined;
  const value=await db.transaction(async tx=>{
    const scoped=await sessionWorkspaceContext(tx,current,sessionHash,expectedContext,options.allowWorkspaceBootstrap===true,request.method!=='GET'&&!options.allowWorkspaceBootstrap);
    if(request.method!=='GET'&&!options.allowWorkspaceBootstrap)await assertWorkspaceRequestWrite(tx,scoped);
    await assertSession(tx,scoped,sessionHash);return scoped;
  });
  remember(request,value,sessionHash);return value;
}
/** Revalidate immediately before disclosing an asynchronous route result. */
export async function assertRequestCurrent(request:Request){
  const authority=requestAuthority.get(request);if(!authority)return;
  const db=await database();await db.transaction(async tx=>{await assertWorkspaceContext(tx,authority.actor);await assertSession(tx,authority.actor,authority.sessionHash);});
}
export async function bindSessionAuthority(request:Request,value:Actor,token:string,contextId:string){
  const db=await database(),sessionHash=digest(token);
  const scoped=await db.transaction(async tx=>{const actor=await sessionWorkspaceContext(tx,value,sessionHash,contextId);await assertSession(tx,actor,sessionHash);return actor;});
  remember(request,scoped,sessionHash,true);return scoped;
}
export function requireRole(value: Actor, roles: Role[]) {
  if (!roles.includes(value.role)) throw new HttpError(403, 'AUTHORITY_DENIED', 'This role cannot authorize financial actions. Send a proposal to the recovery planner.');
}
export async function startSession(request: Request,options:{fresh?:boolean}={}): Promise<{ actor: Actor; token:string;cookie?: string }> {
  sameOrigin(request);
  const existing=requestSessionToken(request);
  if(existing!==undefined&&!options.fresh)return {actor:await actor(request,{allowWorkspaceBootstrap:true}),token:existing};
  const token = randomBytes(32).toString('hex');
  const id = randomUUID();
  const value: Actor = { id: 'judge-' + id.slice(0, 8), tenantId: 'fernwood-' + id, role: 'judge', membershipVersion: 1, grantId: 'sample-' + id };
  const db = await database();
  await requireWorkspaceSchema(db);
  await ensurePaymentsSchema(db);
  const expiresAt=new Date(Date.now()+7*86400000).toISOString();
  await db.query('INSERT INTO gh_sessions (token_hash,actor,expires_at) VALUES ($1,$2::jsonb,$3)', [digest(token), JSON.stringify(value),expiresAt]);
  await db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [value.tenantId,value.id,value.role,value.membershipVersion]);
  return { actor: value,token,cookie:sessionCookie(request,token,expiresAt) };
}
