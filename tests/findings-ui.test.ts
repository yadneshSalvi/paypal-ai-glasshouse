import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {act,createElement,useState} from 'react';
import type {FindingReference} from '../packages/findings/types';
import {domHarness} from './helpers/finding-ui';

test('DOM recovery keeps the exact command after a lost response and returns focus after the dialog closes',async t=>{
  const h=await domHarness(t),command={path:'findings',body:{requestId:randomUUID(),snapshotHash:h.snapshot.hash,title:h.revision.title,interpretation:h.revision.interpretation,counterpoint:h.revision.counterpoint,evidenceIds:[h.snapshot.evidence[0].id],counterEvidenceIds:[],reason:h.revision.reason},label:'Private proposed finding'},sent:string[]=[];
  const key='glasshouse-finding-request:ui-fixture-tenant:ui-fixture-owner';h.win.sessionStorage.setItem(key,JSON.stringify(command));
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{const path=String(input);if(init?.method==='POST'){sent.push(String(init.body));if(sent.length===1)throw new TypeError('Synthetic lost HTTP response');return Response.json(h.revision);}return Response.json(path==='/api/findings'?{findings:[h.summary],legacy:[],hasMore:false,nextCursor:null}:h.detail);});
  const trigger=h.win.document.getElementById('trigger') as HTMLButtonElement;trigger.focus();let changed=0;
  await h.render(createElement(h.FindingLibrary,{workspaceId:'ui-fixture-tenant',actorId:'ui-fixture-owner',snapshot:h.snapshot,readOnly:false,onClose:()=>h.root.render(null),onChanged:async()=>{changed++;},onOrder(){},onPlan(){}}));
  assert.equal(h.win.document.activeElement?.tagName,'H2');await h.click('Recover original decision');assert.match(h.win.document.querySelector('[role=alert]')?.textContent??'',/Synthetic lost HTTP response/);assert.equal(h.win.sessionStorage.getItem(key),JSON.stringify(command));
  await h.click('Recover original decision');assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);assert.equal(JSON.parse(sent[0]).requestId,command.body.requestId);assert.equal(h.win.sessionStorage.getItem(key),null);assert.equal(changed,1);assert.equal(h.win.document.querySelector('h2')?.textContent,h.revision.title);
  const close=h.win.document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!;await act(async()=>{close.click();await new Promise(resolve=>setImmediate(resolve));});assert.equal(h.win.document.activeElement,trigger);
});

test('DOM stale selections can be explicitly removed and read failures offer an accessible retry',async t=>{
  const h=await domHarness(t),old:FindingReference={findingId:h.revision.findingId,revisionId:h.revision.id,hash:h.revision.hash};let calls=0,selected:FindingReference[]=[old];
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1)return Response.json({error:'Synthetic current-version read unavailable.',code:'READ_UNAVAILABLE'},{status:503});return Response.json({findings:[],legacy:[],hasMore:false,nextCursor:null});});
  function Picker(){const [value,setValue]=useState([old]);return createElement(h.FindingSelector,{value,onChange(next){selected=next;setValue(next);}});}
  await h.render(createElement(Picker));assert.match(h.win.document.querySelector('[role=alert]')?.textContent??'',/unavailable/);await h.click('Retry finding read');assert.equal(calls,2);await h.click('Remove earlier selection');assert.deepEqual(selected,[]);assert.match(h.win.document.body.textContent??'',/No current shared, supported versions/);
});

test('DOM read-only views expose history and downloads while holding pending mutations',async t=>{
  const h=await domHarness(t);let posts=0;t.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{if(init?.method==='POST')posts++;return Response.json(String(_input)==='/api/findings'?{findings:[h.summary],legacy:[],hasMore:false,nextCursor:null}:h.detail);});
  h.win.sessionStorage.setItem('glasshouse-finding-request:ui-fixture-tenant:ui-fixture-owner',JSON.stringify({path:'findings',body:{requestId:randomUUID()},label:'Pending local review'}));
  await h.render(createElement(h.FindingLibrary,{workspaceId:'ui-fixture-tenant',actorId:'ui-fixture-owner',snapshot:h.snapshot,readOnly:true,initialFindingId:h.revision.findingId,onClose(){},onChanged:async()=>{},onOrder(){},onPlan(){}}));
  const buttons=[...h.win.document.querySelectorAll<HTMLButtonElement>('button')];assert.equal(buttons.find(row=>row.textContent?.includes('Recover original decision'))?.disabled,true);assert.equal(buttons.some(row=>row.textContent?.includes('Share this exact version')),false);assert.equal(buttons.some(row=>row.textContent==='Support this scope'),false);assert(buttons.some(row=>row.textContent?.includes('Download exact version')));assert.equal(posts,0);
});
