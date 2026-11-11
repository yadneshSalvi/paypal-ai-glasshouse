import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AgDataTransaction} from 'ag-studio';
import {applyDeliveryRevision,buildSnapshot,createSeedDataset} from '../packages/domain';
import type {Snapshot,TableRow} from '../packages/domain/types';
import {SnapshotTransactions,widgetsAtSnapshot} from '../packages/studio/snapshot-transactions';

const seed=createSeedDataset('tenant-studio-switch');
const initial=buildSnapshot(seed);
const revised=buildSnapshot(applyDeliveryRevision(seed));
const earlier=buildSnapshot(seed,{asOf:'2026-11-03T00:00:00.000Z'});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function fixture(start:Snapshot,apply?:(call:number)=>Promise<void>){
  const sources=new Map(Object.entries(start.tables).map(([table,rows])=>[table,new Map(rows.map(row=>[row.id,{...row}]))]));
  const applied:string[]=[],settled:string[]=[],prepared:string[]=[],errors:unknown[]=[];
  let calls=0,active=0,peak=0;
  const queue=new SnapshotTransactions(start,{
    prepare:snapshot=>{prepared.push(snapshot.hash);},
    async apply(batch:readonly AgDataTransaction[]){
      active++;peak=Math.max(peak,active);const call=++calls;
      try{
        await apply?.(call);
        for(const transaction of batch){
          const rows=sources.get(transaction.tableId)!;
          for(const id of transaction.remove??[])assert(rows.delete(String(id)),'remove must name an existing row');
          for(const row of transaction.update as TableRow[]??[]){assert(rows.has(row.id),'update must name an existing row');rows.set(row.id,row);}
          for(const row of transaction.add as TableRow[]??[]){assert(!rows.has(row.id),'add must not duplicate an existing row');rows.set(row.id,row);}
        }
      }finally{active--;}
    },
    applied:snapshot=>{applied.push(snapshot.hash);},
    settled:snapshot=>{settled.push(snapshot.hash);},
    failed:error=>{errors.push(error);},
  });
  return {queue,applied,settled,prepared,errors,get calls(){return calls;},get peak(){return peak;},assertSnapshot(snapshot:Snapshot){
    for(const [name,rows] of Object.entries(snapshot.tables))assert.deepEqual([...sources.get(name)!.values()].sort((a,b)=>String(a.id).localeCompare(String(b.id))),[...rows].sort((a,b)=>String(a.id).localeCompare(String(b.id))),name);
  }};
}

test('returning to the current snapshot during an in-flight transaction restores every source and settles only the latest request',async()=>{
  const started=deferred(),release=deferred();
  const state=fixture(initial,async call=>{if(call===1){started.resolve();await release.promise;}});
  const first=state.queue.request(revised);await started.promise;
  const back=state.queue.request(initial);release.resolve();
  assert.equal(await first,'superseded');assert.equal(await back,'settled');
  assert.deepEqual(state.applied,[revised.hash,initial.hash]);
  assert.deepEqual(state.settled,[initial.hash]);assert.equal(state.peak,1);
  state.assertSnapshot(initial);
});

test('rapid clock changes skip unstarted targets and compute add/update/remove from the last actual engine state',async()=>{
  const started=deferred(),release=deferred();
  const state=fixture(initial,async call=>{if(call===1){started.resolve();await release.promise;}});
  const first=state.queue.request(earlier);await started.promise;
  const skipped=state.queue.request(initial),last=state.queue.request(revised);release.resolve();
  assert.deepEqual(await Promise.all([first,skipped,last]),['superseded','superseded','settled']);
  assert.deepEqual(state.applied,[earlier.hash,revised.hash]);assert.deepEqual(state.settled,[revised.hash]);
  assert.equal(state.peak,1);state.assertSnapshot(revised);
});

test('a cancelled unstarted switch keeps the current widget acknowledgements and needs no engine write',async()=>{
  const state=fixture(initial),acknowledgements=new Map([['river',initial.hash],['dial',initial.hash]]);
  const first=state.queue.request(revised),back=state.queue.request(initial);
  assert.deepEqual(await Promise.all([first,back]),['superseded','settled']);
  assert.equal(state.calls,0);assert.deepEqual(state.settled,[initial.hash]);
  assert(widgetsAtSnapshot(['river','dial'],acknowledgements,initial.hash));
  acknowledgements.set('dial',revised.hash);
  assert.equal(widgetsAtSnapshot(['river','dial'],acknowledgements,initial.hash),false);
  assert.equal(widgetsAtSnapshot(['river','dial','new-widget'],acknowledgements,revised.hash),false);
  state.assertSnapshot(initial);
});

test('an engine failure holds the barrier and never applies another delta against an uncertain source state',async()=>{
  const started=deferred(),release=deferred();
  const state=fixture(initial,async()=>{started.resolve();await release.promise;throw new Error('engine transaction rejected');});
  const first=state.queue.request(revised);await started.promise;
  const back=state.queue.request(initial);release.resolve();
  assert.deepEqual(await Promise.all([first,back]),['held','held']);
  assert.equal(await state.queue.request(earlier),'held');
  assert.equal(state.calls,1);assert.equal(state.errors.length,1);assert.equal(state.settled.length,0);
});
