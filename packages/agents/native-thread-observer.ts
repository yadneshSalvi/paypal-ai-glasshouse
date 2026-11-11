import type {AgAiChatMessage,AgAiChatSession,AgAiHarness} from 'ag-studio';

export interface NativeThreadView {
  state:'waiting'|'loading'|'ready'|'unavailable';
  session:AgAiChatSession|null;
  messages:readonly AgAiChatMessage[];
}

/** Observe actual native sessions, including a delegated re-entry that replaces
 * an earlier hydrated session under the same thread id. Nothing is reconstructed
 * from model receipts or invented when the native thread has not registered yet. */
export function observeNativeThread(harness:AgAiHarness,threadId:string,onChange:(view:NativeThreadView)=>void){
  let disposed=false,opening=false;
  let bound:AgAiChatSession|null=null;
  const publish=()=>{if(!disposed&&bound)onChange({state:'ready',session:bound,messages:[...bound.messages]});};
  const bind=(session:AgAiChatSession)=>{
    if(disposed)return;
    if(bound!==session){bound?.removeEventListener('changed',publish);bound=session;bound.addEventListener('changed',publish);}
    publish();
  };
  const refresh=()=>{
    if(disposed)return;
    const live=harness.getSession?.(threadId);
    if(live){bind(live);return;}
    if(!harness.getThread(threadId)){
      bound?.removeEventListener('changed',publish);bound=null;
      onChange({state:'waiting',session:null,messages:[]});return;
    }
    if(opening)return;
    opening=true;onChange({state:'loading',session:bound,messages:bound?[...bound.messages]:[]});
    void harness.openThread(threadId).then(session=>{
      opening=false;if(disposed)return;
      // The async history read can finish after registerSession has installed a
      // new live delegate. Its current session is authoritative at this point.
      const current=harness.getSession?harness.getSession(threadId):session;
      if(current)bind(current);else refresh();
    }).catch(()=>{
      opening=false;if(disposed)return;
      const current=harness.getSession?.(threadId);
      if(current){bind(current);return;}
      onChange({state:harness.getThread(threadId)?'unavailable':'waiting',session:bound,messages:bound?[...bound.messages]:[]});
    });
  };
  harness.addEventListener('changed',refresh);
  refresh();
  return ()=>{disposed=true;harness.removeEventListener('changed',refresh);bound?.removeEventListener('changed',publish);bound=null;};
}
