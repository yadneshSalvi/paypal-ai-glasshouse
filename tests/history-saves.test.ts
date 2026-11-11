import {test} from 'node:test';import assert from 'node:assert/strict';
import {HistorySaves,type ReportHistory} from '../packages/studio/history-saves';
import {inspectHistoryRestore} from '../packages/studio/history';
import {readLayout,saveLayout,validateHistory} from '../lib/server/layouts';
import {paymentHarness} from './helpers/payments';

const history=(id='page-a'):ReportHistory=>({type:'AgReportHistory',current:{pages:[{id}],selectedPageId:id},undo:[],redo:[]});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('all save sources wait for native history admission and never write after disposal',async()=>{
 const writes:unknown[]=[];const q=new HistorySaves(0,async x=>{writes.push(x);return {version:1};},()=>{});
 for(const source of ['Manual','Agent','Native'])await assert.rejects(q.save(history(),source),/complete history/);
 assert.equal(writes.length,0);q.admit(true);q.dispose();await assert.rejects(q.save(history(),'Agent'),/complete history/);assert.equal(writes.length,0);
});
test('queued saves keep immutable values and are serialized against the latest saved version',async()=>{
 const start=deferred(),release=deferred();let active=0,peak=0;const writes:{history:ReportHistory;expectedVersion:number}[]=[],saved:number[]=[];
 const q=new HistorySaves(4,async x=>{active++;peak=Math.max(peak,active);writes.push(x);if(writes.length===1){start.resolve();await release.promise;}active--;return {version:x.expectedVersion+1};},(_h,v)=>saved.push(v));q.admit(true);
 const source=history();const first=q.save(source,'Manual');await start.promise;const second=q.save(history('page-b'),'Agent');source.current.selectedPageId='mutated-after-request';release.resolve();await Promise.all([first,second]);
 assert.equal(peak,1);assert.deepEqual(writes.map(x=>x.expectedVersion),[4,5]);assert.equal(writes[0].history.current.selectedPageId,'page-a');assert.deepEqual(saved,[5,6]);
});
test('a lost response holds later edits and retries the same original value and version',async()=>{
 const writes:unknown[]=[];let fail=true;const q=new HistorySaves(2,async x=>{writes.push(structuredClone(x));if(fail){fail=false;throw Error('response lost');}return {version:3};},()=>{});q.admit(true);
 await assert.rejects(q.save(history(),'First'),/response lost/);await assert.rejects(q.save(history('new-page'),'Later'),/previous workspace save/);assert.equal(writes.length,1);
 await q.retry();assert.deepEqual(writes[0],writes[1]);await q.save(history('new-page'),'Later');assert.equal((writes[2] as {expectedVersion:number}).expectedVersion,3);
});
test('saved current and actual history states are compared, not just stack identities',()=>{
 const saved=history();saved.undo=[{id:'change-1',state:history('previous').current,source:{type:'ui'},at:1,label:'Layout',labelKey:'undo' as never}];
 const native=structuredClone(saved);
 const api={getHistory:()=>native,defineAiCommand:()=>({parse:()=>({success:true})})} as unknown as Parameters<typeof inspectHistoryRestore>[0];
 assert.equal(inspectHistoryRestore(api,saved).state,'restored');native.undo[0].state=history('changed').current;assert.equal(inspectHistoryRestore(api,saved).state,'unavailable');native.undo=structuredClone(saved.undo);native.current=history('reset').current;assert.equal(inspectHistoryRestore(api,saved).state,'unavailable');
});
test('redo selections use their own widget identities without suppressing invalid references or other schema issues',()=>{
 const saved=history(),future=history().current;future.pages[0].widgets={future:{type:'commerce-river'} as never};future.pages[0].selection={type:'widget',id:'future'};
 saved.redo=[{id:'redo-1',state:future,source:{type:'ui'},at:1,label:'Duplicate',labelKey:'undo' as never}];
 const native=structuredClone(saved);let extra=false;
 const api={getHistory:()=>native,defineAiCommand:()=>({parse:(state:typeof future)=>state.pages[0].selection?{success:false,issues:[{key:'validationExpectedOneOf',path:['pages',0,'selection','id']},...(extra?[{key:'widgetInvalidType',path:['pages',0,'widgets','future','type']}]:[])]}:{success:true}})} as unknown as Parameters<typeof inspectHistoryRestore>[0];
 assert.equal(inspectHistoryRestore(api,saved).state,'restored');extra=true;assert.equal(inspectHistoryRestore(api,saved).state,'unavailable');extra=false;
 delete saved.redo[0].state.pages[0].widgets?.future;delete native.redo[0].state.pages[0].widgets?.future;assert.equal(inspectHistoryRestore(api,saved).state,'unavailable');
});
test('report save is version-bound, exact replay is idempotent, and stale tabs cannot overwrite',async t=>{
 const h=await paymentHarness();t.after(()=>h.pg.close());assert.deepEqual(await readLayout(h.db,h.who),{history:null,version:0});
 const first={history:history(),expectedVersion:0,label:'First edit'};assert.equal((await saveLayout(h.db,h.who,first)).version,1);
 assert.equal((await saveLayout(h.db,h.who,first)).replayed,true);assert.equal((await h.db.query('SELECT id FROM gh_audit')).length,1);
 await saveLayout(h.db,h.who,{history:history('page-b'),expectedVersion:1});
 await assert.rejects(saveLayout(h.db,h.who,first),/Another tab/);await assert.rejects(saveLayout(h.db,h.who,{history:history('stale'),expectedVersion:1}),/Another tab/);
 assert.deepEqual(await readLayout(h.db,h.who),{history:history('page-b'),version:2});assert.equal((await h.db.query('SELECT id FROM gh_audit')).length,2);
});
test('competing writers admit only one version and preserve the losing local draft',async t=>{
 const h=await paymentHarness();t.after(()=>h.pg.close());await saveLayout(h.db,h.who,{history:history(),expectedVersion:0});
 const results=await Promise.allSettled(['one','two'].map(id=>saveLayout(h.db,h.who,{history:history(id),expectedVersion:1})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);assert.equal((await readLayout(h.db,h.who)).version,2);
});
test('invalid history, stale membership, foreign scope and viewer writes leave the saved report intact',async t=>{
 const h=await paymentHarness();t.after(()=>h.pg.close());await saveLayout(h.db,h.who,{history:history(),expectedVersion:0});
 assert.throws(()=>validateHistory({...history(),current:{pages:[],selectedPageId:'missing'}}),/complete native report/);
 await assert.rejects(saveLayout(h.db,{...h.who,tenantId:'foreign'},{history:history('foreign'),expectedVersion:0}),/Current workspace membership/);
 await h.db.query("UPDATE gh_memberships SET role='viewer',version=version+1 WHERE tenant_id=$1",[h.who.tenantId]);
 await assert.rejects(saveLayout(h.db,h.who,{history:history('stale'),expectedVersion:1}),/Current workspace membership/);
 const viewer={...h.who,role:'viewer' as const,membershipVersion:2};await assert.rejects(saveLayout(h.db,viewer,{history:history('viewer'),expectedVersion:1}),/cannot change/);
 assert.deepEqual(await readLayout(h.db,viewer),{history:history(),version:1});await h.db.query('UPDATE gh_memberships SET active=false WHERE tenant_id=$1',[h.who.tenantId]);await assert.rejects(readLayout(h.db,viewer),/Current workspace membership/);
});
