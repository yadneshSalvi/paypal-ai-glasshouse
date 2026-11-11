import {randomBytes,randomUUID} from 'node:crypto';
import type {TestContext} from 'node:test';
import type {Actor,Role} from '../../packages/domain/types';
import {agentHarness} from './agents';

// agents.ts validates the isolated database and refuses inherited provider
// credentials before these application modules can be initialized.
const {ensureWorkspacesSchema}=await import('../../lib/server/workspaces/schema');
const {WorkspaceService}=await import('../../lib/server/workspaces/service');
const {WorkspaceSecrets,tokenHash}=await import('../../lib/server/workspaces/crypto');
const {sessionWorkspaceContext}=await import('../../lib/server/workspaces/authority');

export const commandId=()=>randomUUID();
export const failure=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
export async function workspaceHarness(role:Role='judge'){
  const h=await agentHarness();
  await ensureWorkspacesSchema(h.db);
  const token=randomBytes(32).toString('hex'),sessionHash=tokenHash(token);
  h.who.role=role;h.who.agentSessionHash=sessionHash;
  const saved:Actor={id:h.who.id,tenantId:h.who.tenantId,role,membershipVersion:1,grantId:'original-fixture-grant'};
  await h.db.query('UPDATE gh_memberships SET role=$3 WHERE tenant_id=$1 AND actor_id=$2',[saved.tenantId,saved.id,role]);
  await h.db.query("INSERT INTO gh_sessions(token_hash,actor,expires_at) VALUES($1,$2::jsonb,now()+interval '1 hour')",[sessionHash,JSON.stringify(saved)]);
  const service=new WorkspaceService(h.db,new WorkspaceSecrets(h.key));
  const before={session:(await h.db.query('SELECT * FROM gh_sessions WHERE token_hash=$1',[sessionHash]))[0],member:(await h.db.query('SELECT * FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2',[saved.tenantId,saved.id]))[0]};
  const bootstrap=await service.admit(saved,token),credential={sessionHash,contextId:bootstrap.identity.contextId};
  const scoped=await h.db.transaction(tx=>sessionWorkspaceContext(tx,saved,sessionHash,credential.contextId));
  const createWorkspace=async(name='Second incident room',organizationId=bootstrap.workspace.organizationId!)=>service.createWorkspace(credential,{requestId:commandId(),organizationId,name,merchantName:'Sample merchant',description:'A separate fictional merchant investigation.'});
  const invite=async(role:'owner'|'operator'|'investigator'|'viewer'='viewer',workspaceId=saved.tenantId,issuer=credential)=>service.createInvitation(issuer,workspaceId,{requestId:commandId(),role,expiresInHours:1});
  const join=async(role:'owner'|'operator'|'investigator'|'viewer'='viewer',workspaceId=saved.tenantId,issuer=credential)=>{
    const invitation=await invite(role,workspaceId,issuer),input={requestId:commandId(),token:invitation.token,displayName:'Invited fixture member'};
    const accepted=await service.acceptInvitation(null,input),credential={sessionHash:tokenHash(accepted.token),contextId:accepted.selection.contextId};
    const directory=await service.directory(credential);
    return {invitation,input,accepted,credential,directory};
  };
  return {...h,token,sessionHash,saved,before,service,bootstrap,credential,scoped,createWorkspace,invite,join};
}
export type WorkspaceHarness=Awaited<ReturnType<typeof workspaceHarness>>;
export function routeHarness(t:TestContext,h:WorkspaceHarness){
  const previous=globalThis.glasshouseDatabase,previousKey=process.env.GLASSHOUSE_WORKSPACE_KEY;
  globalThis.glasshouseDatabase=Promise.resolve(h.db);process.env.GLASSHOUSE_WORKSPACE_KEY=h.key;
  t.after(()=>{globalThis.glasshouseDatabase=previous;if(previousKey===undefined)delete process.env.GLASSHOUSE_WORKSPACE_KEY;else process.env.GLASSHOUSE_WORKSPACE_KEY=previousKey;});
  const cookieName=process.env.GLASSHOUSE_SESSION_COOKIE||'glasshouse_session';
  return (path:string,options:{token?:string;contextId?:string;method?:string;body?:unknown;origin?:string}={})=>new Request('http://localhost:4525/api/'+path,{
    method:options.method??(options.body===undefined?'GET':'POST'),headers:{cookie:cookieName+'='+(options.token??h.token),'X-Glasshouse-Context':options.contextId??h.credential.contextId!,...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(options.origin?{origin:options.origin}:{})},body:options.body===undefined?undefined:JSON.stringify(options.body),
  });
}
