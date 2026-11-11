'use client';
import {useId,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';
import {useDialogFocus} from './dialog-focus';

export function PrivateDialog({title,eyebrow,onClose,children,wide=false,returnFocusKey,contentKey=title,className=''}:{title:string;eyebrow:string;onClose():void;children:ReactNode;wide?:boolean;returnFocusKey?:string;contentKey?:string;className?:string}){
  const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null),titleId=useId();
  useDialogFocus(dialog,{heading,returnFocusKey,contentKey});
  return <dialog ref={dialog} aria-labelledby={titleId} className={'modal private-dialog '+(wide?'wide ':'')+className} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><div className="modal-content"><header className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></header>{children}</div></dialog>;
}
