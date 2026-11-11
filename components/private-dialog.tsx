'use client';
import {useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';

export function PrivateDialog({title,eyebrow,onClose,children,wide=false,returnFocusKey}:{title:string;eyebrow:string;onClose():void;children:ReactNode;wide?:boolean;returnFocusKey?:string}){
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLElement|null>(null),titleId=useId();
  useLayoutEffect(()=>{
    const element=dialog.current;if(!element)return;
    if(!trigger.current&&document.activeElement instanceof HTMLElement)trigger.current=document.activeElement;
    element.showModal();return()=>{element.close();queueMicrotask(()=>{
      if(element.isConnected&&element.open)return;
      const visible=(target:HTMLElement|null|undefined):target is HTMLElement=>!!target&&target!==document.body&&target.isConnected&&target.getClientRects().length>0&&!target.matches(':disabled')&&getComputedStyle(target).visibility!=='hidden';
      const fallback=returnFocusKey?document.querySelector<HTMLElement>(`[data-focus-return="${CSS.escape(returnFocusKey)}"]`):null;
      (visible(trigger.current)?trigger.current:visible(fallback)?fallback:null)?.focus({preventScroll:true});
    });};
  },[returnFocusKey]);
  return <dialog ref={dialog} aria-labelledby={titleId} className={'modal private-dialog '+(wide?'wide':'')} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><div className="modal-content"><header className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></header>{children}</div></dialog>;
}
