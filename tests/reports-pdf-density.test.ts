import test from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import {reportHarness} from './helpers/reports';
import {failure} from './helpers/workspaces';
import {ReportService} from '../lib/server/reports/service';
import {ReportSecrets} from '../lib/server/reports/crypto';
import {AgentSecrets} from '../lib/server/agents/security';
import {renderReportPdf} from '../lib/server/reports/pdf';
import {REPORT_RENDERER_VERSION,NATIVE_REPORT_RENDERER_VERSION,PRIOR_NATIVE_REPORT_RENDERERS} from '../packages/reports/renderer';
import {hash} from '../lib/server/repository';

test('dense native evidence prints every field in A4 and Letter, including citations continued across pages',async t=>{
  const h=await reportHarness(t,'judge',2),report=await h.service.create(h.scoped,h.input());
  const columns=['Evidence','Order','Kind','Source','Event time','Known at','Excerpt','Supports','Contradicts'];
  const rows=Array.from({length:2070},(_,index)=>({
    Evidence:`SYNTHETIC_DENSE_EVIDENCE_${String(index).padStart(5,'0')}`,Order:`SYNTHETIC_ORDER_${String(index).padStart(5,'0')}`,
    Kind:'source-note',Source:'Sample', 'Event time':'2026-11-06T10:00:00.000Z','Known at':'2026-11-07T11:00:00.000Z',
    Excerpt:`Synthetic record ${index}. This complete excerpt is printed with its exact source identity and clocks. No model or provider was contacted.`,
    Supports:index===7?Array.from({length:400},(_,citation)=>`synthetic-citation-${String(citation).padStart(4,'0')}`).join(', '):`synthetic-citation-${index}-a, synthetic-citation-${index}-b`,
    Contradicts:index%5===0?`synthetic-counterpoint-${index}`:'',
  }));
  report.document.title='Explicitly synthetic dense print qualification';
  report.document.nativePrint!.widgets=[{pageId:'synthetic',widgetId:'dense-evidence',type:'evidence-lens',title:'Complete synthetic evidence',status:'exact',columns,rows,mapping:{},filter:null}];
  report.summary.documentHash=hash(report.document);
  const originalHash=report.summary.documentHash,originalText=PDFDocument.prototype.text;
  let captured:string[][]=[],current=-1;
  const normalize=(value:string)=>value.replace(/\s/g,'');
  PDFDocument.prototype.text=function(this:PDFKit.PDFDocument,...args:Parameters<typeof originalText>){
    const [value,x,y,options]=args as unknown as [string,number,number,PDFKit.Mixins.TextOptions];
    const marker=typeof value==='string'?/^Row (\d+) of 2070$/.exec(value):null;
    if(marker){current=Number(marker[1])-1;captured[current]=[];}
    else if(current>=0&&typeof value==='string'&&y!==25&&y!==29&&!value.startsWith('CONTINUED / ')&&!value.startsWith('PRIVATE / ')&&y<this.page.height-62)captured[current].push(value);
    if(typeof value==='string'&&typeof y==='number'&&options?.width&&y<this.page.height-62){
      assert.ok(x>=48-0.01&&x+options.width<=this.page.width-48+0.01,'A printed value crossed the horizontal page bounds');
      assert.ok(y+this.heightOfString(value,options)<=this.page.height-62+0.01,'A printed value crossed the content footer');
    }
    return originalText.apply(this,args);
  } as typeof originalText;
  try{
    for(const paper of ['A4','LETTER'] as const){
      captured=[];current=-1;
      const pdf=await renderReportPdf(report,paper);
      assert.ok(pdf.pages>100&&pdf.pages<=800);assert.ok(pdf.bytes.length<32_000_000);
      assert.equal((pdf.bytes.toString('latin1').match(/\/Type\s*\/Page(?=\s|\/)/g)??[]).length,pdf.pages,'Implicit overflow must not create uncounted pages');
      assert.equal(captured.length,rows.length);
      rows.forEach((row,index)=>{
        const expected=columns.map(column=>`${column}: ${row[column as keyof typeof row]}`).join('');
        assert.ok(normalize(captured[index].join('')).startsWith(normalize(expected)),`Complete row ${index+1} did not reach the actual PDF text renderer`);
      });
      assert.equal(hash(report.document),originalHash);
    }
  }finally{PDFDocument.prototype.text=originalText;}
});

test('a renderer upgrade keeps completed bytes and failed attempts under their original versions',async t=>{
  const h=await reportHarness(t,'judge',2),report=await h.service.create(h.scoped,h.input());
  const bytes=Buffer.from('%PDF-1.7\nExplicitly synthetic cached representation; no delivered PDF claim.\n%%EOF');
  const old=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:PRIOR_NATIVE_REPORT_RENDERERS[0],render:async(_report,paper)=>{
    if(paper==='LETTER')throw new Error('Explicitly synthetic old renderer failure');
    return {bytes,pages:1};
  }});
  const completed=await old.pdf(h.scoped,report.summary.id,'A4');
  await assert.rejects(old.pdf(h.scoped,report.summary.id,'LETTER'),failure('REPORT_PDF_FAILED'));
  const before=await h.db.query('SELECT * FROM gh_report_pdf ORDER BY paper');let renders=0;
  const current=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:async(...args)=>{renders++;return renderReportPdf(...args);}});
  assert.deepEqual(await current.pdf(h.scoped,report.summary.id,'A4'),completed);assert.equal(renders,0);
  const recovered=await current.pdf(h.scoped,report.summary.id,'LETTER');
  assert.equal(recovered.rendererVersion,NATIVE_REPORT_RENDERER_VERSION);assert.equal(renders,1);
  assert.deepEqual(await current.pdf(h.scoped,report.summary.id,'LETTER'),recovered);assert.equal(renders,1);
  assert.deepEqual(await h.db.query('SELECT * FROM gh_report_pdf WHERE renderer_version=$1 ORDER BY paper',[PRIOR_NATIVE_REPORT_RENDERERS[0]]),before,'An upgrade may not rewrite a ready PDF or its failed predecessor');
  assert.deepEqual(await current.read(h.scoped,report.summary.id),report);
  assert.equal((await h.db.query('SELECT * FROM gh_operations')).length,0);
});

test('an active prior-version lease holds a new renderer until the original outcome is known',async t=>{
  const h=await reportHarness(t,'judge',2),report=await h.service.create(h.scoped,h.input());
  let release!:(value:void)=>void,started!:(value:void)=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  const old=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:PRIOR_NATIVE_REPORT_RENDERERS[0],render:async()=>{started();await wait;return {bytes:Buffer.from('%PDF-1.7\nSynthetic retained lease fixture\n%%EOF'),pages:1};}});
  const pending=old.pdf(h.scoped,report.summary.id,'A4');await entered;
  const current=new ReportService(h.db,new ReportSecrets(h.key),new AgentSecrets(h.key),{version:REPORT_RENDERER_VERSION,render:async()=>{throw new Error('The current renderer must not run');}});
  await assert.rejects(current.pdf(h.scoped,report.summary.id,'A4'),failure('REPORT_PDF_RENDERING'));
  release();const completed=await pending;
  assert.deepEqual(await current.pdf(h.scoped,report.summary.id,'A4'),completed);
  assert.equal((await h.db.query('SELECT * FROM gh_report_pdf')).length,1);
});
