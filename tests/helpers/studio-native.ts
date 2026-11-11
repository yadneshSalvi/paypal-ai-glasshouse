import type {TestContext} from 'node:test';
import type {AgReportHistory,AgReportState,AgStudioApi} from 'ag-studio';
import {JSDOM,VirtualConsole} from 'jsdom';
import type {GlasshouseRegistry} from '../../packages/studio/types';

/** Actual installed native state/schema/history and harness. JSDOM supplies the
 * document; empty widget renderers deliberately exclude visual qualification. */
export async function nativeStudio(t:TestContext,history?:AgReportHistory<GlasshouseRegistry>|AgReportState<GlasshouseRegistry>){
  const dom=new JSDOM('<!doctype html><html><body><div id="studio"></div></body></html>',{url:'http://isolated.test',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});
  const win=dom.window;
  const names=['window','document','navigator','HTMLElement','Element','Node','ShadowRoot','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','MutationObserver','DOMParser','DOMRect','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'];
  const previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?win:(win as unknown as Record<string,unknown>)[key]});
  class ResizeObserverFixture {observe(){}unobserve(){}disconnect(){}}
  previous.set('ResizeObserver',Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'));
  Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:ResizeObserverFixture});Object.defineProperty(win,'ResizeObserver',{value:ResizeObserverFixture});
  Object.defineProperty(win,'matchMedia',{value:(query:string)=>({matches:false,media:query,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}})});
  t.mock.method(globalThis,'fetch',()=>{throw new Error('Native state/history tests permit no network calls.');});
  const native=await import('ag-studio');
  const {definitions,initialState,studioData}=await import('../../packages/studio/registry');
  const {createSeedDataset,buildSnapshot}=await import('../../packages/domain');
  if(process.env.AG_STUDIO_LICENSE_KEY)native.AgStudioLicenseManager.setLicenseKey(process.env.AG_STUDIO_LICENSE_KEY);
  class EmptyWidget {element=win.document.createElement('div');getGui(){return this.element;}init(){}update(){}destroy(){}}
  const config=native.createWidgets({additionalTypes:definitions.map(definition=>({...definition,comp:EmptyWidget}))} as never);
  const widgets={...config,widgets:config.widgets.map(definition=>({...definition,comp:EmptyWidget}))};
  let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  const errors:{fatal:boolean;details:readonly string[]}[]=[];
  const api=native.createStudio(win.document.getElementById('studio')!,{
    // React instrument definitions have identical state shapes here; the only
    // framework boundary replaced by this test is each component constructor.
    studioId:'native-history-fixture',data:studioData(buildSnapshot(createSeedDataset('native-history-fixture'))) as never,widgets:widgets as never,
    initialState:structuredClone(history??initialState) as never,loadThemeGoogleFonts:false,mode:'view',history:{onModeChange:'preserve'},
    panels:{edit:{right:['edit','data','filters']},view:{right:[]}},
    ai:({api})=>native.createAiHarness(api as unknown as AgStudioApi,()=>({primary:'fixture',agents:[{id:'fixture',async *run(){throw new Error('No model dispatch is allowed in this native state test.');}}]})),
    onStudioReady:()=>queueMicrotask(ready),onErrorRaised:event=>errors.push({fatal:event.fatal,details:event.errorDetails}),
  },{modules:[native.AgStudioAiModule]}) as unknown as AgStudioApi<GlasshouseRegistry>;
  let destroyed=false;
  const destroy=()=>{
    if(destroyed)return;destroyed=true;api.destroy();dom.window.close();
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  };
  t.after(destroy);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([started,new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(new Error('Native document admission timed out.')),10000);timeout.unref();})]);}
  finally{if(timeout)clearTimeout(timeout);}
  if(!api.getState().pages.length)throw new Error('The actual native engine did not admit a document.');
  return {api,native,errors,destroy};
}
