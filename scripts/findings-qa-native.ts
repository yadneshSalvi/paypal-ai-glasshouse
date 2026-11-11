import {test} from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {nativeStudio} from '../tests/helpers/studio-native';
if(!process.env.GLASSHOUSE_FINDING_ISOLATED_QA?.startsWith('gh_findings_stage10_')||process.env.PORT!=='4545')throw new Error('Dedicated finding qualification environment required.');
test('prepare an actual installed Studio state/history fixture without a browser or model claim',async t=>{
  const native=await nativeStudio(t);await native.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId:'finding-fixture-comparison',type:'column-chart-grouped',xTrack:0,yTrack:200,xSpan:24,ySpan:20});
  await native.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'column-chart-grouped'}}).apply({widgetId:'finding-fixture-comparison',op:'patch',value:{dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.supportContacts',aggregation:'sum'}]}}});
  const history=native.api.getHistory();await mkdir('.qualification',{recursive:true});await writeFile('.qualification/native-history.json',JSON.stringify(history,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({history:'actual installed AG Studio 3.1.0 with JSDOM state only',undo:history.undo.length,redo:history.redo.length,browserQualification:false,modelCalls:0,providerCalls:0}));
});
