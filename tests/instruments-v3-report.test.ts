import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {ReportNativeChart} from '../components/report-native-chart';
import {reportHarness} from './helpers/reports';
import {nativeStudio} from './helpers/studio-native';
import {instrumentCorpus,times} from './reference/instrument-corpus';
import {initialState} from '../packages/studio/registry';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {renderReportPdf,REPORT_RENDERER_VERSION} from '../lib/server/reports/pdf';
import {NATIVE_REPORT_RENDERER_VERSION} from '../packages/reports/renderer';
import {hash,persistDataset} from '../lib/server/repository';
import {saveLayout} from '../lib/server/layouts';
import {snapshotContext} from '../lib/server/snapshots';
import {ensureInstrumentSchema} from '../lib/server/instruments/schema';
import {buildSnapshot} from '../packages/domain';
import {COMMERCE_SEMANTICS} from '../packages/domain/commerce-resources';
import type {InstrumentData} from '../packages/studio/types';

test('current-v3 immutable A4 and Letter editions preserve independent original/selected daily and baseline values',async t=>{
  // The established helper intentionally pins v2. This case explicitly admits
  // current-v3 content from its own fictional resource corpus and isolated SQL.
  const h=await reportHarness(t,'judge',2),dataset=instrumentCorpus(h.saved.tenantId);
  await ensureInstrumentSchema(h.db);
  for(const event of dataset.events)if(event.sourceClass==='sandbox'){
    event.sourceClass='sample';event.sourceLabel='Fictional PDF qualification case';
    delete event.payload.receiptHash;delete event.payload.disputeId;delete event.payload.sellerResponseDueAt;
    event.payload.simulated=true;
  }
  for(const interval of dataset.intervals)if(interval.sourceClass==='sandbox')interval.sourceClass='sample';
  await persistDataset(h.db,dataset);
  const context={...snapshotContext(h.scoped,dataset),asOf:times.end,knownAt:times.known,semanticModelVersion:COMMERCE_SEMANTICS};
  const snapshot=await h.saveSnapshot(buildSnapshot(dataset,context)),state=structuredClone(initialState);
  (state.pages[0].widgets!.map as InstrumentData).format={crossFilter:'highlight',displayMode:'small-multiples',measure:'late-share'};
  state.pages[0].crossFilter={values:{map:[{type:'value',field:{id:'order_snapshot.regionCode'},values:['PNW'],group:0}],records:[{type:'value',field:{id:'order_snapshot.id'},values:['a','d'],group:0}]}};
  const native=await nativeStudio(t,state,{snapshot}),history=JSON.parse(JSON.stringify(native.api.getHistory()));native.destroy();
  await saveLayout(h.db,h.scoped,{history,expectedVersion:1});
  const report=await h.service.create(h.scoped,h.input({title:'Synthetic v3 regional reference edition',description:'Hand-authored fictional resource ledger. Historical reference is a measured inventory at a stated time; no statistical interval or provider event is claimed.',snapshotHash:snapshot.hash,expectedLayoutVersion:2,expectedLayoutHash:hash(history)}));
  assert.equal(report.document.schemaVersion,2);
  assert.equal(report.document.snapshot.context.semanticModelVersion,COMMERCE_SEMANTICS);
  assert.equal(Object.keys(report.document.snapshot.tables).length,12);
  assert.ok(report.document.nativePrint!.widgets.every(widget=>widget.status==='exact'));
  const mapWidget=report.document.nativePrint!.widgets.find(widget=>widget.widgetId==='map')!,map=mapWidget.instrument!;
  assert.equal(map.scope,6);assert.equal(map.selected,2);
  const pnw=map.groups.find(group=>group.key==='PNW')!,unknown=map.groups.find(group=>group.key==='UNKNOWN')!;
  assert.deepEqual(pnw.orderIds.slice().sort(),['a','b','d']);assert.deepEqual(pnw.selectedOrderIds.slice().sort(),['a','d']);
  assert.deepEqual(pnw.baseline,{at:'2026-11-03T07:59:59.999Z',originalValue:2/3,selectedValue:2/3,originalOrderCount:3,selectedOrderCount:2,originalNumerator:2,originalDenominator:3,selectedNumerator:2,selectedDenominator:3});
  const finalDay=pnw.daily!.find(row=>row.day==='2026-11-06')!;
  assert.equal(finalDay.originalValue,2/4);assert.equal(finalDay.selectedValue,1/3);
  assert.equal(finalDay.originalOrderCount,3);assert.equal(finalDay.selectedOrderCount,2);
  assert.equal(finalDay.originalNumerator,2);assert.equal(finalDay.originalDenominator,4);assert.equal(finalDay.selectedNumerator,1);assert.equal(finalDay.selectedDenominator,3);
  assert.equal(unknown.baseline!.originalValue,null);assert.equal(unknown.baseline!.originalDenominator,0);
  assert.equal(unknown.baseline!.selectedValue,null);assert.equal(unknown.baseline!.selectedOrderCount,0);
  const baselineRow=map.rows.find(row=>row.Region==='Pacific Northwest'&&row.Period==='Historical baseline')!;
  assert.deepEqual(baselineRow,{'Region':'Pacific Northwest','Period':'Historical baseline','Time':'2026-11-03T07:59:59.999Z','Original value':2/3,'Selected value':2/3,'Original orders':3,'Selected orders':2,'Original late':2,'Original due':3,'Selected late':2,'Selected due':3});
  const unknownRow=map.rows.find(row=>row.Region==='Unknown region'&&row.Period==='Historical baseline')!;
  assert.equal(unknownRow['Original value'],null);assert.equal(unknownRow['Selected value'],null);
  const chart=new JSDOM(renderToStaticMarkup(createElement(ReportNativeChart,{widget:mapWidget})));
  try{
    const figures=[...chart.window.document.querySelectorAll('figure')],pnwFigure=figures.find(figure=>figure.querySelector('figcaption')?.textContent==='Pacific Northwest')!;
    const historical=pnwFigure.querySelector('[data-series="historical-original"]')!;
    assert.equal(historical.getAttribute('data-reference-at'),pnw.baseline!.at);
    assert.equal(Number(historical.getAttribute('data-value')),2/3);
    assert.equal(Number(historical.getAttribute('data-denominator')),3);
    const day=pnwFigure.querySelector('[data-history-day="2026-11-06"]')!;
    assert.equal(Number(day.querySelector('[data-series="original"]')!.getAttribute('data-value')),1/2);
    assert.equal(Number(day.querySelector('[data-series="selected"]')!.getAttribute('data-value')),1/3);
    assert.ok(pnwFigure.textContent?.includes('original 66.7% · 3 orders · 2/3 late/due shipments'));
    const unknownFigure=figures.find(figure=>figure.querySelector('figcaption')?.textContent==='Unknown region')!;
    assert.equal(unknownFigure.querySelectorAll('[data-series="historical-original"]').length,0);
    assert.ok(unknownFigure.textContent?.includes('Unknown (no denominator)'));
    assert.equal(unknownFigure.querySelectorAll('[data-series="original-unknown"]').length,unknown.daily!.length);
  }finally{chart.window.close();}

  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:renderReportPdf});
  const folder='.private/pdf-v3-'+new Date().toISOString().replaceAll(':','-');await mkdir(folder,{recursive:true,mode:0o700});
  const outputs=[];
  for(const paper of ['A4','LETTER'] as const){
    const started=performance.now(),pdf=await service.pdf(h.scoped,report.summary.id,paper),coldMs=performance.now()-started;
    assert.equal(pdf.rendererVersion,NATIVE_REPORT_RENDERER_VERSION);assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.pages>7&&pdf.pages<100);
    assert.equal((pdf.bytes.toString('latin1').match(/\/Type\s*\/Page(?=\s|\/)/g)??[]).length,pdf.pages);
    const warm=performance.now();assert.deepEqual(await service.pdf(h.scoped,report.summary.id,paper),pdf);
    outputs.push({paper,pages:pdf.pages,bytes:pdf.bytes.length,hash:pdf.hash,coldMs,warmMs:performance.now()-warm});
    await writeFile(folder+'/regional-reference-'+paper+'.pdf',pdf.bytes,{mode:0o600,flag:'wx'});
  }
  await writeFile(folder+'/edition.json',JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
  await writeFile(folder+'/metrics.json',JSON.stringify(outputs,null,2),{mode:0o600,flag:'wx'});
  // A later source amendment may change a new reconstruction, never these bytes.
  const change=structuredClone(dataset.commerceFacts!.find(row=>row.resourceId==='sample:ship-a-1')!);
  dataset.commerceFacts!.push({...change,id:'sample:pdf-later-delivery',state:'delivered',narrativeTime:times.three,occurredAt:times.three,ingestedAt:'2026-11-09T00:00:00.000Z',revision:10});dataset.revision++;
  await persistDataset(h.db,dataset);
  assert.deepEqual(await service.read(h.scoped,report.summary.id),report);
  for(const output of outputs)assert.equal((await service.pdf(h.scoped,report.summary.id,output.paper)).hash,output.hash);
  assert.equal((await h.db.query('SELECT id FROM gh_operations')).length,0);
  assert.equal((await h.db.query('SELECT provider_id FROM gh_provider_resources')).length,0);
  t.diagnostic(JSON.stringify({artifactFolder:folder,semanticModelVersion:COMMERCE_SEMANTICS,nativeWidgets:report.document.nativePrint!.widgets.length,completeMapRows:map.rows.length,outputs,providerCalls:0,modelCalls:0}));
});
