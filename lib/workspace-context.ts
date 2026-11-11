export interface ClientWorkspaceState {contextId:string|null;workspaceId:string|null;generation:number;held:boolean;reason:string|null}
export interface WorkspaceTicket {contextId:string|null;generation:number}
export class WorkspaceContextError extends Error {readonly code='WORKSPACE_CONTEXT_CHANGED';constructor(message='This tab belongs to an earlier workspace. Choose a workspace to continue.'){super(message);}}

/** Every ordinary request captures this tab's admitted context. A changed
 * browser cookie can never silently redirect an old request into another room. */
export class ClientWorkspaceScope {
  private state:ClientWorkspaceState={contextId:null,workspaceId:null,generation:0,held:false,reason:null};
  private listeners=new Set<()=>void>();
  snapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  private update(value:ClientWorkspaceState){this.state=value;for(const listener of this.listeners)listener();}
  admit(contextId:string,workspaceId:string){
    if(!contextId||!workspaceId)throw new WorkspaceContextError('The server did not provide a complete workspace context.');
    if(this.state.contextId===contextId&&this.state.workspaceId===workspaceId&&!this.state.held)return;
    this.update({contextId,workspaceId,generation:this.state.generation+1,held:false,reason:null});
  }
  hold(reason:string){if(this.state.held)return;this.update({...this.state,generation:this.state.generation+1,held:true,reason});}
  capture():WorkspaceTicket {if(this.state.held)throw new WorkspaceContextError(this.state.reason??undefined);return {contextId:this.state.contextId,generation:this.state.generation};}
  assert(ticket:WorkspaceTicket){if(this.state.held||ticket.generation!==this.state.generation||ticket.contextId!==this.state.contextId)throw new WorkspaceContextError(this.state.reason??'The workspace changed before this result arrived. Its saved evidence remains in the original workspace.');}
  observe(contextId:string){if(this.state.contextId&&contextId!==this.state.contextId)this.hold('Another tab changed workspace access. Your earlier workspace is held here; choose a workspace to continue.');}
}
export const workspaceScope=new ClientWorkspaceScope();
const signalName='glasshouse-workspace-selection-v1';
function announce(contextId:string,workspaceId:string){
  if(typeof window==='undefined')return;
  const value={contextId,workspaceId,at:Date.now(),nonce:crypto.randomUUID()};
  try{localStorage.setItem(signalName,JSON.stringify(value));}catch{/* An explicit request header remains authoritative without browser storage. */}
}
export function admitWorkspace(contextId:string,workspaceId:string){workspaceScope.admit(contextId,workspaceId);announce(contextId,workspaceId);}
export function announceWorkspaceChange(contextId:string,workspaceId:string){
  // Do not lend the destination context to still-mounted controls from the old
  // workspace during navigation. Only the next page's bootstrap can admit it.
  workspaceScope.hold('Opening the selected workspace. Its saved context is being admitted.');announce(contextId,workspaceId);
}
export function connectWorkspaceSignals(){
  const receive=(event:StorageEvent)=>{if(event.key!==signalName||!event.newValue)return;try{const value=JSON.parse(event.newValue);if(typeof value.contextId==='string')workspaceScope.observe(value.contextId);}catch{/* Ignore unrelated or malformed local storage. */}};
  window.addEventListener('storage',receive);return()=>window.removeEventListener('storage',receive);
}
