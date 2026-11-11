import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {reportHarness} from './helpers/reports';
import {failure} from './helpers/workspaces';
import {nativeStudio} from './helpers/studio-native';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {REPORT_RENDERER_VERSION,renderReportPdf} from '../lib/server/reports/pdf';
import {hash} from '../lib/server/repository';
import {saveLayout} from '../lib/server/layouts';

test('the actual offline PDF renderer produces and caches A4 and Letter editions with complete native evidence',async t=>{
  const h=await reportHarness(t),native=await nativeStudio(t),plan=await h.plan();
  await native.api.defineAiCommand({type:'AgAddWidgetCommand'}).apply({widgetId:'report-proof-chart',type:'column-chart-grouped',xTrack:0,yTrack:200,xSpan:24,ySpan:20});
  await native.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'column-chart-grouped'}}).apply({widgetId:'report-proof-chart',op:'patch',value:{dataMapping:{categoryKey:[{id:'order_snapshot.regionCode'}],valueKey:[{id:'order_snapshot.supportContacts',aggregation:'sum'}]}}});
  const history=JSON.parse(JSON.stringify(native.api.getHistory()));native.destroy();
  await saveLayout(h.db,h.scoped,{history,expectedVersion:1});
  const report=await h.service.create(h.scoped,h.input({title:'The late handoff.',description:'A source-bound Sample investigation, preserved for the next decision. All payments and shipments in this qualification edition are fictional; no provider was contacted.',expectedLayoutVersion:2,expectedLayoutHash:hash(history),planIds:[plan.id]}));
  let renders=0;const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:async(...args)=>{renders++;return renderReportPdf(...args);}});
  const evidence=[];
  for(const paper of ['A4','LETTER'] as const){
    const pdf=await service.pdf(h.scoped,report.summary.id,paper);
    assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');assert(pdf.pages>=8&&pdf.pages<=40);assert(pdf.bytes.length>10000&&pdf.bytes.length<32_000_000);
    assert.equal((pdf.bytes.toString('latin1').match(/\/Type\s*\/Page(?=\s|\/)/g)??[]).length,pdf.pages,'The emitted page objects must match the recorded pagination; footers may not create extra pages.');
    assert.deepEqual(await service.pdf(h.scoped,report.summary.id,paper),pdf);
    evidence.push({paper,bytes:pdf.bytes.length,pages:pdf.pages,hash:pdf.hash,renderer:pdf.rendererVersion});
    if(process.env.GLASSHOUSE_REPORT_ARTIFACTS==='true'){const root=join(process.cwd(),'.setup-evidence/organization-export-stage6/output/pdf');await mkdir(root,{recursive:true});await writeFile(join(root,'glasshouse-sample-'+paper.toLowerCase()+'.pdf'),pdf.bytes);}
  }
  assert.equal(renders,2);assert.equal((await h.db.query('SELECT * FROM gh_operations')).length,0);assert.equal((await h.db.query('SELECT * FROM gh_payment_commands')).length,0);
  if(process.env.GLASSHOUSE_REPORT_ARTIFACTS==='true'){
    const root=join(process.cwd(),'.setup-evidence/organization-export-stage6/output/pdf');await writeFile(join(root,'edition.json'),JSON.stringify(report,null,2));await writeFile(join(root,'pdf-build-evidence.json'),JSON.stringify({transport:'none; all domain data synthetic Sample fixtures',nativeEngine:'actual installed AG Studio 3.1.0, JSDOM state/history only',financialActions:0,modelCalls:0,documentHash:report.summary.documentHash,files:evidence},null,2));
  }
});

test('unsupported font coverage and invalid paper leave the exact readable report available',async t=>{
  const h=await reportHarness(t),report=await h.service.create(h.scoped,h.input({title:'字体覆盖测试'}));
  const service=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:renderReportPdf});
  await assert.rejects(service.pdf(h.scoped,report.summary.id,'A4'),failure('REPORT_FONT_COVERAGE'));
  assert.deepEqual(await service.read(h.scoped,report.summary.id),report);
  await assert.rejects(service.pdf(h.scoped,report.summary.id,'A3' as never),failure('INVALID_REPORT_PAPER'));
  assert.equal((await h.db.query<{state:string}>('SELECT state FROM gh_report_pdf'))[0].state,'failed');
});

test('the largest admitted title and description paginate without implicit blank pages or a displaced cover panel',async t=>{
  const h=await reportHarness(t),report=await h.service.create(h.scoped,h.input({title:('The recorded investigation and its evidence. ').repeat(4).slice(0,120),description:('A source-bound Sample report keeps its clocks, provenance and exact saved choices. ').repeat(20).slice(0,1200)}));
  for(const paper of ['A4','LETTER'] as const){
    const pdf=await renderReportPdf(report,paper);
    assert.equal((pdf.bytes.toString('latin1').match(/\/Type\s*\/Page(?=\s|\/)/g)??[]).length,pdf.pages);
    assert(pdf.pages<30);
    if(process.env.GLASSHOUSE_REPORT_ARTIFACTS==='true')await writeFile(join(process.cwd(),'.setup-evidence/organization-export-stage6/output/pdf','maximum-copy-'+paper.toLowerCase()+'.pdf'),pdf.bytes);
  }
});
