'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowRight,Clock3,KeyRound,Leaf,LoaderCircle,ShieldCheck} from 'lucide-react';
import {ApiError,dateLabel,workspaceApi} from '@/lib/client';
import {admitWorkspace,announceWorkspaceChange} from '@/lib/workspace-context';
import type {InvitationPreview,WorkspaceBootstrap,WorkspaceSwitch} from '@/packages/workspaces/types';
type Acceptance={requestId:string;displayName:string;newBrowserAccess:boolean};

export function WorkspaceInvitationPage(){
  const [preview,setPreview]=useState<InvitationPreview|null>(null),[existing,setExisting]=useState<WorkspaceBootstrap|null>(null);
  const [name,setName]=useState(''),[error,setError]=useState<string|null>(null),[accessNote,setAccessNote]=useState<string|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
  const [recovery,setRecovery]=useState<Acceptance|null>(null),token=useRef(''),storageKey=useRef(''),requestRef=useRef<Acceptance|null>(null),running=useRef(false);
  useEffect(()=>{
    let active=true;const value=new URLSearchParams(location.hash.slice(1)).get('access');
    if(!value||!/^[a-f0-9]{64}$/.test(value)){setError('Open the complete private invitation supplied by a workspace owner.');setReady(true);return;}
    token.current=value;
    void (async()=>{
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));storageKey.current='glasshouse-invitation-'+Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('');
      let saved:Acceptance|null=null;try{saved=JSON.parse(sessionStorage.getItem(storageKey.current)||'null');}catch{/* An unavailable browser store does not grant access. */}
      if(saved&&typeof saved.requestId==='string'&&typeof saved.displayName==='string'&&typeof saved.newBrowserAccess==='boolean'){requestRef.current=saved;if(active){setRecovery(saved);setName(saved.displayName);}}
      const access=await workspaceApi<WorkspaceBootstrap>('bootstrap',{}).catch(reason=>{if(active&&reason instanceof ApiError&&reason.code!=='SESSION_REQUIRED')setAccessNote(reason.message);return null;});
      if(access){admitWorkspace(access.identity.contextId,access.workspace.id);if(active){setExisting(access);if(!saved)setName(access.identity.displayName);}}
      try{const invitation=await workspaceApi<InvitationPreview>('invitations/preview',{token:value});if(active)setPreview(invitation);}catch(reason){
        // A lost acceptance response has already consumed the link. Its exact
        // request can still recover the originally created browser session.
        if(!(saved&&reason instanceof ApiError&&reason.code==='INVITATION_ALREADY_ACCEPTED'))throw reason;
      }
    })().catch(reason=>{if(active)setError(reason.message);}).finally(()=>{if(active)setReady(true);});
    return()=>{active=false;};
  },[]);
  const accept=async()=>{
    if(running.current)return;running.current=true;setBusy(true);setError(null);
    const request=requestRef.current??{requestId:crypto.randomUUID(),displayName:name.trim(),newBrowserAccess:!existing};requestRef.current=request;setRecovery(request);
    try{sessionStorage.setItem(storageKey.current,JSON.stringify(request));}catch{/* Keep the same request identity in memory if storage is disabled. */}
    try{
      const selected=await workspaceApi<WorkspaceSwitch>('invitations/accept',{...request,token:token.current},existing?.identity.contextId);
      try{sessionStorage.removeItem(storageKey.current);}catch{/* Navigation can proceed after an independently checked acceptance. */}
      // Remove the bearer fragment from the current history entry only after
      // acceptance has returned the exact selected workspace.
      history.replaceState({},'', '/invite');announceWorkspaceChange(selected.contextId,selected.workspaceId);location.assign('/');
    }catch(reason){setError(reason instanceof Error?reason.message:'The original acceptance result is held. Retry its exact request.');}finally{running.current=false;setBusy(false);}
  };
  return <main className="invitation-page"><a className="invitation-brand" href="/"><Leaf size={24}/>glasshouse</a><div className="invitation-orbit" aria-hidden="true"><span/><span/><KeyRound size={35}/></div><section className="invitation-card"><span className="eyebrow">AN INVITATION TO LOOK CLOSER</span><h1>{preview?'Your place in the story.':recovery?'Return to your saved access.':'Private workspace access.'}</h1>{!ready?<div className="directory-loading"><LoaderCircle className="spin"/><p>Checking the invitation and its current authority…</p></div>:<>
    {error&&<div className="workspace-message is-error" role="alert">{error}</div>}
    {accessNote&&<p className="workspace-access-note">{accessNote} Accepting below explicitly creates new browser access for this invitation.</p>}
    {preview&&<><div className="invitation-workspace"><span className="eyebrow">{preview.organizationName}</span><h2>{preview.workspaceName}</h2><p>{preview.merchantName}</p><span className="invitation-role"><KeyRound size={14}/>{preview.role} access</span></div><p>{preview.disclosure}</p><div className="invitation-expiry"><Clock3 size={15}/><span>Accept before {dateLabel(preview.expiresAt)} UTC.<br/>{existing?'Your existing browser access keeps its original expiry.':'New browser access lasts seven days.'}</span></div></>}
    {(preview||recovery)&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void accept();}}><label>Your display name<input value={name} onChange={event=>setName(event.target.value)} minLength={2} maxLength={80} required disabled={busy||!!recovery} autoComplete="nickname"/></label><button className="button primary" disabled={busy||!name.trim()}>{busy?<LoaderCircle className="spin" size={16}/>:<ArrowRight size={16}/>}{recovery?'Recover original acceptance':existing?'Accept with this browser access':'Accept new browser access'}</button></form>}
    <p className="invitation-foot"><ShieldCheck size={14}/>The exact workspace role is checked again when you accept. Existing payment approvals are never created by this link.</p><a className="text-action" href="/">Return to Glasshouse<ArrowRight size={14}/></a>
  </>}</section></main>;
}
