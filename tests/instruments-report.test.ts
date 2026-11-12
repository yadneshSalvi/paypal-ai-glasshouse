import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {reportHarness} from './helpers/reports';
import {nativeStudio} from './helpers/studio-native';
import {initialState} from '../packages/studio/registry';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {renderReportPdf,REPORT_RENDERER_VERSION} from '../lib/server/reports/pdf';
import {NATIVE_REPORT_RENDERER_VERSION} from '../packages/reports/renderer';
import {hash,persistDataset} from '../lib/server/repository';
import {saveLayout} from '../lib/server/layouts';
import {applyDeliveryRevision} from '../packages/domain';
import {nativePrint} from '../packages/studio/native-print';

test('new v2 A4 and Letter editions retain every exact native row and preserve their bytes after source corrections',async t=>{
 const h=await reportHarness(t,'judge',2),native=await nativeStudio(t,initialState,{snapshot:h.snapshot});
 await native.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId:'authored-capture-chart',type:'column-chart-grouped',xTrack:0,yTrack:210,xSpan:24,ySpan:20});
 await native.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'column-chart-grouped'}}).apply({widgetId:'authored-capture-chart',op:'patch',value:{dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.capturedMinor',aggregation:'sum' as const}]},format:{title:{enabled:true,text:'Complete capture value by region'}}}});
 const history=JSON.parse(JSON.stringify(native.api.getHistory()));native.destroy();await saveLayout(h.db,h.scoped,{history,expectedVersion:1});
 const report=await h.service.create(h.scoped,h.input({title:'Synthetic native instrument qualification',description:'All 600 payment records, shipments and source excerpts in this local qualification are explicitly fictional. No provider or model was contacted. The saved tables include every result row.',expectedLayoutVersion:2,expectedLayoutHash:hash(history)}));
 assert.equal(report.document.schemaVersion,2);assert.equal(report.document.coverage.staticInstruments,'exact_native_queries');
 const expected=JSON.parse(JSON.stringify(await nativePrint(h.snapshot,history.current,report.document.createdAt)));
 if(hash(report.document.nativePrint)!==hash(expected)){const diffFolder='.private/print-parity-diff-'+new Date().toISOString().replaceAll(':','-');await mkdir(diffFolder,{recursive:true,mode:0o700});await writeFile(diffFolder+'/actual.json',JSON.stringify(report.document.nativePrint),{mode:0o600,flag:'wx'});await writeFile(diffFolder+'/expected.json',JSON.stringify(expected),{mode:0o600,flag:'wx'});}assert.equal(hash(report.document.nativePrint),hash(expected),'Exact native report results must match their detached frozen-source reference.');assert.ok(expected.widgets.every((widget:{status:string})=>widget.status==='exact'));
 const evidence=expected.widgets.find((widget:{widgetId:string})=>widget.widgetId==='evidence');assert.equal(evidence.rows.length,h.snapshot.evidence.length);
 const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:renderReportPdf}),folder='.private/pdf-v2-'+new Date().toISOString().replaceAll(':','-');await mkdir(folder,{recursive:true,mode:0o700});
 const outputs=[];
 for(const paper of ['A4','LETTER'] as const){
  const started=performance.now(),pdf=await service.pdf(h.scoped,report.summary.id,paper);assert.equal(pdf.rendererVersion,NATIVE_REPORT_RENDERER_VERSION);assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.pages>40&&pdf.pages<=800);
  assert.equal((pdf.bytes.toString('latin1').match(/\/Type\s*\/Page(?=\s|\/)/g)??[]).length,pdf.pages,'Page objects and recorded pagination agree.');
  const warm=performance.now();assert.deepEqual(await service.pdf(h.scoped,report.summary.id,paper),pdf);outputs.push({paper,pages:pdf.pages,bytes:pdf.bytes.length,hash:pdf.hash,coldMs:warm-started,warmMs:performance.now()-warm});
  await writeFile(folder+'/exact-native-'+paper+'.pdf',pdf.bytes,{mode:0o600});
 }
 await writeFile(folder+'/edition.json',JSON.stringify(report,null,2),{mode:0o600});await writeFile(folder+'/metrics.json',JSON.stringify(outputs,null,2),{mode:0o600});
 await persistDataset(h.db,applyDeliveryRevision(h.dataset));assert.deepEqual(await service.read(h.scoped,report.summary.id),report);
 for(const output of outputs)assert.equal((await service.pdf(h.scoped,report.summary.id,output.paper)).hash,output.hash);
 assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);assert.equal((await h.db.query('SELECT provider_id FROM gh_provider_resources')).length,0);
 t.diagnostic(JSON.stringify({artifactFolder:folder,exactNativeWidgets:expected.widgets.length,completeSourceEvidence:evidence.rows.length,outputs,providerCalls:0,modelCalls:0}));
});

test('new immutable static exports preserve selected mappings and explain unsupported authored configurations',async t=>{
 const h=await reportHarness(t,'judge',2),state=structuredClone(initialState);
 state.pages[0].crossFilter={values:{map:[{type:'value',field:{id:'order_snapshot.regionCode'},values:['PNW'],group:0}]}};
 state.pages[0].widgets!.river!.dataMapping={orderId:[{id:'order_snapshot.id'}],snapshot:[{id:'order_snapshot.snapshotHash'}],category:[{id:'order_snapshot.paymentState'}],value:[{id:'order_snapshot.capturedMinor',aggregation:'sum' as const}]};
 state.pages[0].widgets!.river!.format={measure:'value' as const,crossFilter:'highlight'};
 state.pages[0].widgets!['unsupported-view']={type:'grid',dataMapping:{cols:[{id:'order_snapshot.regionCode'},{id:'capture_snapshot.amountMinor',aggregation:'sum' as const}]}};
 state.pages[0].widgetLayout!['unsupported-view']={xTrack:0,yTrack:210,xSpan:24,ySpan:20};
 const native=await nativeStudio(t,state,{snapshot:h.snapshot}),history=JSON.parse(JSON.stringify(native.api.getHistory()));native.destroy();await saveLayout(h.db,h.scoped,{history,expectedVersion:1});
 const report=await h.service.create(h.scoped,h.input({expectedLayoutVersion:2,expectedLayoutHash:hash(history)})),widgets=report.document.nativePrint!.widgets;
 const river=widgets.find(widget=>widget.widgetId==='river')!.instrument!,selected=h.snapshot.orders.filter(order=>order.regionCode==='PNW');assert.equal(river.selected,selected.length);assert.equal(river.scope,h.snapshot.orders.length);assert.equal(river.groups.reduce((sum,group)=>sum+group.selected,0),selected.reduce((sum,order)=>sum+order.capturedMinor!,0));
 const unsupported=widgets.find(widget=>widget.widgetId==='unsupported-view')!;assert.equal(unsupported.status,'unsupported');assert.match(unsupported.reason!,/source grains/);assert.deepEqual(unsupported.rows,[]);assert.deepEqual(unsupported.mapping,state.pages[0].widgets!['unsupported-view']!.dataMapping);
});
