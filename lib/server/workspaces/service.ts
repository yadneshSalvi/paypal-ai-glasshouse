import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from '@/packages/db/client';
import type {Actor,Role} from '@/packages/domain/types';
import type {InvitedRole,InvitationPreview,WorkspaceAdministration,WorkspaceBootstrap,WorkspaceDirectory,WorkspaceInvitation,WorkspaceSummary,WorkspaceSwitch} from '@/packages/workspaces/types';
import {HttpError} from '../errors';
import {audit,hash} from '../repository';
import {WorkspaceSecrets,tokenHash} from './crypto';
import {withWorkspaceContext} from './authority';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const title=z.string().trim().min(2).max(80).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const command=z.string().uuid();
const version=z.number().int().positive();
const role=z.enum(['owner','operator','investigator','viewer']);
const context=z.string().uuid();
const description=z.string().trim().max(300).refine(value=>!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value));
function parsed<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new HttpError(400,'WORKSPACE_INPUT_INVALID','Check the name, role, revision and request identity before continuing.');return result.data;}
const iso=(value:string|Date)=>new Date(value).toISOString();
const capabilityDisclosure='Access is held by this browser session. The display name is self-declared; no human identity or email address has been verified.';
type AccessRow=Record<string,unknown>&{id:string;person_id:string;display_name:string;current_session_hash:string;context_id:string;version:number;expires_at:string|Date;session_hash:string;tenant_id:string;actor_id:string;session_actor:Actor};
type WorkspaceRow=Record<string,unknown>&{tenant_id:string;organization_id:string;organization_name:string;name:string;merchant_name:string;description:string;status:'active'|'archived';source_kind:'sample'|'existing';version:number};
type InviteRow=Record<string,unknown>&{id:string;tenant_id:string;organization_id:string;role:InvitedRole;token_hash:string;created_by_person:string;created_by_actor:string;issuer_membership_version:number;expires_at:string|Date;created_at:string|Date;revoked_at:string|Date|null;accepted_at:string|Date|null;accepted_by_person:string|null;accept_request_id:string|null;accept_request_hash:string|null;private_acceptance:string|null};
export interface WorkspaceCredential {sessionHash:string;contextId?:string}
export interface WorkspaceCookieResult {token:string;expiresAt:string;selection:WorkspaceSwitch}

/** Existing payment memberships remain the only workspace role authority.
 * Organization ownership permits organization administration, not an implicit
 * financial grant in every merchant workspace. */
export class WorkspaceService {
  constructor(readonly db:Database,private readonly secrets:WorkspaceSecrets){}

  private async access(tx:Database,credential:WorkspaceCredential,current=true,lock=false):Promise<AccessRow>{
    const row=(await tx.query<AccessRow>(`SELECT a.*,p.display_name,l.session_hash,l.tenant_id,l.actor_id,s.actor AS session_actor
      FROM gh_workspace_session_links l JOIN gh_workspace_access_sessions a ON a.id=l.access_id
      JOIN gh_people p ON p.id=a.person_id JOIN gh_sessions s ON s.token_hash=l.session_hash
      WHERE l.session_hash=$1 AND a.active=true AND a.expires_at>now() AND s.expires_at>now()${lock?' FOR UPDATE OF a':' FOR SHARE OF a'}`,[credential.sessionHash]))[0];
    if(!row)throw new HttpError(401,'WORKSPACE_ACCESS_EXPIRED','This browser access is no longer active. Saved work remains preserved; open a fresh access invitation to return.');
    if(current&&(row.current_session_hash!==credential.sessionHash||row.context_id!==credential.contextId))throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','Another tab changed the selected workspace. Choose the current workspace before continuing.');
    return row;
  }
  private async member(tx:Database,access:AccessRow,tenantId:string,lock=false):Promise<Actor>{
    const row=(await tx.query<{actor_id:string;role:Role;version:number;active:boolean}>(`SELECT m.actor_id,m.role,m.version,m.active
      FROM gh_actor_people p JOIN gh_memberships m ON m.tenant_id=p.tenant_id AND m.actor_id=p.actor_id
      WHERE p.person_id=$1 AND p.tenant_id=$2${lock?' FOR SHARE OF m':''}`,[access.person_id,tenantId]))[0];
    if(!row?.active)throw new HttpError(403,'WORKSPACE_MEMBERSHIP_REQUIRED','Your current membership does not permit this workspace.');
    return withWorkspaceContext({id:row.actor_id,tenantId,role:row.role,membershipVersion:row.version},{accessId:access.id,contextId:access.context_id,sessionHash:access.session_hash});
  }
  private async workspace(tx:Database,tenantId:string){
    const row=(await tx.query<WorkspaceRow>(`SELECT w.*,o.name AS organization_name FROM gh_workspaces w
      JOIN gh_organizations o ON o.id=w.organization_id WHERE w.tenant_id=$1`,[tenantId]))[0];
    if(!row)throw new HttpError(404,'WORKSPACE_NOT_FOUND','This workspace is not available through the organization directory.');
    return row;
  }
  private summary(row:WorkspaceRow,actor:Actor,current=false):WorkspaceSummary{return {
    id:row.tenant_id,organizationId:row.organization_id,organizationName:row.organization_name,name:row.name,
    merchantName:row.merchant_name,description:row.description,status:row.status,version:row.version,role:actor.role,
    membershipVersion:actor.membershipVersion,source:row.source_kind,current,canManage:['owner','judge'].includes(actor.role),canGrantFinancialRoles:actor.role==='owner',
  };}
  private async lockOrganization(tx:Database,id:string){await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['glasshouse-organization:'+id]);}
  private async organizationOwner(tx:Database,access:AccessRow,organizationId:string){
    const row=(await tx.query<{role:string;version:number;active:boolean}>('SELECT role,version,active FROM gh_organization_members WHERE organization_id=$1 AND person_id=$2 FOR SHARE',[organizationId,access.person_id]))[0];
    if(!row?.active||row.role!=='owner')throw new HttpError(403,'ORGANIZATION_OWNER_REQUIRED','Only a current organization owner can make this change.');
    return row;
  }
  private async administrator(tx:Database,access:AccessRow,tenantId:string){
    const workspace=await this.workspace(tx,tenantId);await this.lockOrganization(tx,workspace.organization_id);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['glasshouse-workspace:'+tenantId]);
    await tx.query('SELECT tenant_id FROM gh_workspaces WHERE tenant_id=$1 FOR UPDATE',[tenantId]);
    const actor=await this.member(tx,access,tenantId,true);
    if(!['owner','judge'].includes(actor.role))throw new HttpError(403,'WORKSPACE_ADMIN_REQUIRED','Only a workspace owner can administer this workspace.');
    return {actor,workspace};
  }
  private async command<T>(tx:Database,access:AccessRow,requestId:string,kind:string,input:unknown,work:()=>Promise<T>):Promise<T>{
    const requestHash=hash({kind,input});
    const existing=(await tx.query<{kind:string;request_hash:string;private_result:string}>('SELECT kind,request_hash,private_result FROM gh_workspace_commands WHERE access_id=$1 AND id=$2 FOR UPDATE',[access.id,requestId]))[0];
    if(existing){if(existing.kind!==kind||existing.request_hash!==requestHash)throw new HttpError(409,'WORKSPACE_COMMAND_CHANGED','This request identity already belongs to a different change.');return this.secrets.open<T>('command',access.id+':'+requestId,existing.private_result);}
    const result=await work();
    await tx.query('INSERT INTO gh_workspace_commands(access_id,id,kind,request_hash,private_result) VALUES($1,$2,$3,$4,$5)',[access.id,requestId,kind,requestHash,this.secrets.seal('command',access.id+':'+requestId,result)]);
    return result;
  }

  /** Admission can only anchor an already issued, still-current session. */
  async admit(actor:Actor,sessionToken:string,options:{newSample?:boolean}={}):Promise<WorkspaceBootstrap>{
    if(!/^[a-f0-9]{64}$/.test(sessionToken))throw new HttpError(401,'SESSION_REQUIRED','A server-issued session is required.');
    const sessionHash=tokenHash(sessionToken);
    return this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['glasshouse-access:'+sessionHash]);
      const session=(await tx.query<{actor:Actor;expires_at:string|Date}>('SELECT actor,expires_at FROM gh_sessions WHERE token_hash=$1 AND expires_at>now() FOR SHARE',[sessionHash]))[0];
      const membership=(await tx.query<{role:Role;version:number;active:boolean}>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE',[actor.tenantId,actor.id]))[0];
      if(!session||session.actor.tenantId!==actor.tenantId||session.actor.id!==actor.id||!membership?.active||membership.version!==actor.membershipVersion||membership.role!==actor.role)throw new HttpError(403,'WORKSPACE_ADMISSION_DENIED','The existing session and current workspace authority must agree.');
      const linked=(await tx.query<{access_id:string}>('SELECT access_id FROM gh_workspace_session_links WHERE session_hash=$1',[sessionHash]))[0];
      if(!linked){
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['glasshouse-person:'+actor.tenantId+':'+actor.id]);
        let personId=(await tx.query<{person_id:string}>('SELECT person_id FROM gh_actor_people WHERE tenant_id=$1 AND actor_id=$2',[actor.tenantId,actor.id]))[0]?.person_id;
        if(!personId){personId='person-'+randomUUID();await tx.query('INSERT INTO gh_people(id,display_name) VALUES($1,$2)',[personId,actor.role==='judge'?'Workspace reviewer':'Workspace member']);await tx.query('INSERT INTO gh_actor_people(tenant_id,actor_id,person_id) VALUES($1,$2,$3)',[actor.tenantId,actor.id,personId]);}
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['glasshouse-workspace:'+actor.tenantId]);
        let workspace=(await tx.query<{organization_id:string}>('SELECT organization_id FROM gh_workspaces WHERE tenant_id=$1',[actor.tenantId]))[0];
        if(!workspace&&['owner','judge'].includes(actor.role)){
          const organizationId='org-'+randomUUID();
          await tx.query('INSERT INTO gh_organizations(id,name,created_by) VALUES($1,$2,$3)',[organizationId,'Fernwood operations',personId]);
          await tx.query("INSERT INTO gh_organization_members(organization_id,person_id,role) VALUES($1,$2,'owner')",[organizationId,personId]);
          await tx.query('INSERT INTO gh_workspaces(tenant_id,organization_id,name,merchant_name,source_kind,created_by) VALUES($1,$2,$3,$4,$5,$6)',[actor.tenantId,organizationId,'Fernwood incident room','Fernwood Coffee',options.newSample?'sample':'existing',personId]);
          workspace={organization_id:organizationId};
        }
        if(workspace)await tx.query("INSERT INTO gh_organization_members(organization_id,person_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",[workspace.organization_id,personId]);
        const accessId='access-'+randomUUID(),contextId=randomUUID();
        await tx.query('INSERT INTO gh_workspace_access_sessions(id,person_id,current_session_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$5)',[accessId,personId,sessionHash,contextId,iso(session.expires_at)]);
        await tx.query('INSERT INTO gh_workspace_session_links(session_hash,access_id,tenant_id,actor_id,private_token) VALUES($1,$2,$3,$4,$5)',[sessionHash,accessId,actor.tenantId,actor.id,this.secrets.seal('session-token',sessionHash,sessionToken)]);
      }
      const access=await this.access(tx,{sessionHash},false);
      if(access.current_session_hash!==sessionHash)throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','This session belongs to an earlier workspace selection. Choose the active workspace.');
      const directory=await this.directoryIn(tx,access);
      const workspace=directory.workspaces.find(row=>row.id===actor.tenantId);
      if(!workspace)throw new HttpError(403,'WORKSPACE_MEMBERSHIP_REQUIRED','Your workspace membership is no longer active.');
      return {identity:directory.identity,workspace};
    });
  }
  private async directoryIn(tx:Database,access:AccessRow):Promise<WorkspaceDirectory>{
    const rows=await tx.query<WorkspaceRow&{actor_id:string;role:Role;membership_version:number}>(`SELECT w.*,o.name AS organization_name,m.actor_id,m.role,m.version AS membership_version
      FROM gh_actor_people p JOIN gh_memberships m ON m.tenant_id=p.tenant_id AND m.actor_id=p.actor_id
      JOIN gh_workspaces w ON w.tenant_id=p.tenant_id JOIN gh_organizations o ON o.id=w.organization_id
      WHERE p.person_id=$1 AND m.active=true ORDER BY w.created_at,w.tenant_id`,[access.person_id]);
    const selected=(await tx.query<{tenant_id:string}>('SELECT tenant_id FROM gh_workspace_session_links WHERE session_hash=$1',[access.current_session_hash]))[0]?.tenant_id;
    const organizations=await tx.query<{id:string;name:string;version:number;role:'owner'|'member';workspace_count:string}>(`SELECT o.id,o.name,o.version,m.role,
      (SELECT count(*)::text FROM gh_workspaces w WHERE w.organization_id=o.id) AS workspace_count
      FROM gh_organizations o JOIN gh_organization_members m ON m.organization_id=o.id
      WHERE m.person_id=$1 AND m.active=true ORDER BY o.created_at,o.id`,[access.person_id]);
    const workspaces=rows.map(row=>this.summary(row,{id:row.actor_id,tenantId:row.tenant_id,role:row.role,membershipVersion:row.membership_version},row.tenant_id===selected));
    // An existing read-only legacy session cannot claim organization ownership.
    // It can still use its existing workspace until an owner enrolls metadata.
    if(!workspaces.some(row=>row.id===access.tenant_id)){
      const member=(await tx.query<{role:Role;version:number;active:boolean}>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2',[access.tenant_id,access.actor_id]))[0];
      if(member?.active&&!await tx.query('SELECT tenant_id FROM gh_workspaces WHERE tenant_id=$1',[access.tenant_id]).then(rows=>rows.length))workspaces.push({id:access.tenant_id,organizationId:null,organizationName:null,name:'Existing workspace',merchantName:'Fernwood Coffee',description:'Organization administration awaits a workspace owner.',status:'active',version:0,role:member.role,membershipVersion:member.version,source:'existing',current:access.tenant_id===selected,canManage:false,canGrantFinancialRoles:false});
    }
    return {identity:{personId:access.person_id,displayName:access.display_name,kind:'browser_capability',expiresAt:iso(access.expires_at),contextId:access.context_id,currentWorkspaceId:selected??access.tenant_id,disclosure:capabilityDisclosure},organizations:organizations.map(row=>({id:row.id,name:row.name,version:row.version,role:row.role,workspaceCount:Number(row.workspace_count)})),workspaces};
  }
  async directory(credential:WorkspaceCredential){return this.db.transaction(async tx=>this.directoryIn(tx,await this.access(tx,credential,false)));}
  async verifyDisclosure(credential:WorkspaceCredential,expected:{contextId:string;workspaces?:WorkspaceSummary[];organizations?:{id:string;role:'owner'|'member'}[]}){
    return this.db.transaction(async tx=>{
      const access=await this.access(tx,credential,false);
      if(access.context_id!==expected.contextId)throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','The selected workspace changed before this result could be shown. Open the current directory.');
      for(const workspace of expected.workspaces??[]){
        const actor=await this.member(tx,access,workspace.id,true);
        if(actor.role!==workspace.role||actor.membershipVersion!==workspace.membershipVersion)throw new HttpError(403,'CURRENT_AUTHORITY_REQUIRED','Workspace membership changed before this result could be shown.');
      }
      for(const organization of expected.organizations??[]){
        const member=(await tx.query<{role:string;active:boolean}>('SELECT role,active FROM gh_organization_members WHERE organization_id=$1 AND person_id=$2 FOR SHARE',[organization.id,access.person_id]))[0];
        if(!member?.active||member.role!==organization.role)throw new HttpError(403,'CURRENT_AUTHORITY_REQUIRED','Organization access changed before this result could be shown.');
      }
    });
  }
  async verifySelection(result:WorkspaceCookieResult){
    const credential={sessionHash:tokenHash(result.token),contextId:result.selection.contextId};
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true);if(access.tenant_id!==result.selection.workspaceId)throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','This workspace selection has been replaced. Open the current directory.');await this.member(tx,access,result.selection.workspaceId,true);});
  }
  async profile(credential:WorkspaceCredential,input:unknown){
    const value=parsed(z.strictObject({requestId:command,displayName:title}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true);return this.command(tx,access,value.requestId,'profile',value,async()=>{await tx.query('UPDATE gh_people SET display_name=$2 WHERE id=$1',[access.person_id,value.displayName]);return {displayName:value.displayName,identityKind:'browser_capability' as const};});});
  }
  async createOrganization(credential:WorkspaceCredential,input:unknown){
    const value=parsed(z.strictObject({requestId:command,name:title}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true);return this.command(tx,access,value.requestId,'organization.create',value,async()=>{
      const count=Number((await tx.query<{count:string}>('SELECT count(*)::text AS count FROM gh_organizations WHERE created_by=$1',[access.person_id]))[0].count);if(count>=20)throw new HttpError(409,'ORGANIZATION_LIMIT','This browser identity has reached its organization limit.');
      const id='org-'+randomUUID();await tx.query('INSERT INTO gh_organizations(id,name,created_by) VALUES($1,$2,$3)',[id,value.name,access.person_id]);await tx.query("INSERT INTO gh_organization_members(organization_id,person_id,role) VALUES($1,$2,'owner')",[id,access.person_id]);return {id,name:value.name,version:1};
    });});
  }
  async createWorkspace(credential:WorkspaceCredential,input:unknown){
    const value=parsed(z.strictObject({requestId:command,organizationId:id,name:title,merchantName:title,description:description.default('')}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true);await this.lockOrganization(tx,value.organizationId);await this.organizationOwner(tx,access,value.organizationId);return this.command(tx,access,value.requestId,'workspace.create',value,async()=>{
      const count=Number((await tx.query<{count:string}>('SELECT count(*)::text AS count FROM gh_workspaces WHERE organization_id=$1',[value.organizationId]))[0].count);if(count>=50)throw new HttpError(409,'WORKSPACE_LIMIT','This organization has reached its workspace limit.');
      const tenantId='workspace-'+randomUUID(),actorId=access.person_id;
      await tx.query("INSERT INTO gh_workspaces(tenant_id,organization_id,name,merchant_name,description,source_kind,created_by) VALUES($1,$2,$3,$4,$5,'sample',$6)",[tenantId,value.organizationId,value.name,value.merchantName,value.description,access.person_id]);
      await tx.query("INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,'owner',1)",[tenantId,actorId]);await tx.query('INSERT INTO gh_actor_people(tenant_id,actor_id,person_id) VALUES($1,$2,$3)',[tenantId,actorId,access.person_id]);
      await audit(tx,{id:actorId,tenantId},'workspace.created','Created a separate Sample workspace',tenantId,{organizationId:value.organizationId,providerResourcesCopied:false});
      return this.summary(await this.workspace(tx,tenantId),{id:actorId,tenantId,role:'owner',membershipVersion:1});
    });});
  }
  private async select(tx:Database,access:AccessRow,tenantId:string):Promise<WorkspaceCookieResult>{
    const actor=await this.member(tx,access,tenantId,true);
    let link=(await tx.query<{session_hash:string;private_token:string}>('SELECT session_hash,private_token FROM gh_workspace_session_links WHERE access_id=$1 AND tenant_id=$2 FOR UPDATE',[access.id,tenantId]))[0];
    if(!link){
      const workspace=await this.workspace(tx,tenantId);
      const token=randomBytes(32).toString('hex'),sessionHash=tokenHash(token);
      const newActor:Actor={id:actor.id,tenantId,role:actor.role,membershipVersion:actor.membershipVersion,...(workspace.source_kind==='sample'?{grantId:'sample-workspace-'+tenantId}:{})};
      await tx.query('INSERT INTO gh_sessions(token_hash,actor,expires_at) VALUES($1,$2::jsonb,$3)',[sessionHash,JSON.stringify(newActor),iso(access.expires_at)]);
      const privateToken=this.secrets.seal('session-token',sessionHash,token);
      await tx.query('INSERT INTO gh_workspace_session_links(session_hash,access_id,tenant_id,actor_id,private_token) VALUES($1,$2,$3,$4,$5)',[sessionHash,access.id,tenantId,actor.id,privateToken]);link={session_hash:sessionHash,private_token:privateToken};
    }
    const saved=(await tx.query<{actor:Actor;expires_at:string|Date}>('SELECT actor,expires_at FROM gh_sessions WHERE token_hash=$1 AND expires_at>now() FOR SHARE',[link.session_hash]))[0];
    if(!saved||saved.actor.tenantId!==tenantId||saved.actor.id!==actor.id)throw new HttpError(401,'WORKSPACE_SESSION_EXPIRED','The original workspace session has expired. A fresh access grant is required; its authority was not renewed.');
    const contextId=randomUUID();await tx.query('UPDATE gh_workspace_access_sessions SET current_session_hash=$2,context_id=$3,version=version+1 WHERE id=$1',[access.id,link.session_hash,contextId]);
    return {token:this.secrets.open<string>('session-token',link.session_hash,link.private_token),expiresAt:iso(saved.expires_at),selection:{contextId,workspaceId:tenantId}};
  }
  async switchWorkspace(credential:WorkspaceCredential,input:unknown):Promise<WorkspaceCookieResult>{
    const value=parsed(z.strictObject({requestId:command,workspaceId:id,expectedContextId:context}),input);
    return this.db.transaction(async tx=>{
      const access=await this.access(tx,credential,false,true);
      await this.member(tx,access,value.workspaceId,true);
      const existing=(await tx.query<{request_hash:string;kind:string;private_result:string}>('SELECT kind,request_hash,private_result FROM gh_workspace_commands WHERE access_id=$1 AND id=$2',[access.id,value.requestId]))[0];
      if(existing){
        if(existing.kind!=='workspace.switch'||existing.request_hash!==hash({kind:'workspace.switch',input:value}))throw new HttpError(409,'WORKSPACE_COMMAND_CHANGED','This switch identity already has a different destination.');
        const result=this.secrets.open<WorkspaceCookieResult>('command',access.id+':'+value.requestId,existing.private_result);
        if(access.context_id!==result.selection.contextId||access.current_session_hash!==tokenHash(result.token))throw new HttpError(409,'WORKSPACE_SWITCH_SUPERSEDED','A later workspace selection has already replaced this switch. Reload the directory.');
        return result;
      }
      // An explicitly reopened directory can repair a delayed Set-Cookie race
      // using any still-valid link in this same access family. Its fresh context
      // and exact target membership are required; stale tabs still fail closed.
      if(access.context_id!==value.expectedContextId||credential.contextId!==value.expectedContextId)throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','This workspace selection started in an earlier tab context. Reload the directory before switching.');
      return this.command(tx,access,value.requestId,'workspace.switch',value,()=>this.select(tx,access,value.workspaceId));
    });
  }
  private invitation(row:InviteRow):WorkspaceInvitation{return {id:row.id,workspaceId:row.tenant_id,role:row.role,createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),state:row.revoked_at?'revoked':row.accepted_at?'accepted':new Date(row.expires_at).getTime()<=Date.now()?'expired':'available',createdBy:row.created_by_actor};}
  async administration(credential:WorkspaceCredential,workspaceId:string):Promise<WorkspaceAdministration>{
    parsed(id,workspaceId);
    return this.db.transaction(async tx=>{
      const access=await this.access(tx,credential),{actor,workspace}=await this.administrator(tx,access,workspaceId);
      const members=await tx.query<{actor_id:string;person_id:string|null;display_name:string|null;role:Role;version:number;active:boolean}>(`SELECT m.actor_id,p.person_id,u.display_name,m.role,m.version,m.active
        FROM gh_memberships m LEFT JOIN gh_actor_people p ON p.tenant_id=m.tenant_id AND p.actor_id=m.actor_id
        LEFT JOIN gh_people u ON u.id=p.person_id WHERE m.tenant_id=$1 ORDER BY m.active DESC,m.actor_id`,[workspaceId]);
      const organization=(await tx.query<{version:number;role:string;active:boolean}>(`SELECT o.version,m.role,m.active FROM gh_organizations o
        JOIN gh_organization_members m ON m.organization_id=o.id WHERE o.id=$1 AND m.person_id=$2`,[workspace.organization_id,access.person_id]))[0];
      const canManageOrganization=organization?.active&&organization.role==='owner';
      const organizationMembers=canManageOrganization?await tx.query<{person_id:string;display_name:string;role:'owner'|'member';version:number;active:boolean}>(`SELECT m.person_id,p.display_name,m.role,m.version,m.active
        FROM gh_organization_members m JOIN gh_people p ON p.id=m.person_id WHERE m.organization_id=$1 ORDER BY m.active DESC,p.display_name,m.person_id`,[workspace.organization_id]):[];
      const invitations=await tx.query<InviteRow>('SELECT * FROM gh_workspace_invitations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[workspaceId]);
      return {workspace:this.summary(workspace,actor,workspaceId===access.tenant_id),members:members.map(row=>({actorId:row.actor_id,personId:row.person_id,displayName:row.display_name??'Existing workspace member',role:row.role,version:row.version,active:row.active,self:row.person_id===access.person_id})),invitations:invitations.map(row=>this.invitation(row)),organizationMembers:organizationMembers.map(row=>({personId:row.person_id,displayName:row.display_name,role:row.role,version:row.version,active:row.active,self:row.person_id===access.person_id})),organizationVersion:organization?.version??null,canManageOrganization:!!canManageOrganization};
    });
  }
  async updateWorkspace(credential:WorkspaceCredential,workspaceId:string,input:unknown){
    parsed(id,workspaceId);const value=parsed(z.strictObject({requestId:command,expectedVersion:version,name:title,merchantName:title,description:description,status:z.enum(['active','archived'])}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true),{actor}=await this.administrator(tx,access,workspaceId);return this.command(tx,access,value.requestId,'workspace.update',{workspaceId,...value},async()=>{
      const workspace=await this.workspace(tx,workspaceId);
      if(workspace.version!==value.expectedVersion)throw new HttpError(409,'WORKSPACE_REVISION_CHANGED','This workspace was changed by another administrator. Reload its current settings.');
      if(value.status==='archived'){
        const active=(await tx.query<{count:string}>(`SELECT (
          (SELECT count(*) FROM gh_operations WHERE tenant_id=$1 AND status IN ('queued','submitting','provider_pending','unknown_outcome'))+
          (SELECT count(*) FROM gh_recovery_intents WHERE tenant_id=$1 AND status IN ('queued','claimed','submitting','provider_pending','unknown_outcome'))+
          (SELECT count(*) FROM gh_seed_runs WHERE tenant_id=$1 AND status IN ('approved','running'))+
          (SELECT count(*) FROM gh_seed_items WHERE tenant_id=$1 AND status IN ('creating','awaiting_buyer','capturing','verifying','unknown'))+
          (SELECT count(*) FROM gh_payment_consents WHERE tenant_id=$1 AND status IN ('preparing','exchanging','unknown'))+
          (SELECT count(*) FROM gh_vault_operations WHERE tenant_id=$1 AND status IN ('dispatching','unknown'))+
          (SELECT count(*) FROM gh_agent_runs WHERE tenant_id=$1 AND state='running')
          )::text AS count`,[workspaceId]))[0];
        let reads=0;
        for(const [table,predicate] of [['gh_observation_jobs',"state IN ('queued','running','retry')"],['gh_reporting_runs',"state='active'"]] as const){
          if((await tx.query<{present:boolean}>('SELECT to_regclass($1) IS NOT NULL AS present',[table]))[0]?.present)reads+=Number((await tx.query<{count:string}>(`SELECT count(*)::text AS count FROM ${table} WHERE tenant_id=$1 AND ${predicate}`,[workspaceId]))[0].count);
        }
        if(Number(active.count)+reads>0)throw new HttpError(409,'WORKSPACE_WORK_PENDING','Finish or explicitly stop active investigations and source reads, and reconcile pending financial work before archiving.');
      }
      await tx.query('UPDATE gh_workspaces SET name=$2,merchant_name=$3,description=$4,status=$5,version=version+1 WHERE tenant_id=$1',[workspaceId,value.name,value.merchantName,value.description,value.status]);
      await audit(tx,actor,value.status!==workspace.status?'workspace.'+value.status:'workspace.renamed',value.status==='archived'?'Archived the workspace while preserving every saved record':'Updated workspace settings',workspaceId,{previousVersion:workspace.version,version:workspace.version+1,previousStatus:workspace.status,status:value.status});
      return this.summary(await this.workspace(tx,workspaceId),actor,workspaceId===access.tenant_id);
    });});
  }
  private async preserveLastOwner(tx:Database,tenantId:string,target:{role:Role;active:boolean},nextRole:Role,nextActive:boolean){
    if(!target.active||!['owner','judge'].includes(target.role)||nextActive&&['owner','judge'].includes(nextRole))return;
    const owners=await tx.query<{actor_id:string}>("SELECT actor_id FROM gh_memberships WHERE tenant_id=$1 AND active=true AND role IN ('owner','judge') FOR UPDATE",[tenantId]);
    if(owners.length<=1)throw new HttpError(409,'LAST_WORKSPACE_OWNER','Keep at least one active workspace owner before removing or changing this membership.');
  }
  async updateMember(credential:WorkspaceCredential,workspaceId:string,actorId:string,input:unknown){
    parsed(id,workspaceId);parsed(id,actorId);const value=parsed(z.strictObject({requestId:command,expectedVersion:version,role,active:z.boolean()}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true),{actor}=await this.administrator(tx,access,workspaceId);return this.command(tx,access,value.requestId,'workspace.member',{workspaceId,actorId,...value},async()=>{
      const target=(await tx.query<{role:Role;version:number;active:boolean}>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR UPDATE',[workspaceId,actorId]))[0];
      if(!target||target.version!==value.expectedVersion)throw new HttpError(409,'MEMBERSHIP_REVISION_CHANGED','This membership changed. Reload it before making another decision.');
      if(target.role==='judge')throw new HttpError(403,'ORIGINAL_GRANT_PRESERVED','An existing judge grant cannot be changed through organization administration.');
      if(actor.role==='judge'&&(!['investigator','viewer'].includes(target.role)||!['investigator','viewer'].includes(value.role)))throw new HttpError(403,'FINANCIAL_ROLE_GRANT_DENIED','This original review grant can administer only investigator and viewer access.');
      await this.preserveLastOwner(tx,workspaceId,target,value.role,value.active);
      if(target.role===value.role&&target.active===value.active)return {actorId,role:target.role,active:target.active,version:target.version};
      await tx.query('UPDATE gh_memberships SET role=$3,active=$4,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[workspaceId,actorId,value.role,value.active]);
      await audit(tx,actor,value.active?'membership.changed':'membership.revoked',value.active?'Changed the exact workspace role':'Revoked workspace access',actorId,{before:{role:target.role,active:target.active,version:target.version},after:{role:value.role,active:value.active,version:target.version+1}});
      return {actorId,role:value.role,active:value.active,version:target.version+1};
    });});
  }
  async updateOrganization(credential:WorkspaceCredential,organizationId:string,input:unknown){
    parsed(id,organizationId);const value=parsed(z.strictObject({requestId:command,expectedVersion:version,name:title}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true);await this.lockOrganization(tx,organizationId);await this.organizationOwner(tx,access,organizationId);return this.command(tx,access,value.requestId,'organization.update',{organizationId,...value},async()=>{
      const row=(await tx.query<{version:number}>('SELECT version FROM gh_organizations WHERE id=$1 FOR UPDATE',[organizationId]))[0];
      if(row.version!==value.expectedVersion)throw new HttpError(409,'ORGANIZATION_REVISION_CHANGED','This organization changed. Reload its current name before editing.');
      await tx.query('UPDATE gh_organizations SET name=$2,version=version+1 WHERE id=$1',[organizationId,value.name]);return {id:organizationId,name:value.name,version:row.version+1};
    });});
  }
  async updateOrganizationMember(credential:WorkspaceCredential,organizationId:string,personId:string,input:unknown){
    parsed(id,organizationId);parsed(id,personId);const value=parsed(z.strictObject({requestId:command,expectedVersion:version,role:z.enum(['owner','member']),active:z.boolean()}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true);await this.lockOrganization(tx,organizationId);await this.organizationOwner(tx,access,organizationId);return this.command(tx,access,value.requestId,'organization.member',{organizationId,personId,...value},async()=>{
      const target=(await tx.query<{role:string;version:number;active:boolean}>('SELECT role,version,active FROM gh_organization_members WHERE organization_id=$1 AND person_id=$2 FOR UPDATE',[organizationId,personId]))[0];
      if(!target||target.version!==value.expectedVersion)throw new HttpError(409,'MEMBERSHIP_REVISION_CHANGED','This organization membership changed. Reload before making another decision.');
      if(target.active&&target.role==='owner'&&(!value.active||value.role!=='owner')){
        const owners=await tx.query("SELECT person_id FROM gh_organization_members WHERE organization_id=$1 AND active=true AND role='owner' FOR UPDATE",[organizationId]);
        if(owners.length<=1)throw new HttpError(409,'LAST_ORGANIZATION_OWNER','Keep at least one active organization owner.');
      }
      if(!value.active){
        const affected=await tx.query<{tenant_id:string;actor_id:string;role:Role;version:number;active:boolean}>(`SELECT m.tenant_id,m.actor_id,m.role,m.version,m.active
          FROM gh_actor_people p JOIN gh_memberships m ON m.tenant_id=p.tenant_id AND m.actor_id=p.actor_id
          JOIN gh_workspaces w ON w.tenant_id=m.tenant_id WHERE p.person_id=$1 AND w.organization_id=$2 AND m.active=true ORDER BY m.tenant_id`,[personId,organizationId]);
        for(const row of affected){
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['glasshouse-workspace:'+row.tenant_id]);
          await tx.query('SELECT tenant_id FROM gh_workspaces WHERE tenant_id=$1 FOR UPDATE',[row.tenant_id]);
          if(row.role==='judge')throw new HttpError(403,'ORIGINAL_GRANT_PRESERVED','Removing this organization membership would change an original judge grant. That grant remains preserved.');
          await this.preserveLastOwner(tx,row.tenant_id,row,row.role,false);
        }
        for(const row of affected){await tx.query('UPDATE gh_memberships SET active=false,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[row.tenant_id,row.actor_id]);await audit(tx,{id:access.actor_id,tenantId:row.tenant_id},'membership.revoked','Organization owner revoked this workspace membership',row.actor_id,{organizationId,personId,organizationOwner:access.person_id,authority:'organization_membership',previousVersion:row.version,version:row.version+1});}
      }
      if(target.role!==value.role||target.active!==value.active)await tx.query('UPDATE gh_organization_members SET role=$3,active=$4,version=version+1 WHERE organization_id=$1 AND person_id=$2',[organizationId,personId,value.role,value.active]);
      // Restoring organization membership never silently restores workspace roles.
      return {personId,role:value.role,active:value.active,version:target.version+(target.role!==value.role||target.active!==value.active?1:0),workspaceAccessRestored:false};
    });});
  }
  async createInvitation(credential:WorkspaceCredential,workspaceId:string,input:unknown){
    parsed(id,workspaceId);const value=parsed(z.strictObject({requestId:command,role,expiresInHours:z.number().int().min(1).max(72)}),input);
    return this.db.transaction(async tx=>{
      const access=await this.access(tx,credential,true,true),{actor,workspace}=await this.administrator(tx,access,workspaceId);
      if(workspace.status!=='active')throw new HttpError(409,'WORKSPACE_ARCHIVED','Restore the workspace before creating new access invitations.');
      if(actor.role==='judge'&&!['investigator','viewer'].includes(value.role))throw new HttpError(403,'FINANCIAL_ROLE_GRANT_DENIED','This original review grant may share only investigator or viewer access.');
      return this.command(tx,access,value.requestId,'invitation.create',{workspaceId,...value},async()=>{
        const count=Number((await tx.query<{count:string}>('SELECT count(*)::text AS count FROM gh_workspace_invitations WHERE tenant_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()',[workspaceId]))[0].count);
        if(count>=20)throw new HttpError(409,'INVITATION_LIMIT','Revoke or wait for an existing invitation before creating another.');
        const id='invite-'+randomUUID(),token=randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+value.expiresInHours*3600000).toISOString();
        await tx.query('INSERT INTO gh_workspace_invitations(id,tenant_id,organization_id,role,token_hash,created_by_person,created_by_actor,issuer_membership_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,workspaceId,workspace.organization_id,value.role,tokenHash(token),access.person_id,actor.id,actor.membershipVersion,expiresAt]);
        await audit(tx,actor,'invitation.created','Created an expiring private access link',id,{role:value.role,expiresAt,delivery:'not_sent',identityVerification:'not_performed'});
        const row=(await tx.query<InviteRow>('SELECT * FROM gh_workspace_invitations WHERE id=$1',[id]))[0];
        return {invitation:this.invitation(row),token};
      });
    });
  }
  async revokeInvitation(credential:WorkspaceCredential,workspaceId:string,invitationId:string,input:unknown){
    parsed(id,workspaceId);parsed(id,invitationId);const value=parsed(z.strictObject({requestId:command}),input);
    return this.db.transaction(async tx=>{const access=await this.access(tx,credential,true,true),{actor}=await this.administrator(tx,access,workspaceId);return this.command(tx,access,value.requestId,'invitation.revoke',{workspaceId,invitationId,...value},async()=>{
      const row=(await tx.query<InviteRow>('SELECT * FROM gh_workspace_invitations WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[invitationId,workspaceId]))[0];
      if(!row)throw new HttpError(404,'INVITATION_NOT_FOUND','This invitation does not belong to this workspace.');
      if(row.accepted_at)throw new HttpError(409,'INVITATION_ALREADY_ACCEPTED','This link has already been accepted. Change the member’s current role or revoke their membership.');
      if(!row.revoked_at){await tx.query('UPDATE gh_workspace_invitations SET revoked_at=now() WHERE id=$1',[invitationId]);await audit(tx,actor,'invitation.revoked','Revoked an unused private access link',invitationId);}
      return {id:invitationId,state:'revoked' as const};
    });});
  }
  private async validInvitation(tx:Database,token:string,lock=false){
    if(!/^[a-f0-9]{64}$/.test(token))throw new HttpError(404,'INVITATION_UNAVAILABLE','This access invitation is not available.');
    const row=(await tx.query<InviteRow>(`SELECT * FROM gh_workspace_invitations WHERE token_hash=$1${lock?' FOR UPDATE':''}`,[tokenHash(token)]))[0];
    if(!row||row.revoked_at||new Date(row.expires_at).getTime()<=Date.now())throw new HttpError(410,'INVITATION_UNAVAILABLE','This access invitation has expired or was revoked. Ask a workspace owner for a fresh link.');
    const workspace=await this.workspace(tx,row.tenant_id);
    if(workspace.status!=='active')throw new HttpError(410,'INVITATION_UNAVAILABLE','This workspace is archived; the invitation cannot be accepted.');
    const issuer=(await tx.query<{role:Role;version:number;active:boolean;person_id:string}>(`SELECT m.role,m.version,m.active,p.person_id FROM gh_memberships m
      JOIN gh_actor_people p ON p.tenant_id=m.tenant_id AND p.actor_id=m.actor_id
      WHERE m.tenant_id=$1 AND m.actor_id=$2 FOR SHARE OF m,p`,[row.tenant_id,row.created_by_actor]))[0];
    if(!issuer?.active||issuer.version!==row.issuer_membership_version||issuer.person_id!==row.created_by_person||!['owner','judge'].includes(issuer.role)||issuer.role==='judge'&&!['investigator','viewer'].includes(row.role))throw new HttpError(410,'INVITATION_AUTHORITY_CHANGED','The authority that issued this link changed. A current owner must issue a new invitation.');
    return {row,workspace};
  }
  async previewInvitation(token:string):Promise<InvitationPreview>{
    return this.db.transaction(async tx=>{const {row,workspace}=await this.validInvitation(tx,token);if(row.accepted_at)throw new HttpError(410,'INVITATION_ALREADY_ACCEPTED','This invitation has already been accepted.');return {id:row.id,workspaceName:workspace.name,merchantName:workspace.merchant_name,organizationName:workspace.organization_name,role:row.role,expiresAt:iso(row.expires_at),accessDays:7,disclosure:'This private link grants the stated workspace role to its holder. Accepting it declares a display name; it does not verify a person or email address.'};});
  }
  async acceptInvitation(credential:WorkspaceCredential|null,input:unknown):Promise<WorkspaceCookieResult>{
    const value=parsed(z.strictObject({requestId:command,token:z.string().regex(/^[a-f0-9]{64}$/),displayName:title}),input),requestHash=hash(value);
    return this.db.transaction(async tx=>{
      // All changes for an organization serialize before locking the invitation,
      // using the same order as role changes and link revocation.
      const initial=(await tx.query<{organization_id:string}>('SELECT organization_id FROM gh_workspace_invitations WHERE token_hash=$1',[tokenHash(value.token)]))[0];
      if(!initial)throw new HttpError(410,'INVITATION_UNAVAILABLE','This access invitation is not available.');
      let access:AccessRow|null=null;
      if(credential)access=await this.access(tx,credential,false,true);
      await this.lockOrganization(tx,initial.organization_id);
      const {row,workspace}=await this.validInvitation(tx,value.token,true);
      if(row.accepted_at){
        if(row.accept_request_id!==value.requestId||row.accept_request_hash!==requestHash||access&&access.person_id!==row.accepted_by_person)throw new HttpError(410,'INVITATION_ALREADY_ACCEPTED','This single-use invitation has already been accepted.');
        const result=this.secrets.open<{cookie:WorkspaceCookieResult;accessId:string}>('invitation-acceptance',row.id,row.private_acceptance!);
        const current=(await tx.query('SELECT id FROM gh_workspace_access_sessions WHERE id=$1 AND active=true AND expires_at>now() AND context_id=$2 AND current_session_hash=$3 FOR SHARE',[result.accessId,result.cookie.selection.contextId,tokenHash(result.cookie.token)]))[0];
        if(!current)throw new HttpError(409,'INVITATION_ACCEPTANCE_SUPERSEDED','A later workspace selection or expired session replaced this acceptance. Open the current directory.');
        const active=(await tx.query('SELECT actor_id FROM gh_actor_people p JOIN gh_memberships m USING(tenant_id,actor_id) WHERE p.tenant_id=$1 AND p.person_id=$2 AND m.active=true',[row.tenant_id,row.accepted_by_person]))[0];
        if(!active)throw new HttpError(403,'WORKSPACE_MEMBERSHIP_REQUIRED','This accepted membership has since been revoked.');
        return result.cookie;
      }
      if(access&&(access.current_session_hash!==credential!.sessionHash||access.context_id!==credential!.contextId))throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','Your workspace selection changed. Reopen this invitation from the current browser context.');
      const personId=access?.person_id??'person-'+randomUUID();
      if(!access)await tx.query('INSERT INTO gh_people(id,display_name) VALUES($1,$2)',[personId,value.displayName]);
      else await tx.query('UPDATE gh_people SET display_name=$2 WHERE id=$1',[personId,value.displayName]);
      const previous=(await tx.query<{actor_id:string;role:Role;version:number;active:boolean}>(`SELECT m.actor_id,m.role,m.version,m.active FROM gh_actor_people p
        JOIN gh_memberships m USING(tenant_id,actor_id) WHERE p.person_id=$1 AND p.tenant_id=$2 FOR UPDATE OF m`,[personId,row.tenant_id]))[0];
      const actor:Actor=previous?{id:previous.actor_id,tenantId:row.tenant_id,role:previous.active?previous.role:row.role,membershipVersion:previous.version+(previous.active?0:1)}:{id:personId,tenantId:row.tenant_id,role:row.role,membershipVersion:1};
      if(!previous){await tx.query('INSERT INTO gh_actor_people(tenant_id,actor_id,person_id) VALUES($1,$2,$3)',[row.tenant_id,actor.id,personId]);await tx.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,1)',[row.tenant_id,actor.id,row.role]);}
      else if(!previous.active)await tx.query('UPDATE gh_memberships SET role=$3,active=true,version=version+1 WHERE tenant_id=$1 AND actor_id=$2',[row.tenant_id,actor.id,row.role]);
      await tx.query(`INSERT INTO gh_organization_members(organization_id,person_id,role) VALUES($1,$2,'member')
        ON CONFLICT(organization_id,person_id) DO UPDATE SET role=CASE WHEN gh_organization_members.active THEN gh_organization_members.role ELSE 'member' END,
        active=true,version=gh_organization_members.version+CASE WHEN gh_organization_members.active THEN 0 ELSE 1 END`,[row.organization_id,personId]);
      let cookie:WorkspaceCookieResult,accessId:string;
      if(access){accessId=access.id;cookie=await this.select(tx,access,row.tenant_id);}
      else{
        accessId='access-'+randomUUID();const token=randomBytes(32).toString('hex'),sessionHash=tokenHash(token),contextId=randomUUID(),expiresAt=new Date(Date.now()+7*86400000).toISOString();
        await tx.query('INSERT INTO gh_sessions(token_hash,actor,expires_at) VALUES($1,$2::jsonb,$3)',[sessionHash,JSON.stringify({...actor,...(workspace.source_kind==='sample'?{grantId:'sample-workspace-'+row.tenant_id}:{})}),expiresAt]);
        await tx.query('INSERT INTO gh_workspace_access_sessions(id,person_id,current_session_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$5)',[accessId,personId,sessionHash,contextId,expiresAt]);
        await tx.query('INSERT INTO gh_workspace_session_links(session_hash,access_id,tenant_id,actor_id,private_token) VALUES($1,$2,$3,$4,$5)',[sessionHash,accessId,row.tenant_id,actor.id,this.secrets.seal('session-token',sessionHash,token)]);
        cookie={token,expiresAt,selection:{workspaceId:row.tenant_id,contextId}};
      }
      await tx.query('UPDATE gh_workspace_invitations SET accepted_at=now(),accepted_by_person=$2,accept_request_id=$3,accept_request_hash=$4,private_acceptance=$5 WHERE id=$1',[row.id,personId,value.requestId,requestHash,this.secrets.seal('invitation-acceptance',row.id,{cookie,accessId})]);
      await audit(tx,actor,'invitation.accepted','Accepted a private workspace access invitation',row.id,{issuedRole:row.role,effectiveRole:actor.role,issuer:row.created_by_actor,identityVerification:'self_declared',sessionExpiresAt:cookie.expiresAt});
      return cookie;
    });
  }
}
