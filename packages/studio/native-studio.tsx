'use client';
import {useLayoutEffect,useRef} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {AgStudio,type AgStudioReactProperties} from 'ag-studio-react';
import type {GlasshouseRegistry} from './types';

interface StudioLease {
  root:Root;
  generation:number;
  started:boolean;
  ready:boolean;
  disposeAfterReady:(()=>void)|null;
  timeout:ReturnType<typeof setTimeout>|null;
}

/**
 * Studio 3.1 starts asynchronously but still admits initial history after its
 * widget registry has been destroyed. Keep the native React root alive through
 * Strict Mode's effect replay, and finish initial admission before final disposal.
 * The surrounding application retains Strict Mode; no history is filtered/reset.
 */
export function NativeStudio(props:AgStudioReactProperties<GlasshouseRegistry>) {
  const element=useRef<HTMLDivElement>(null);
  const leaseRef=useRef<StudioLease|null>(null);
  const current=useRef(props);current.current=props;

  useLayoutEffect(()=>{
    if(!element.current)return;
    const lease=leaseRef.current??{
      root:createRoot(element.current),generation:0,started:false,ready:false,
      disposeAfterReady:null,timeout:null,
    };
    leaseRef.current=lease;
    lease.generation++;
    lease.disposeAfterReady=null;
    if(lease.timeout)clearTimeout(lease.timeout);
    return()=>{
      const generation=++lease.generation;
      const dispose=()=>{
        if(lease.generation!==generation||leaseRef.current!==lease)return;
        if(lease.timeout)clearTimeout(lease.timeout);
        lease.root.unmount();leaseRef.current=null;
      };
      queueMicrotask(()=>{
        if(lease.generation!==generation)return;
        if(!lease.started||lease.ready)dispose();
        else{
          lease.disposeAfterReady=()=>queueMicrotask(dispose);
          // A failed engine must not retain an unattached React root indefinitely.
          lease.timeout=setTimeout(dispose,15_000);
        }
      });
    };
  },[]);

  useLayoutEffect(()=>{
    const lease=leaseRef.current;
    if(!lease)return;
    lease.root.render(<AgStudio<GlasshouseRegistry> {...props}
      onApiReady={event=>{lease.started=true;if(!lease.disposeAfterReady)current.current.onApiReady?.(event);}}
      onStudioReady={event=>{
        lease.ready=true;
        if(lease.disposeAfterReady)lease.disposeAfterReady();
        else current.current.onStudioReady?.(event);
      }}
    />);
  });
  return <div ref={element} className="native-studio-mount"/>;
}
