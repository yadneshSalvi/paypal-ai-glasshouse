import {actor,authenticatedSessionHash,bindSessionAuthority,requestSessionToken,sessionCookie,assertRequestCurrent} from '@/lib/server/auth';
import {body,HttpError,problem,sameOrigin} from '@/lib/server/errors';
import {workspaceRuntime} from '@/lib/server/workspaces/runtime';
import type {WorkspaceCookieResult,WorkspaceCredential} from '@/lib/server/workspaces/service';
import type {WorkspaceSummary} from '@/packages/workspaces/types';

export const runtime='nodejs';export const dynamic='force-dynamic';
type Params={params:Promise<{path?:string[]}>};
function credential(request:Request):WorkspaceCredential{return {sessionHash:authenticatedSessionHash(request),contextId:request.headers.get('X-Glasshouse-Context')??undefined};}
function json(value:unknown,headers:Record<string,string>={}){return Response.json(value,{headers:{'Cache-Control':'private, no-store',...headers}});}
async function dispatch(request:Request,context:Params){
  const app=await workspaceRuntime(),path=(await context.params).path??[],key=path.join('/'),method=request.method;
  if(method!=='GET')sameOrigin(request);
  if(key==='bootstrap'&&method==='POST'){
    const current=await actor(request,{allowWorkspaceBootstrap:true}),token=requestSessionToken(request)!;
    const workspace=await app.admit(current,token);await bindSessionAuthority(request,current,token,workspace.identity.contextId);await assertRequestCurrent(request);return json(workspace);
  }
  if(key==='invitations/preview'&&method==='POST'){
    const input=await body<{token:string}>(request);if(typeof input.token!=='string')throw new HttpError(400,'INVITATION_REQUIRED','Open a complete private access invitation.');
    return json(await app.previewInvitation(input.token));
  }
  const selected=async(value:WorkspaceCookieResult)=>{await app.verifySelection(value);return json(value.selection,{'Set-Cookie':sessionCookie(request,value.token,value.expiresAt)});};
  if(key==='invitations/accept'&&method==='POST'){
    const input=await body<Record<string,unknown>>(request),{newBrowserAccess,...accepted}=input;
    if(newBrowserAccess!==undefined&&typeof newBrowserAccess!=='boolean')throw new HttpError(400,'INVITATION_ACCESS_CHOICE','Choose whether to use existing or new browser access.');
    return selected(await app.acceptInvitation(newBrowserAccess===true||!requestSessionToken(request)?null:credential(request),accepted));
  }
  const access=credential(request);
  if(key==='switch'&&method==='POST')return selected(await app.switchWorkspace(access,await body(request)));
  if(key===''&&method==='GET'){
    const directory=await app.directory(access);await app.verifyDisclosure(access,{contextId:directory.identity.contextId,workspaces:directory.workspaces,organizations:directory.organizations});return json(directory);
  }
  const directory=await app.directory(access),expected={contextId:directory.identity.contextId,workspaces:[] as WorkspaceSummary[],organizations:[] as {id:string;role:'owner'|'member'}[]};
  let result:unknown;
  if(key==='profile'&&method==='POST')result=await app.profile(access,await body(request));
  else if(key==='organizations'&&method==='POST'){
    const organization=await app.createOrganization(access,await body(request));expected.organizations=[{id:organization.id,role:'owner'}];result=organization;
  }else if(key==='create'&&method==='POST'){
    const workspace=await app.createWorkspace(access,await body(request));expected.workspaces=[workspace];result=workspace;
  }else if(path[0]==='organizations'&&path[1]&&method==='POST'){
    expected.organizations=[{id:path[1],role:'owner'}];
    if(path.length===2)result=await app.updateOrganization(access,path[1],await body(request));
    else if(path[2]==='members'&&path[3]&&path.length===4)result=await app.updateOrganizationMember(access,path[1],path[3],await body(request));
    else throw new HttpError(404,'WORKSPACE_ROUTE_NOT_FOUND','This organization action is not available.');
  }else if(path[0]&&path[0]!=='organizations'){
    const administration=await app.administration(access,path[0]);expected.workspaces=[administration.workspace];
    if(path.length===1&&method==='GET')result=administration;
    else if(path.length===1&&method==='POST')result=await app.updateWorkspace(access,path[0],await body(request));
    else if(path[1]==='members'&&path[2]&&path.length===3&&method==='POST')result=await app.updateMember(access,path[0],path[2],await body(request));
    else if(path[1]==='invitations'&&path.length===2&&method==='POST')result=await app.createInvitation(access,path[0],await body(request));
    else if(path[1]==='invitations'&&path[2]&&path[3]==='revoke'&&path.length===4&&method==='POST')result=await app.revokeInvitation(access,path[0],path[2],await body(request));
    else throw new HttpError(404,'WORKSPACE_ROUTE_NOT_FOUND','This workspace action is not available.');
  }else throw new HttpError(404,'WORKSPACE_ROUTE_NOT_FOUND','This workspace action is not available.');
  await app.verifyDisclosure(access,expected);return json(result);
}
async function handle(request:Request,context:Params){try{return await dispatch(request,context);}catch(error){return problem(error);}}
export const GET=handle;export const POST=handle;
