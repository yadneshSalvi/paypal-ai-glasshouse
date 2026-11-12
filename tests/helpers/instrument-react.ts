import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {JSDOM,VirtualConsole} from 'jsdom';
import React,{act,createElement} from 'react';
import type {AgReportHistory,AgStudioApi} from 'ag-studio';
import type {Snapshot} from '../../packages/domain/types';
import type {GlasshouseRegistry,StudioBridge} from '../../packages/studio/types';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

/** Real production React/AG Studio boundary. DOM measurements let the installed
 * library mount its widgets; they do not qualify browser layout or pixels. */
export async function productionInstrumentStudio(t:TestContext,snapshot:Snapshot,history:AgReportHistory<GlasshouseRegistry>){
  const domErrors:string[]=[],virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',(error:Error)=>domErrors.push(error.message));
  const dom=new JSDOM('<!doctype html><html><body><div id="production-studio"></div></body></html>',{url:'http://isolated.test',pretendToBeVisual:true,virtualConsole}),win=dom.window;
  const values:Record<string,unknown>={window:win,document:win.document,navigator:win.navigator,HTMLElement:win.HTMLElement,Element:win.Element,Node:win.Node,ShadowRoot:win.ShadowRoot,HTMLInputElement:win.HTMLInputElement,HTMLTextAreaElement:win.HTMLTextAreaElement,HTMLSelectElement:win.HTMLSelectElement,MutationObserver:win.MutationObserver,DOMParser:win.DOMParser,DOMRect:win.DOMRect,getComputedStyle:win.getComputedStyle.bind(win),requestAnimationFrame:win.requestAnimationFrame.bind(win),cancelAnimationFrame:win.cancelAnimationFrame.bind(win),React,IS_REACT_ACT_ENVIRONMENT:true};
  const previous=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{configurable:true,value});
  const rectangle=()=>new win.DOMRect(0,0,1200,900);
  for(const name of ['offsetWidth','clientWidth'])Object.defineProperty(win.HTMLElement.prototype,name,{configurable:true,get:()=>1200});
  for(const name of ['offsetHeight','clientHeight'])Object.defineProperty(win.HTMLElement.prototype,name,{configurable:true,get:()=>900});
  win.HTMLElement.prototype.getBoundingClientRect=rectangle;
  win.HTMLElement.prototype.getClientRects=function(){return [rectangle()] as unknown as DOMRectList;};
  class ResizeObserverFixture{
    private targets=new Set<Element>();
    constructor(private readonly callback:ResizeObserverCallback){}
    observe(target:Element){this.targets.add(target);queueMicrotask(()=>{if(this.targets.has(target))this.callback([{target,contentRect:rectangle(),borderBoxSize:[{inlineSize:1200,blockSize:900}],contentBoxSize:[{inlineSize:1200,blockSize:900}]} as unknown as ResizeObserverEntry],this as unknown as ResizeObserver);});}
    unobserve(target:Element){this.targets.delete(target);}
    disconnect(){this.targets.clear();}
  }
  previous.set('ResizeObserver',Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'));
  Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:ResizeObserverFixture});
  Object.defineProperty(win,'ResizeObserver',{configurable:true,value:ResizeObserverFixture});
  Object.defineProperty(win,'matchMedia',{configurable:true,value:(query:string)=>({matches:false,media:query,onchange:null,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent:()=>true})});
  win.scrollTo=()=>{};
  const networkAttempts:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{networkAttempts.push(typeof input==='string'?input:String(input instanceof URL?input:input.url));throw new Error('React instrument qualification permits no network dispatch.');});
  const {createRoot}=await import('react-dom/client'),{default:StudioWorkspace}=await import('../../packages/studio/workspace');
  const root=createRoot(win.document.getElementById('production-studio')!);
  let api:AgStudioApi<GlasshouseRegistry>|null=null,destroyed=false;
  const times:Parameters<StudioBridge['onTime']>[]=[],branchReviews:Parameters<StudioBridge['onBranch']>[]=[],orders:string[]=[],errors:string[]=[],committed:string[]=[],counts=new Map<string,{count:number;selected:number}>();
  const bridge:StudioBridge={getSnapshot:()=>snapshot,onTime:(...args)=>times.push(args),onOrder:id=>orders.push(id),onBranch:(...args)=>branchReviews.push(args),onRevision(){},onEvent(){},onApi:value=>{api=value;},onHistory(){},onError:reason=>errors.push(reason),onWidgetReady:(id,_hash,count,selected)=>counts.set(id,{count,selected})};
  const flush=async()=>{await act(async()=>{await tick();await new Promise(resolve=>setTimeout(resolve,15));});};
  const until=async(check:()=>boolean,message:string)=>{for(let attempt=0;attempt<160&&!check();attempt++)await flush();assert(check(),message+'; native errors: '+errors.join(' | ')+'; DOM errors: '+domErrors.join(' | ')+'; visible text: '+win.document.body.textContent?.slice(0,1600)+'; mounted instruments: '+win.document.querySelectorAll('[data-widget]').length);};
  const destroy=async()=>{
    if(destroyed)return;destroyed=true;
    await act(async()=>{root.unmount();await tick();});
    // NativeStudio releases its nested React root in a microtask. Keep the DOM,
    // RAF and ResizeObserver available until that release and its effects finish.
    for(let attempt=0;attempt<3;attempt++)await act(async()=>{await tick();await new Promise(resolve=>setTimeout(resolve,0));});
    dom.window.close();
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  };
  t.after(destroy);
  await act(async()=>{root.render(createElement(StudioWorkspace,{snapshot,license:process.env.AG_STUDIO_LICENSE_KEY??'',bridge,editable:false,readOnly:true,history,historyVersion:1,onSaveReady(){},onSaved(){},onSaveError:reason=>{if(reason)errors.push(reason);},onHarness(){},onCommitted:hash=>committed.push(hash),onHistoryStatus(){}}));await tick();});
  await until(()=>api!==null&&committed.includes(snapshot.hash),'The actual production StudioWorkspace did not commit its real instruments');
  return {win,root,bridge,times,branchReviews,orders,errors,committed,counts,networkAttempts,flush,until,destroy,get api(){assert(api);return api;}};
}
