import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM,VirtualConsole} from 'jsdom';
import React,{act,createElement} from 'react';
import type {TestContext} from 'node:test';
import type {Snapshot} from '../packages/domain/types';
import type {DrillScope} from '../packages/studio/drill-report';
import {buildSnapshot} from '../packages/domain';
import {instrumentCorpus,times} from './reference/instrument-corpus';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,20));
/** Production DrillReport + NativeStudio + installed React grid. This fixture
 * constructs only fictional in-memory tables; it imports no storage/runtime API. */
async function drillHarness(t:TestContext,scope:DrillScope){
  const domErrors:string[]=[],renderErrors:string[]=[],consoleErrors:string[]=[],virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',(error:Error)=>domErrors.push(error.message));
  const dom=new JSDOM('<!doctype html><html><body><div id="actual-drill"></div></body></html>',{url:'http://synthetic-drill.test',pretendToBeVisual:true,virtualConsole}),win=dom.window;
  win.addEventListener('error',event=>{renderErrors.push(event.error instanceof Error?event.error.message:event.message);event.preventDefault();});
  t.mock.method(console,'error',(...args:unknown[])=>{const text=args.map(value=>value instanceof Error?value.message:String(value)).join(' ');consoleErrors.push(text);if(/Objects are not valid as a React child|Minified React error #31/.test(text))renderErrors.push(text);});
  const values:Record<string,unknown>={window:win,document:win.document,navigator:win.navigator,HTMLElement:win.HTMLElement,Element:win.Element,Node:win.Node,ShadowRoot:win.ShadowRoot,HTMLInputElement:win.HTMLInputElement,HTMLTextAreaElement:win.HTMLTextAreaElement,HTMLSelectElement:win.HTMLSelectElement,MutationObserver:win.MutationObserver,DOMParser:win.DOMParser,DOMRect:win.DOMRect,getComputedStyle:win.getComputedStyle.bind(win),requestAnimationFrame:win.requestAnimationFrame.bind(win),cancelAnimationFrame:win.cancelAnimationFrame.bind(win),React,IS_REACT_ACT_ENVIRONMENT:true};
  const previous=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{configurable:true,value});
  const rectangle=()=>new win.DOMRect(0,0,1200,900);
  for(const key of ['offsetWidth','clientWidth'])Object.defineProperty(win.HTMLElement.prototype,key,{configurable:true,get:()=>1200});
  for(const key of ['offsetHeight','clientHeight'])Object.defineProperty(win.HTMLElement.prototype,key,{configurable:true,get:()=>900});
  win.HTMLElement.prototype.getBoundingClientRect=rectangle;win.HTMLElement.prototype.getClientRects=()=>[rectangle()] as unknown as DOMRectList;win.scrollTo=()=>{};
  class ResizeObserverFixture{
    private targets=new Set<Element>();
    constructor(private readonly callback:ResizeObserverCallback){}
    observe(target:Element){this.targets.add(target);queueMicrotask(()=>{if(this.targets.has(target))this.callback([{target,contentRect:rectangle(),borderBoxSize:[{inlineSize:1200,blockSize:900}],contentBoxSize:[{inlineSize:1200,blockSize:900}]} as unknown as ResizeObserverEntry],this as unknown as ResizeObserver);});}
    unobserve(target:Element){this.targets.delete(target);}disconnect(){this.targets.clear();}
  }
  previous.set('ResizeObserver',Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'));Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:ResizeObserverFixture});Object.defineProperty(win,'ResizeObserver',{configurable:true,value:ResizeObserverFixture});
  Object.defineProperty(win,'matchMedia',{configurable:true,value:(query:string)=>({matches:false,media:query,onchange:null,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent:()=>true})});
  const networkAttempts:string[]=[];t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{networkAttempts.push(String(input));throw new Error('The synthetic drill regression forbids outbound requests.');});
  const {createRoot}=await import('react-dom/client'),{default:DrillReport}=await import('../packages/studio/drill-report');
  const root=createRoot(win.document.getElementById('actual-drill')!),calls:string[]=[],replacementCalls:string[]=[];let backs=0,destroyed=false;
  const render=async(replacement=false)=>{await act(async()=>{root.render(createElement(DrillReport,{scope,onBack:()=>{backs++;},onOrder:id=>(replacement?replacementCalls:calls).push(id)}));await tick();});};
  const flush=async()=>{await act(async()=>{await tick();});};
  const until=async(check:()=>boolean,label:string)=>{
    for(let attempt=0;attempt<160&&!check()&&!renderErrors.length;attempt++)await flush();
    assert.deepEqual(renderErrors,[],'The real production drill must not render DOM nodes as React children.');
    assert(check(),label+'; DOM errors: '+domErrors.join(' | ')+'; console: '+consoleErrors.join(' | ')+'; body: '+win.document.body.textContent?.slice(0,1800));
  };
  const destroy=async()=>{
    if(destroyed)return;destroyed=true;
    await act(async()=>{root.unmount();await tick();});
    // A failed original grid can precede NativeStudio's ready callback. Keep its
    // DOM alive through the existing bounded disposal fallback in that control.
    if(renderErrors.length)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15_100));});
    for(let attempt=0;attempt<3;attempt++)await flush();
    dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  };
  t.after(destroy);await render();
  return {win,calls,replacementCalls,renderErrors,networkAttempts,render,until,flush,destroy,get backs(){return backs;}};
}
function source(){return buildSnapshot(instrumentCorpus('synthetic-drill-react'),{asOf:times.end,knownAt:times.known,semanticModelVersion:'commerce-semantic-v3'});}
function scoped(snapshot:Snapshot,orderIds:string[]):DrillScope{return {title:'Orders in this exact synthetic selection',snapshot,orderIds,originLabel:'Open Orders in view records',scrollY:123,historyJson:JSON.stringify({syntheticOriginalHistory:true,undo:['original-entry'],redo:[]})};}

test('actual production drill renders React proof cells for only the fixed order scope, uses current callbacks and keeps Go Back separate',async t=>{
  const snapshot=source(),scope=scoped(snapshot,['a','d']),original=JSON.stringify(scope),h=await drillHarness(t,scope);
  await h.until(()=>[...h.win.document.querySelectorAll<HTMLButtonElement>('.drill-native-grid .native-proof-link')].filter(button=>!button.disabled).length===2,'The actual installed drill grid did not render both exact order controls');
  const buttons=()=>[...h.win.document.querySelectorAll<HTMLButtonElement>('.drill-native-grid .native-proof-link')];
  assert.deepEqual(buttons().filter(button=>!button.disabled).map(button=>button.getAttribute('aria-label')).sort(),['Open row evidence for REF-A','Open row evidence for REF-D']);
  // Aggregated money columns can add a native total row without an order ID.
  // It must keep the same disabled proof boundary as any other unbound row.
  for(const summary of buttons().filter(button=>button.disabled)){assert.equal(summary.textContent,'Unknown order');await act(async()=>{summary.click();});}
  assert.deepEqual(h.calls,[]);assert.equal(h.win.document.querySelector('.drill-native-grid button[aria-label="Open row evidence for REF-B"]'),null);
  const orderA=buttons().find(button=>button.getAttribute('aria-label')==='Open row evidence for REF-A')!;await act(async()=>{orderA.click();});assert.deepEqual(h.calls,['a']);assert.equal(h.backs,0);
  await h.render(true);await act(async()=>{buttons().find(button=>button.getAttribute('aria-label')==='Open row evidence for REF-D')!.click();});assert.deepEqual(h.calls,['a']);assert.deepEqual(h.replacementCalls,['d'],'The real cell uses the latest onOrder callback held by DrillReport.');
  const back=[...h.win.document.querySelectorAll<HTMLButtonElement>('.native-drill-report>header button')].find(button=>button.textContent?.trim()==='Go Back');assert(back);await act(async()=>{back.click();});assert.equal(h.backs,1);assert.deepEqual(h.replacementCalls,['d']);
  assert.equal(JSON.stringify(scope),original,'Drill proof and Go Back callbacks cannot rewrite the original source cutoffs, exact IDs or history.');assert.match(h.win.document.querySelector('.native-drill-report>header')?.textContent??'',new RegExp(snapshot.context.currency));assert.deepEqual(h.renderErrors,[]);assert.deepEqual(h.networkAttempts,[]);
});

test('actual production drill keeps an unbound grid row disabled and an empty capability exposes no proof controls',async t=>{
  // Explicit defensive fixture: a grid table can still name a record whose
  // current proof binding is missing. This is not a valid saved source edition.
  const snapshot=source();snapshot.orders=snapshot.orders.filter(order=>order.id!=='a');
  const h=await drillHarness(t,scoped(snapshot,['a']));await h.until(()=>Boolean(h.win.document.querySelector('.drill-native-grid .native-proof-link')),'The actual defensive grid row did not render');
  const denied=h.win.document.querySelector<HTMLButtonElement>('.drill-native-grid .native-proof-link')!;assert.equal(denied.disabled,true);assert.equal(denied.textContent,'Unknown order');await act(async()=>{denied.click();});assert.deepEqual(h.calls,[]);assert.deepEqual(h.networkAttempts,[]);await h.destroy();
  const empty=await drillHarness(t,scoped(source(),[]));await empty.until(()=>Boolean(empty.win.document.querySelector('.drill-native-grid .ag-root-wrapper')),'The actual empty drill grid did not mount');for(let attempt=0;attempt<5;attempt++)await empty.flush();
  assert.equal(empty.win.document.querySelectorAll('.native-proof-link,.drill-proof-list button').length,0);assert.deepEqual(empty.calls,[]);assert.deepEqual(empty.renderErrors,[]);assert.deepEqual(empty.networkAttempts,[]);
});
