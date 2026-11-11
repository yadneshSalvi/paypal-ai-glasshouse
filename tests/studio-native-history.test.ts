import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AgReportHistory,AgWidgetState} from 'ag-studio';
import type {GlasshouseRegistry} from '../packages/studio/types';
import {inspectHistoryRestore} from '../packages/studio/history';
import {nativeStudio} from './helpers/studio-native';

const widgetId='history-regression-chart';
const chart:AgWidgetState<GlasshouseRegistry>={type:'column-chart-grouped',dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.supportContacts',aggregation:'sum'}],legendKey:[],tooltipKey:[]},format:{title:{enabled:true,text:'Sample support contacts by region'}}};
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;

test('actual native add/configure history survives JSON reload and undo/redo while preserving entry identity',async t=>{
  const first=await nativeStudio(t);
  const added=await first.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId,type:'column-chart-grouped',xTrack:0,yTrack:200,xSpan:24,ySpan:20});
  assert.equal(added.success,true,JSON.stringify(added));
  const configured=await first.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'column-chart-grouped'}}).apply({widgetId,op:'patch',value:chart});
  assert.equal(configured.success,true,JSON.stringify(configured));
  const saved=copy(first.api.getHistory());
  assert.equal(saved.undo.length,2);assert.equal(saved.redo.length,0);
  assert.deepEqual(saved.undo[1].state.pages[0].widgets?.[widgetId],{type:'column-chart-grouped'});
  assert.deepEqual(first.errors,[]);first.destroy();
  const restored=await nativeStudio(t,saved),native=restored.api.getHistory();
  assert.deepEqual(copy(native.undo[1].state.pages[0].widgets?.[widgetId]),{type:'column-chart-grouped',dataMapping:{}});
  assert.equal(inspectHistoryRestore(restored.api,saved).state,'restored');
  const identities=(history:AgReportHistory<GlasshouseRegistry>)=>copy(history.undo.map(({state,label,...identity})=>identity));
  assert.deepEqual(identities(native),identities(saved));
  restored.api.undo();restored.api.undo();
  assert.equal(restored.api.getHistory().undo.length,0);assert.equal(restored.api.getHistory().redo.length,2);
  assert.equal(Object.keys(restored.api.getState().pages[0].widgets??{}).length,7);
  const undone=copy(restored.api.getHistory());restored.destroy();
  const resumed=await nativeStudio(t,undone);
  const resumedStatus=inspectHistoryRestore(resumed.api,undone);assert.equal(resumedStatus.state,'restored',JSON.stringify({status:resumedStatus,redo:resumed.api.getHistory().redo.map((entry,index)=>({id:entry.id,savedId:undone.redo[index].id,admitted:entry.state.pages[0].widgets?.[widgetId],saved:undone.redo[index].state.pages[0].widgets?.[widgetId],mappingKeys:Object.keys(entry.state.pages[0].widgets?.[widgetId]?.dataMapping??{}),entryKeys:Object.keys(entry)}))}));
  resumed.api.redo();resumed.api.redo();
  assert.equal(resumed.api.getHistory().undo.length,2);assert.equal(resumed.api.getHistory().redo.length,0);
  assert.deepEqual(copy(resumed.api.getState().pages[0].widgets?.[widgetId]),chart);
  assert.deepEqual(identities(resumed.api.getHistory()),identities(saved));
  assert.deepEqual(resumed.errors,[]);
});

test('native restoration still rejects changed mappings, settings and historical source identities',async t=>{
  const fixture=await nativeStudio(t);
  await fixture.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId,type:'column-chart-grouped',xTrack:0,yTrack:200,xSpan:24,ySpan:20});
  await fixture.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'column-chart-grouped'}}).apply({widgetId,op:'patch',value:chart});
  const original=copy(fixture.api.getHistory());
  assert.equal(original.undo.length,2);
  const mutations:((history:AgReportHistory<GlasshouseRegistry>)=>void)[]=[
    history=>{history.undo[1].state.pages[0].widgets![widgetId]={type:'column-chart-grouped',dataMapping:{categoryKey:[],valueKey:[{id:'order_snapshot.supportContacts',aggregation:'sum'}]}};},
    history=>{history.current.pages[0].widgets![widgetId]={...chart,dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.amountMinor',aggregation:'sum'}]}};},
    history=>{history.undo[1].state.pages[0].widgets![widgetId]={type:'column-chart-grouped',format:{}} as AgWidgetState<GlasshouseRegistry>;},
    history=>{history.undo[1].id='changed-entry-identity';},
    history=>{history.undo[1].at+=1;},
    history=>{history.undo[1].source={type:'ui'};},
    history=>{history.undo[1].focus={selectedPageId:'incident-room',pageSelection:{type:'widget',id:'different-widget'}};},
  ];
  for(const mutate of mutations){const altered=copy(original);mutate(altered);assert.equal(inspectHistoryRestore(fixture.api,altered).state,'unavailable');}
  assert.deepEqual(copy(fixture.api.getHistory()),original,'The guard never rewrites native or saved history.');
  assert.deepEqual(fixture.errors,[]);
});
