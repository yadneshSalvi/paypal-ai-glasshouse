import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {buildSnapshot,createSeedDataset} from '../../packages/domain';
import {FindingService} from '../../lib/server/findings/service';
import {FindingSecrets} from '../../lib/server/findings/crypto';
import {AgentSecrets} from '../../lib/server/agents/security';
import type {Database} from '../../packages/db/client';
import type {FindingDetail,FindingSummary} from '../../packages/findings/types';

export async function domHarness(t:import('node:test').TestContext){
  const dom=new JSDOM('<!doctype html><html><body><button id="trigger" data-focus-return="finding-library">Findings</button><div id="root"></div></body></html>',{url:'http://localhost:4545',pretendToBeVisual:true}),win=dom.window;
  const values:Record<string,unknown>={window:win,document:win.document,navigator:win.navigator,HTMLElement:win.HTMLElement,Element:win.Element,Node:win.Node,HTMLDialogElement:win.HTMLDialogElement,sessionStorage:win.sessionStorage,getComputedStyle:win.getComputedStyle,CSS:{escape:(value:string)=>value.replaceAll('"','\\"')},React,IS_REACT_ACT_ENVIRONMENT:true};
  const previous=new Map(Object.keys(values).map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));for(const [name,value] of Object.entries(values))Object.defineProperty(globalThis,name,{configurable:true,value});
  win.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};win.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  t.mock.method(win.HTMLElement.prototype,'getClientRects',()=>[{x:0,y:0,width:50,height:30}] as unknown as DOMRectList);
  const {createRoot}=await import('react-dom/client'),{FindingLibrary,FindingSelector}=await import('../../components/finding-library'),{workspaceScope}=await import('../../lib/workspace-context');workspaceScope.admit('ui-fixture-context','ui-fixture-tenant');
  const root=createRoot(win.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [name,value] of previous)if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);});
  const snapshot=buildSnapshot(createSeedDataset('ui-fixture-tenant')),key=randomBytes(32).toString('base64'),service=new FindingService({} as Database,new FindingSecrets(key),new AgentSecrets(key));
  const revision=service.draft({id:'ui-fixture-owner',tenantId:'ui-fixture-tenant',role:'judge',membershipVersion:1},snapshot,{title:'The source interpretation',interpretation:'A source-bound explanation remains open to challenge and later correction.',counterpoint:'The fixture sources cannot establish physical delivery or causality.',reason:'A clearly labelled DOM behavior fixture.',evidenceIds:[snapshot.evidence[0].id],counterEvidenceIds:[]});
  const summary:FindingSummary={findingId:revision.findingId,revisionId:revision.id,hash:revision.hash,title:revision.title,sequence:1,state:'proposed',creatorId:revision.creatorId,actorId:revision.actorId,createdAt:revision.createdAt,affectedCount:revision.facts.affectedCount,cohortVersion:revision.cohortVersion,sourceSnapshotHash:revision.sourceSnapshotHash,isCurrent:true,shared:false,currentSource:true,canReview:true,canEdit:true,canShare:true};
  const detail:FindingDetail={revision,summary,revisions:[summary],plans:[],corrections:[],correctionMoment:null};
  const render=async(node:React.ReactNode)=>{await act(async()=>{root.render(node);await new Promise(resolve=>setImmediate(resolve));});};
  const click=async(text:string)=>{const button=[...win.document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent?.includes(text));assert(button,'Expected control: '+text);await act(async()=>{button.click();await new Promise(resolve=>setImmediate(resolve));});};
  return {dom,win,root,render,click,workspaceScope,FindingLibrary,FindingSelector,snapshot,revision,summary,detail};
}
