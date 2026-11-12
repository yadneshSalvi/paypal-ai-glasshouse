import test from 'node:test';
import assert from 'node:assert/strict';
import {createDataEngine,type AgDataEngine} from 'ag-studio';
import {instrumentCorpus,times,plus} from './reference/instrument-corpus';
import {buildSnapshot} from '../packages/domain';
import type {Snapshot} from '../packages/domain/types';
import {prepareSnapshot} from '../packages/studio/atomic-snapshot';
import {SnapshotAdmission} from '../packages/studio/snapshot-admission';
import {TemporalPlayback} from '../packages/studio/playback';
import {nativeStudio} from './helpers/studio-native';
import {initialState} from '../packages/studio/registry';
import {inspectHistoryRestore} from '../packages/studio/history';
const corpus=instrumentCorpus(),cut=(asOf=times.end,knownAt=times.known,generationId=0)=>buildSnapshot(corpus,{asOf,knownAt,semanticModelVersion:'commerce-semantic-v2',generationId});
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
async function rows(engine:AgDataEngine,table:string){const [result]=await engine.execute({query:{projection:[{field:{key:'id',sourceId:table,fieldId:'id'},as:'id'},{field:{key:'snapshotHash',sourceId:table,fieldId:'snapshotHash'},as:'snapshotHash'}]},options:{shape:'rows',strict:true}});assert.equal(result.metadata?.error,undefined);assert.equal(result.dataShape,'rows');return result.dataShape==='rows'?result.rows:[];}

test('fresh actual native engines admit complete add/update/remove and K-only revisions, including empty sources',async t=>{
 const snapshots=[cut(plus(times.start,-1)),cut(times.one),cut(times.three,times.four),cut(times.three,times.known),cut(times.end),cut(plus(times.start,-1))],measurements=[];
 for(let index=1;index<snapshots.length;index++){
  const started=performance.now(),prepared=await prepareSnapshot(snapshots[index-1],snapshots[index]);
  measurements.push({from:snapshots[index-1].context.asOf,to:snapshots[index].context.asOf,knownAt:snapshots[index].context.knownAt,totalMs:performance.now()-started,engineMs:prepared.elapsedMs,tables:Object.keys(snapshots[index].tables).length});
  for(const [table,expected] of Object.entries(snapshots[index].tables)){const actual=await rows(prepared.engine,table);assert.equal(actual.length,expected.length,table);assert.ok(actual.every(row=>row.snapshotHash===snapshots[index].hash));}
  prepared.dispose();
 }
 assert.notEqual(snapshots[2].hash,snapshots[3].hash);assert.equal(snapshots[2].context.asOf,snapshots[3].context.asOf);t.diagnostic(JSON.stringify({nativeEngine:'AG Studio 3.1.0',measurements}));
});

test('an actual native write followed by failure discards only the candidate; retry restores exact native history',async t=>{
 const before=cut(times.three,times.four),after=cut(times.three,times.known),active=await nativeStudio(t,initialState,{snapshot:before});
 await active.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'impact-map'}}).apply({widgetId:'map',op:'patch',value:{format:{measure:'late-share'}}});
 const history=copy(active.api.getHistory()),original=await rows(active.api.getDataEngine()!,'order_snapshot');let discarded=0,mutated=0;
 await assert.rejects(prepareSnapshot(before,after,data=>{
  const engine=createDataEngine(data),apply=engine.applyTransaction!.bind(engine),dispose=engine.dispose!.bind(engine);
  engine.applyTransaction=(async(transaction:never)=>{await apply(transaction);mutated++;throw new Error('Injected transport failure after actual native mutation.');}) as typeof engine.applyTransaction;
  engine.dispose=()=>{discarded++;dispose();};return engine;
 }),/after actual native mutation/);
 assert.equal(mutated,1);assert.equal(discarded,1);assert.deepEqual(await rows(active.api.getDataEngine()!,'order_snapshot'),original);assert.deepEqual(copy(active.api.getHistory()),history);
 const retry=await prepareSnapshot(before,after);active.destroy();const restored=await nativeStudio(t,history,{snapshot:after,engine:retry.engine});
 assert.equal(inspectHistoryRestore(restored.api,history).state,'restored');assert.deepEqual(copy(restored.api.getHistory()),history);assert.ok((await rows(restored.api.getDataEngine()!,'order_snapshot')).every(row=>row.snapshotHash===after.hash));
 restored.api.undo();assert.equal(restored.api.getHistory().redo.length,1);restored.api.redo();assert.equal(inspectHistoryRestore(restored.api,history).state,'restored');assert.deepEqual(restored.errors,[]);await new Promise(resolve=>setTimeout(resolve,50));restored.destroy();retry.dispose();
});

test('hash, table, tenant and policy corruption are rejected before a candidate engine is admitted',async()=>{
 const previous=cut(times.three,times.four),next=cut();let creations=0;
 for(const change of [
  (source:Snapshot)=>{source.tables.order_snapshot[0].capturedMinor=999999;},
  (source:Snapshot)=>{source.tables.order_snapshot[0].snapshotHash='wrong';},
  (source:Snapshot)=>{source.totals.capturedMinor++;},
  (source:Snapshot)=>{source.context.knownAt=times.start;},
  (source:Snapshot)=>{source.context.tenantId='foreign';},
  (source:Snapshot)=>{source.context.rolePolicyVersion='roles-v1:99';},
 ]){const bad=structuredClone(next);change(bad);await assert.rejects(prepareSnapshot(previous,bad,data=>{creations++;return createDataEngine(data);}));}
 assert.equal(creations,0);
});

test('request generations reject out-of-order responses and reconnect regressions while permitting an intentional rewind',()=>{
 const gate=new SnapshotAdmission(),authority=cut().context,a=gate.begin(),b=gate.begin();
 assert.equal(gate.acceptResponse(a,cut(times.end,times.known,a),authority),false);assert.equal(gate.acceptResponse(b,cut(times.end,times.known,b),authority),true);
 const c=gate.begin();assert.equal(gate.acceptResponse(c,cut(times.three,times.known,c),authority,true),false);assert.equal(gate.acceptResponse(c,cut(times.end,times.four,c),authority,true),false);
 const wrong=cut(times.end,times.known,c);wrong.context.tenantId='foreign';assert.equal(gate.acceptResponse(c,wrong,authority),false);
 const oldProjection=cut(times.end,times.known,c);oldProjection.context.projectionVersion--;assert.equal(gate.acceptResponse(c,oldProjection,authority),false);
 assert.equal(gate.acceptResponse(c,cut(times.three,times.four,c),authority),true);gate.cancel();assert.equal(gate.acceptResponse(c,cut(times.three,times.four,c),authority),false);
});

test('playback issues only the next intent after a committed report and never advances K',async()=>{
 const requests:{t:string;k:string;clock:string}[]=[],playback=new TemporalPlayback((t,k,clock)=>requests.push({t,k,clock}),15),snapshot=cut(times.start,times.known);
 playback.start(snapshot,{start:times.start,end:plus(times.start,30),stepMinutes:10});assert.equal(playback.getSnapshot(),true);assert.equal(requests.length,1);assert.equal(requests[0].t,plus(times.start,10));
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(requests.length,1,'An uncommitted source may not advance playback.');
 playback.committed(cut(requests[0].t,times.known));await new Promise(resolve=>setTimeout(resolve,25));assert.equal(requests.length,2);assert.equal(requests[1].t,plus(times.start,20));assert.equal(requests[1].k,times.known);
 playback.committed(cut(requests[1].t,times.known));playback.pause();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(requests.length,2);assert.equal(playback.getSnapshot(),false);
 assert.throws(()=>playback.start(snapshot,{start:times.end,end:times.start,stepMinutes:10}));playback.dispose();
});
