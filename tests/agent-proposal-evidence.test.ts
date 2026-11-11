import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {JSDOM} from 'jsdom';
import {agentHarness,functionCall,tool} from './helpers/agents';
import {isProposalEvidence,ProposalManifest,proposalDownload} from '../components/agent-proposal-evidence';

test('the deterministic inspector exposes every saved action/operation and policy row without rewriting the receipt',async t=>{
  const h=await agentHarness();t.after(h.dispose);const parent=await h.begin(),planner=await h.handoff(parent,'planner');
  const call=functionCall('prepare_recovery',{branchId:'targeted',budgetMinor:30000});await h.issue(planner.run.id,[tool('prepare_recovery')],[call]);
  const grant=await h.tools.claim(h.who,{runId:planner.run.id,callId:call.call_id,name:call.name,args:JSON.parse(call.arguments),clientId:h.clientId,snapshotHash:h.snapshot.hash});
  assert.ok(grant.result?.success);assert.ok(isProposalEvidence(grant.result.data));const evidence=grant.result.data,original=JSON.stringify(evidence);
  const saved=proposalDownload(evidence);assert.deepEqual(JSON.parse(saved.body),evidence);assert.match(saved.filename,/evidence\.json$/);
  assert.equal(new Set(evidence.manifest.branch.actions.map(row=>row.id)).size,evidence.manifest.branch.actions.length);assert.ok(evidence.manifest.branch.actions.length>100);
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://isolated.test'}),win=dom.window;
  const entries:Record<string,unknown>={window:win,document:win.document,navigator:win.navigator,HTMLElement:win.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true},previous=new Map(Object.keys(entries).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(entries))Object.defineProperty(globalThis,key,{configurable:true,value});
  const {createRoot}=await import('react-dom/client');const root=createRoot(win.document.getElementById('root')!);
  t.after(async()=>{await act(()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);});
  const creates=h.fixture.creates.length;
  t.mock.method(globalThis,'fetch',()=>{throw new Error('The saved manifest inspector must not request a provider or mutate data.');});
  await act(()=>root.render(createElement(ProposalManifest,{evidence})));
  const seenActions:string[]=[],seenOperations:string[]=[];
  for(;;){
    for(const row of win.document.querySelectorAll('tbody tr')){const codes=row.querySelectorAll('td:nth-child(2) code');seenActions.push(codes[0].textContent!);seenOperations.push(codes[1].textContent!);}
    const next=win.document.querySelector<HTMLButtonElement>('button[aria-label="Next manifest page"]')!;if(next.disabled)break;await act(()=>next.click());
  }
  assert.deepEqual(seenActions,evidence.manifest.branch.actions.map(row=>row.id));assert.deepEqual(seenOperations,evidence.manifest.branch.actions.map(row=>row.payload.operationId));
  const eligibility=[...win.document.querySelectorAll<HTMLButtonElement>('.proposal-evidence-tabs button')].find(button=>button.textContent?.startsWith('Policy rows'))!;await act(()=>eligibility.click());
  const seenOrders:string[]=[],decisions:string[]=[];
  for(;;){
    for(const row of win.document.querySelectorAll('tbody tr')){seenOrders.push(row.querySelector('td code')!.textContent!);decisions.push(row.querySelector('td:nth-child(2) strong')!.textContent!);}
    const next=win.document.querySelector<HTMLButtonElement>('button[aria-label="Next manifest page"]')!;if(next.disabled)break;await act(()=>next.click());
  }
  assert.deepEqual(seenOrders,evidence.manifest.branch.rows.map(row=>row.orderId));assert.deepEqual(decisions,evidence.manifest.branch.rows.map(row=>row.eligible?'Eligible':'Excluded'));
  assert.ok(win.document.body.textContent?.includes(evidence.hash));assert.ok(win.document.body.textContent?.includes(evidence.manifest.context.asOf));assert.ok(win.document.body.textContent?.includes(evidence.manifest.context.knownAt));
  assert.equal(win.document.querySelector('[role="region"]')?.getAttribute('tabindex'),'0');assert.equal([...win.document.querySelectorAll('button')].some(button=>/approve|execute/i.test(button.textContent??'')),false);
  assert.equal(JSON.stringify(evidence),original);assert.equal(h.fixture.creates.length,creates);assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);
  assert.equal(isProposalEvidence({id:evidence.id,hash:evidence.hash,hashVerified:true}),false,'A partial or model-authored summary is not presented as a complete saved manifest.');
});
