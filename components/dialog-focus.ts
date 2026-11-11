'use client';
import {useCallback,useLayoutEffect,useRef,type RefObject} from 'react';
import {workspaceScope} from '@/lib/workspace-context';

function visible(target:HTMLElement|null|undefined):target is HTMLElement{
  return !!target&&target!==document.body&&target!==document.documentElement&&target.isConnected&&target.getClientRects().length>0&&!target.matches(':disabled')&&!target.closest('[inert],[hidden]')&&getComputedStyle(target).visibility!=='hidden';
}
const pendingReturns=new WeakMap<Document,{target:HTMLElement|null;key?:string}>();

/** A dialog owns initial/lost focus, never focus deliberately moved into another
 * control or a nested dialog. A replacement dialog also owns its own heading. */
export function useDialogFocus(dialog:RefObject<HTMLDialogElement|null>,{returnFocusKey,contentKey,heading,initialFocus='heading'}:{returnFocusKey?:string;contentKey?:string;heading?:RefObject<HTMLHeadingElement|null>;initialFocus?:'heading'|'native'}={}){
  const trigger=useRef<HTMLElement|null>(null),previousContent=useRef<string|undefined>(undefined);
  useLayoutEffect(()=>{
    const element=dialog.current;if(!element)return;
    if(!trigger.current&&document.activeElement instanceof HTMLElement)trigger.current=document.activeElement;
    element.showModal();
    if(initialFocus==='heading')heading?.current?.focus({preventScroll:true});
    return()=>{
      const restoration={target:trigger.current,key:trigger.current?.dataset.focusReturn??returnFocusKey};
      pendingReturns.set(document,restoration);
      element.close();
      queueMicrotask(()=>{
        if(pendingReturns.get(document)===restoration)pendingReturns.delete(document);
        if(element.isConnected&&element.open)return;
        const original=trigger.current,key=original?.dataset.focusReturn??returnFocusKey;
        const openDialogs=Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter(visible);
        const canReturn=(target:HTMLElement|null|undefined):target is HTMLElement=>visible(target)&&(!openDialogs.length||openDialogs.some(parent=>parent.contains(target)));
        const active=document.activeElement;
        // Closing one dialog must not steal the new dialog's deliberate focus.
        if(active instanceof HTMLElement&&active!==original&&openDialogs.some(parent=>parent.contains(active))&&visible(active))return;
        const fallback=key?Array.from(document.querySelectorAll<HTMLElement>(`[data-focus-return="${CSS.escape(key)}"]`)).find(canReturn):null;
        (canReturn(original)?original:fallback)?.focus({preventScroll:true});
      });
    };
  },[dialog,heading,initialFocus,returnFocusKey]);
  useLayoutEffect(()=>{
    const element=dialog.current;if(!element?.open)return;
    const active=document.activeElement,changed=previousContent.current!==contentKey;
    previousContent.current=contentKey;
    if(active instanceof HTMLElement&&active!==element&&!element.contains(active)&&visible(active)&&active.closest('dialog[open]'))return;
    const lost=!(active instanceof HTMLElement)||!element.contains(active)||!visible(active);
    if((changed||lost)&&initialFocus==='heading'){
      const pending=pendingReturns.get(document),fallback=pending?.key?document.querySelector<HTMLElement>(`[data-focus-return="${CSS.escape(pending.key)}"]`):null;
      const returning=visible(pending?.target)?pending.target:visible(fallback)?fallback:null;
      // The parent can render in the same commit that closes its nested plan.
      // Complete that pending return before applying the generic heading fallback.
      (lost&&!changed&&returning&&element.contains(returning)?returning:heading?.current)?.focus({preventScroll:true});
    }
  });
}

/** Capture both the rendered resource and admitted workspace before an async
 * action. Late responses may remain saved on the server, but cannot reopen or
 * update a closed/replaced dialog or a different workspace. */
export function useDialogRequestBoundary(identity:string){
  const instance=useRef<object|null>(null);
  useLayoutEffect(()=>{const token={};instance.current=token;return()=>{if(instance.current===token)instance.current=null;};},[identity]);
  return useCallback(()=>{
    const token=instance.current,workspace=workspaceScope.snapshot();
    return ()=>token!==null&&instance.current===token&&workspaceScope.snapshot()===workspace&&!workspace.held;
  },[]);
}
