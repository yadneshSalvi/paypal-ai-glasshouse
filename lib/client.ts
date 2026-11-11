import {workspaceScope,type WorkspaceTicket} from './workspace-context';
export class ApiError extends Error {constructor(message:string,readonly code:string,readonly status:number){super(message);}}
const accessErrors=new Set(['WORKSPACE_CONTEXT_CHANGED','WORKSPACE_ACCESS_EXPIRED','SESSION_EXPIRED','MEMBERSHIP_REVOKED','CURRENT_AUTHORITY_REQUIRED','AGENT_SESSION_EXPIRED','WORKSPACE_SESSION_EXPIRED','WORKSPACE_MEMBERSHIP_REQUIRED','WORKSPACE_ADMISSION_DENIED']);
async function responseError(response:Response){
  const result=await response.json().catch(()=>({})),error=new ApiError(result.error||'The request could not finish.',result.code||'REQUEST_FAILED',response.status);
  if(accessErrors.has(error.code))workspaceScope.hold(error.message);return error;
}
async function jsonRequest<T>(path:string,body:unknown,method:string|undefined,signal:AbortSignal|undefined,ticket:WorkspaceTicket|null,contextId:string|null):Promise<T>{
  const response=await fetch('/api/'+path,{method:method||(body===undefined?'GET':'POST'),headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(contextId?{'X-Glasshouse-Context':contextId}:{})},body:body===undefined?undefined:JSON.stringify(body),signal,cache:'no-store'});
  if(ticket)workspaceScope.assert(ticket);
  if(!response.ok)throw await responseError(response);
  const result=await response.json();if(ticket)workspaceScope.assert(ticket);return result as T;
}
export async function api<T>(path:string,body?:unknown,method?:string,signal?:AbortSignal):Promise<T>{
  const bootstrap=path==='session'||path==='session/new';
  const ticket=bootstrap?null:workspaceScope.capture();
  return jsonRequest<T>(path,body,method,signal,ticket,ticket?.contextId??null);
}
/** Directory and explicit access recovery remain available when an earlier
 * workspace is held. The server still checks the current context and roles. */
export function workspaceApi<T>(path:string,body?:unknown,contextId?:string,signal?:AbortSignal):Promise<T>{
  return jsonRequest<T>('workspaces'+(path?'/'+path:''),body,undefined,signal,null,contextId??workspaceScope.snapshot().contextId);
}
export function scopedApiUrl(path:string){const context=workspaceScope.snapshot().contextId;return '/api/'+path+(context?(path.includes('?')?'&':'?')+'workspaceContext='+encodeURIComponent(context):'');}
export async function downloadApi(path:string,filename:string){
  const ticket=workspaceScope.capture();const response=await fetch('/api/'+path,{headers:ticket.contextId?{'X-Glasshouse-Context':ticket.contextId}:{},cache:'no-store'});workspaceScope.assert(ticket);
  if(!response.ok)throw await responseError(response);const blob=await response.blob();workspaceScope.assert(ticket);
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export const money=(minor:number,currency='USD')=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:minor%100===0?0:2}).format(minor/100);
export const dateLabel=(iso:string)=>new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'});
export const sourceLabel=(source:string)=>({sample:'Sample',fixture_shipping:'Fixture shipping',fixture_support:'Fixture support',sandbox:'Live · Sandbox',replay:'Replay',modelled:'Modelled'}[source] || source);
