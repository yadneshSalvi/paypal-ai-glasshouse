'use client';
import {useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';

export function PrivateDialog({title,eyebrow,onClose,children,wide=false,returnFocusKey,contentKey=title}:{title:string;eyebrow:string;onClose():void;children:ReactNode;wide?:boolean;returnFocusKey?:string;contentKey?:string}){
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLElement|null>(null),heading=useRef<HTMLHeadingElement>(null),previousContent=useRef<string|null>(null),titleId=useId();
  useLayoutEffect(()=>{
    const element=dialog.current;if(!element)return;
    if(!trigger.current&&document.activeElement instanceof HTMLElement)trigger.current=document.activeElement;
    element.showModal();return()=>{element.close();queueMicrotask(()=>{
      if(element.isConnected&&element.open)return;
      const visible=(target:HTMLElement|null|undefined):target is HTMLElement=>!!target&&target!==document.body&&target!==document.documentElement&&target.isConnected&&target.getClientRects().length>0&&!target.matches(':disabled')&&!target.closest('[inert],[hidden]')&&getComputedStyle(target).visibility!=='hidden';
      const fallback=returnFocusKey?document.querySelector<HTMLElement>(`[data-focus-return="${CSS.escape(returnFocusKey)}"]`):null;
      (visible(trigger.current)?trigger.current:visible(fallback)?fallback:null)?.focus({preventScroll:true});
    });};
  },[returnFocusKey]);
  useLayoutEffect(()=>{
    const element=dialog.current;if(!element?.open)return;
    const active=document.activeElement;
    // Changing screens or disabling a saving control can strand focus on BODY.
    // Preserve active inputs; move only lost focus or a new screen to its heading.
    const focusLost=!(active instanceof HTMLElement)||!element.contains(active)||active.matches(':disabled')||!active.getClientRects().length||!!active.closest('[inert],[hidden]');
    if(previousContent.current!==contentKey||focusLost)heading.current?.focus({preventScroll:true});
    previousContent.current=contentKey;
  });
  return <dialog ref={dialog} aria-labelledby={titleId} className={'modal private-dialog '+(wide?'wide':'')} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><div className="modal-content"><header className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></header>{children}</div></dialog>;
}
