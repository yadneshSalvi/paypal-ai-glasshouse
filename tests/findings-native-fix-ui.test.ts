import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import React,{act,createElement,useState} from 'react';
import type {RecoveryPlan} from '../packages/domain/types';
import {domHarness} from './helpers/finding-ui';
import {compareFindingScopes} from '../packages/findings/comparison';

type Harness=Awaited<ReturnType<typeof domHarness>>;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const button=(h:Harness,label:string)=>{const value=[...h.win.document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent?.includes(label));assert(value,'Expected '+label);return value;};
async function press(h:Harness,label:string){const target=button(h,label);await act(async()=>{target.focus();target.click();await tick();});return target;}
function plan(h:Harness,overrides:Partial<RecoveryPlan>={}):RecoveryPlan{return {id:'plan-synthetic-focus-fixture',tenantId:h.revision.tenantId,version:1,createdBy:h.revision.creatorId,createdAt:new Date().toISOString(),status:'ready_for_review',branch:h.snapshot.branches[0],snapshotId:h.snapshot.id,snapshotHash:h.snapshot.hash,cohortVersion:h.snapshot.context.cohortVersion,hash:'a'.repeat(64),expiresAt:new Date(Date.now()+1800000).toISOString(),staleReason:null,approvedBy:null,approvedAt:null,executionMode:'sample',contractVersion:3,context:h.snapshot.context,findingDependencyPolicy:'finding-dependencies-v1',findingDependencies:[],...overrides};}
const reviewed=(value:RecoveryPlan)=>({plan:value,dependencies:{policy:'finding-dependencies-v1',valid:true,checkedAt:new Date().toISOString(),dependencies:[],reason:null}});
const planProps=(value:RecoveryPlan)=>({plan:value,operations:[],canAuthorize:true,onClose(){},onApprove:async()=>value,onExecute:async()=>{},onOrder(){},onRefresh:async()=>{},onLatestEvidence:async()=>{}});

test('full application CSS gives the finding heading, surface, forms, timeline and footer one readable paper theme',async t=>{
  const h=await domHarness(t);
  h.snapshot.evidence.unshift({...h.snapshot.evidence[0],id:'evidence-synthetic-untrusted-cascade',title:'Untrusted cascade regression',untrusted:true});
  for(const name of ['globals','reports','findings']){const style=h.win.document.createElement('style');style.textContent=await readFile(new URL('../app/'+name+'.css',import.meta.url),'utf8');h.win.document.head.append(style);}
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>Response.json(String(input)==='/api/findings'?{findings:[h.summary],legacy:[],hasMore:false,nextCursor:null}:h.detail));
  await h.render(createElement(h.FindingLibrary,{workspaceId:h.revision.tenantId,actorId:h.revision.creatorId,snapshot:h.snapshot,readOnly:false,onClose(){},onChanged:async()=>{},onOrder(){},onPlan(){}}));
  const style=(selector:string)=>{const node=h.win.document.querySelector(selector);assert(node,selector);return h.win.getComputedStyle(node);};
  assert.equal(style('.modal-content').backgroundColor,'rgb(250, 247, 239)');assert.equal(style('.modal-content').backgroundImage,'none');assert.equal(style('h2').color,'rgb(35, 60, 50)');
  assert.equal(style('dialog').width,'950px');assert.notEqual(style('dialog').maxWidth,'950px');
  const contrast=(foreground:string,background:string)=>{const luminance=(value:string)=>{const rgb=value.match(/[\d.]+/g)!.slice(0,3).map(Number).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb.reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i],0);};const a=luminance(foreground),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
  const readable=(selector:string)=>{const foreground=style(selector).color;assert(contrast(foreground,'rgb(238, 233, 223)')>=4.5,selector+' has insufficient paper contrast: '+foreground);};
  readable('.finding-library-intro span');readable('.finding-card footer');
  await press(h,'Propose a finding');
  const search=h.win.document.querySelector<HTMLInputElement>('.finding-citation-picker input[type=search]')!;assert.match(search.labels?.[0].textContent??'',/Search citation sources/);
  readable('.finding-form-context p');readable('.finding-form>label');readable('.finding-citation-picker article small');readable('.finding-citation-picker .amber-text');readable('.finding-pagination>span');
  await press(h,'Return without a new decision');await press(h,h.revision.title);
  readable('.finding-back');readable('.finding-tabs button');readable('.finding-interpretation>article>p');readable('.finding-record-foot');
  await press(h,'Source comparison');readable('.finding-sources blockquote');readable('.finding-sources details');readable('.finding-sources code');
  await press(h,'Review timeline');readable('.finding-timeline small');
  for(const action of ['Support this scope','Challenge','Revise interpretation','Retract']){await press(h,action);readable('.finding-form-context p');readable('.finding-form>label');await press(h,'Return without a new decision');}
});

test('manifest refresh retains its origin on success/error, preserves deliberate movement and distinguishes empty findings from stale source binding',async t=>{
  const h=await domHarness(t),{PlanDialog}=await import('../components/glasshouse-app'),value=plan(h,{status:'stale',staleReason:'Nine source deliveries changed the saved scope.'});
  let next=deferred<Response>(),calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return calls===1?Response.json(reviewed(value)):next.promise;});
  await h.render(createElement(PlanDialog,planProps(value)));assert.equal(h.win.document.activeElement?.tagName,'H2');
  assert.match(h.win.document.body.textContent??'',/no interpretation dependencies to verify/);assert.match(h.win.document.body.textContent??'',/historical source snapshot/);assert.equal(h.win.document.body.textContent?.includes('current source dependencies verify'),false);assert.equal([...h.win.document.querySelectorAll('button')].some(node=>node.textContent?.startsWith('Approve')),false);
  const origin=await press(h,'Refresh current review');assert.equal(origin.getAttribute('aria-disabled'),'true');assert.equal(h.win.document.activeElement===origin,true,'Focus remains on '+origin.tagName+' / '+origin.textContent?.slice(0,70));
  await act(async()=>{origin.click();await tick();});assert.equal(calls,2,'Pending refresh is not duplicated');
  await act(async()=>{next.resolve(Response.json(reviewed(value)));await tick();});assert.equal(h.win.document.activeElement===origin,true,'Focus remains on '+origin.tagName+' / '+origin.textContent?.slice(0,70));assert.equal(origin.getAttribute('aria-disabled'),null);
  next=deferred<Response>();await press(h,'Refresh current review');await act(async()=>{next.reject(new TypeError('Synthetic review connection loss'));await tick();});assert.match(h.win.document.querySelector('[role=alert]')?.textContent??'',/Synthetic review connection loss/);assert.equal(h.win.document.activeElement===origin,true,'Focus remains on '+origin.tagName+' / '+origin.textContent?.slice(0,70));
  next=deferred<Response>();await press(h,'Refresh current review');const other=h.win.document.querySelector<HTMLInputElement>('input[aria-label="Filter action manifest by order"]')!;other.focus();await act(async()=>{next.resolve(Response.json(reviewed(value)));await tick();});assert.equal(h.win.document.activeElement===other,true,'Focus remains on '+other.tagName+' / '+other.textContent?.slice(0,70));
});

test('manifest review responses cannot update a replacement dialog, a different workspace or focus after unmount',async t=>{
  const h=await domHarness(t),{PlanDialog}=await import('../components/glasshouse-app'),first=plan(h),second=plan(h,{id:'plan-second-fixture',hash:'b'.repeat(64)}),pending=deferred<Response>();
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>String(input).includes(second.id)?Response.json(reviewed(second)):pending.promise);
  await h.render(createElement(PlanDialog,{...planProps(first),key:first.id}));await h.render(createElement(PlanDialog,{...planProps(second),key:second.id}));const other=button(h,'Refresh current review');other.focus();
  await act(async()=>{pending.resolve(Response.json(reviewed({...first,status:'stale'})));await tick();});assert.equal(h.win.document.activeElement===other,true,'Focus remains on '+other.tagName+' / '+other.textContent?.slice(0,70));assert.equal(h.win.document.body.textContent?.includes(second.hash),true);assert.equal(h.win.document.body.textContent?.includes(first.hash),false);
  const later=deferred<Response>();t.mock.method(globalThis,'fetch',async()=>later.promise);await press(h,'Refresh current review');h.workspaceScope.admit('another-ui-context','another-ui-workspace');
  await h.render(createElement('button',{id:'new-context'},'Continue in another workspace'));const replacement=h.win.document.getElementById('new-context')!;replacement.focus();await act(async()=>{later.resolve(Response.json(reviewed({...second,status:'stale'})));await tick();});assert.equal(h.win.document.activeElement===replacement,true,'Focus remains on '+replacement.tagName+' / '+replacement.textContent?.slice(0,70));assert.equal(h.win.document.querySelector('dialog'),null);
});

test('prepare keeps a focusable pending control, prevents duplicates, preserves deliberate movement on error and focuses the new exact manifest',async t=>{
  const h=await domHarness(t),{BranchDialog,PlanDialog}=await import('../components/glasshouse-app'),value=plan(h);let next=deferred<RecoveryPlan>(),calls=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>Response.json(String(input)==='/api/findings'?{findings:[],legacy:[],hasMore:false,nextCursor:null}:reviewed(value)));
  function Journey(){const [saved,setSaved]=useState<RecoveryPlan|null>(null);return saved?createElement(PlanDialog,planProps(saved)):createElement(BranchDialog,{branch:h.snapshot.branches[0],snapshot:h.snapshot,readOnly:false,onClose(){},onOrder(){},onPrepare:async()=>{calls++;return next.promise;},onPrepared:setSaved});}
  await h.render(createElement(Journey));const origin=await press(h,'Prepare exact manifest');assert.equal(origin.disabled,false);assert.equal(origin.getAttribute('aria-disabled'),'true');assert.equal(h.win.document.activeElement===origin,true,'Focus remains on '+origin.tagName+' / '+origin.textContent?.slice(0,70));await act(async()=>{origin.click();await tick();});assert.equal(calls,1);
  await act(async()=>{next.reject(new Error('Synthetic preparation failure'));await tick();});assert.equal(h.win.document.activeElement===origin,true,'Focus remains on '+origin.tagName+' / '+origin.textContent?.slice(0,70));assert.match(h.win.document.body.textContent??'',/Synthetic preparation failure/);
  next=deferred<RecoveryPlan>();await press(h,'Prepare exact manifest');const cap=h.win.document.querySelector<HTMLInputElement>('input[type=number]')!;cap.focus();await act(async()=>{next.reject(new Error('Synthetic second failure'));await tick();});assert.equal(h.win.document.activeElement===cap,true,'Focus remains on '+cap.tagName+' / '+cap.textContent?.slice(0,70));
  next=deferred<RecoveryPlan>();await press(h,'Prepare exact manifest');await act(async()=>{next.resolve(value);await tick();});assert.equal(h.win.document.activeElement?.tagName,'H2');assert.match(h.win.document.activeElement?.textContent??'',/A decision with a receipt/);
});

test('late prepare responses cannot reopen a closed or workspace-replaced manifest',async t=>{
  const h=await domHarness(t),{BranchDialog}=await import('../components/glasshouse-app'),value=plan(h),pending=deferred<RecoveryPlan>();let prepared=0;
  t.mock.method(globalThis,'fetch',async()=>Response.json({findings:[],legacy:[],hasMore:false,nextCursor:null}));
  await h.render(createElement(BranchDialog,{branch:h.snapshot.branches[0],snapshot:h.snapshot,readOnly:false,onClose(){},onOrder(){},onPrepare:async()=>pending.promise,onPrepared:()=>{prepared++;}}));await press(h,'Prepare exact manifest');
  h.workspaceScope.hold('Synthetic workspace identity change');await h.render(createElement('button',{id:'outside'},'Choose current workspace'));const outside=h.win.document.getElementById('outside')!;outside.focus();await act(async()=>{pending.resolve(value);await tick();});assert.equal(prepared,0);assert.equal(h.win.document.activeElement===outside,true,'Focus remains on '+outside.tagName+' / '+outside.textContent?.slice(0,70));
});

test('linked manifest closes back to the exact still-mounted finding control and report notices name the saved comparison',async t=>{
  const h=await domHarness(t),{PlanDialog}=await import('../components/glasshouse-app'),{ReportCorrection}=await import('../components/report-reader'),value=plan(h,{status:'stale'});
  h.detail.plans=[{id:value.id,hash:value.hash,status:'stale',createdAt:value.createdAt,dependencyRevisionId:h.revision.id,invalidated:true}];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>Response.json(String(input)==='/api/findings'?{findings:[h.summary],legacy:[],hasMore:false,nextCursor:null}:String(input).startsWith('/api/plans/')?reviewed(value):h.detail));
  function Linked(){const [open,setOpen]=useState(false);return createElement(React.Fragment,null,createElement(h.FindingLibrary,{workspaceId:h.revision.tenantId,actorId:h.revision.creatorId,snapshot:h.snapshot,readOnly:false,initialFindingId:h.revision.findingId,onClose(){},onChanged:async()=>{},onOrder(){},onPlan(_id,current){if(current())setOpen(true);}}),open?createElement(PlanDialog,{...planProps(value),onClose:()=>setOpen(false)}):null);}
  await h.render(createElement(Linked));const origin=await press(h,value.id);assert.equal(h.win.document.querySelectorAll('dialog').length,2);assert.equal(h.win.document.activeElement?.tagName,'H2');await press(h,'Return to recovery');assert.equal(h.win.document.querySelectorAll('dialog').length,1);assert.equal(h.win.document.activeElement===origin,true,'Focus remains on '+origin.tagName+' / '+origin.textContent?.slice(0,70));
  const latest={...h.revision,id:'frev-current-permitted',sequence:6,cohortVersion:2,hash:'c'.repeat(64),facts:{...h.revision.facts,affectedCount:54,affectedOrderIds:h.revision.facts.affectedOrderIds.slice(9)}};
  const notice={findingId:h.revision.findingId,revisionId:h.revision.id,revisionHash:h.revision.hash,currentRevisionId:latest.id,reason:'Current permitted support.',createdAt:latest.createdAt,state:'supported_for_current_scope' as const,delta:null,comparison:compareFindingScopes(h.revision,latest),savedManifests:[{id:value.id,hash:value.hash,status:value.status}]};
  await h.render(createElement(ReportCorrection,{notice}));assert.match(h.win.document.body.textContent??'',/Saved finding → current permitted finding/);assert.match(h.win.document.body.textContent??'',/63 → 54 affected · 9 removed/);assert.match(h.win.document.body.textContent??'',/related saved manifests currently held/);
  await h.render(createElement(ReportCorrection,{notice:{...notice,currentRevisionId:null,state:'superseded',reason:'Its creator has not shared the later interpretation.',comparison:null,savedManifests:null}}));assert.equal(h.win.document.body.textContent?.includes('63 → 54'),false);assert.equal(h.win.document.body.textContent?.includes(latest.id),false);assert.equal(h.win.document.body.textContent?.includes(value.id),false);
});
