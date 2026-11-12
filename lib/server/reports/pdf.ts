import PDFDocument from 'pdfkit';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import type {ReportPaper,SavedReport} from '@/packages/reports/types';
import {reportInstruments,reportMoney,reportSource,reportTime} from '@/packages/reports/semantics';
import {HttpError} from '../errors';
import type {InstrumentResult} from '@/packages/studio/instrument-model';
import {recoveryPolicyCurrency} from '@/packages/domain/policy';
import {REPORT_RENDERER_VERSION,NATIVE_REPORT_RENDERER_VERSION} from '@/packages/reports/renderer';

export {REPORT_RENDERER_VERSION} from '@/packages/reports/renderer';
const palette={paper:'#F8F6F0',ink:'#17372F',muted:'#52645C',line:'#D6DED2',green:'#48745B',lime:'#D7E6A5',amber:'#9C5A31',white:'#FFFFFF'};
type Font={hasGlyphForCodePoint(value:number):boolean};
const fontkit=createRequire(import.meta.url)('fontkit') as {openSync(path:string):Font};
const fontNames=['NotoSans-Regular.ttf','NotoSans-Bold.ttf','NotoSerif-Regular.ttf'] as const;
let fonts: {path:string;font:Font}[]|undefined;
function bundledFonts(){return fonts??=fontNames.map(name=>{const path=join(process.cwd(),'assets','report-fonts',name);return {path,font:fontkit.openSync(path)};});}

/** No browser, model, provider or external image is involved. The entire input
 * is an immutable server-admitted edition; all assets are licensed local fonts. */
export async function renderReportPdf(report:SavedReport,paper:ReportPaper):Promise<{bytes:Buffer;pages:number}>{
  if(!['A4','LETTER'].includes(paper))throw new HttpError(400,'INVALID_REPORT_PAPER','Choose A4 or US Letter.');
  const {document:d,summary}=report,instruments=reportInstruments(d),fontFiles=bundledFonts();
  const pdf=new PDFDocument({size:paper,margin:48,autoFirstPage:false,bufferPages:true,compress:true,pdfVersion:'1.7',info:{Title:d.title,Author:d.creator.displayName,Subject:'Private immutable commerce incident report',Creator:'Glasshouse '+(d.schemaVersion===2?NATIVE_REPORT_RENDERER_VERSION:REPORT_RENDERER_VERSION),Producer:'PDFKit 0.20.2',CreationDate:new Date(d.createdAt),ModDate:new Date(d.createdAt)}});
  pdf.registerFont('body',fontFiles[0].path).registerFont('bold',fontFiles[1].path).registerFont('serif',fontFiles[2].path);
  const chunks:Buffer[]=[];let total=0;
  const complete=new Promise<Buffer>((resolve,reject)=>{pdf.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>32_000_000){pdf.destroy(new Error('PDF byte bound exceeded'));return;}chunks.push(chunk);});pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.on('error',reject);});
  // Attach a handler immediately so an early layout failure cannot leave a
  // rejected stream promise unobserved while the caller retains HTML/JSON.
  void complete.catch(()=>{});
  let y=0,page=0,section='PRIVATE INCIDENT REPORT',continuation:string|null=null,continuationHeight=0;
  const left=48,right=48,width=()=>pdf.page.width-left-right,bottom=()=>pdf.page.height-62;
  function check(text:string,face:'body'|'bold'|'serif'){
    const font=fontFiles[face==='body'?0:face==='bold'?1:2].font;
    if([...text].some(character=>!['\n','\r','\t'].includes(character)&&!font.hasGlyphForCodePoint(character.codePointAt(0)!)))throw new HttpError(422,'REPORT_FONT_COVERAGE','This edition contains characters outside the bundled PDF fonts. The unchanged accessible report and full JSON remain available.');
  }
  function text(value:string,x:number,at:number,w:number,size=9,face:'body'|'bold'|'serif'='body',color=palette.ink,options:PDFKit.Mixins.TextOptions={}){
    check(value,face);pdf.font(face).fontSize(size).fillColor(color).text(value,x,at,{width:w,lineGap:2,...options});
  }
  function newPage(label=section){
    section=label;page++;const pageLimit=d.schemaVersion===2?800:200;if(page>pageLimit)throw new HttpError(413,'REPORT_PDF_LIMIT',`The complete report exceeds this edition’s ${pageLimit}-page PDF bound. The full JSON remains available.`);
    pdf.addPage();pdf.rect(0,0,pdf.page.width,pdf.page.height).fill(palette.paper);
    text('glasshouse.',left,25,180,12,'bold');text(label,pdf.page.width-300,29,252,7,'bold',palette.muted,{align:'right'});
    pdf.moveTo(left,49).lineTo(pdf.page.width-right,49).strokeColor(palette.line).lineWidth(.7).stroke();y=70;continuationHeight=0;
    if(continuation){pdf.font('bold').fontSize(8);continuationHeight=pdf.heightOfString('CONTINUED / '+continuation,{width:width(),lineGap:2})+12;text('CONTINUED / '+continuation,left,y,width(),8,'bold',palette.green);y+=continuationHeight;}
  }
  function ensure(height:number){if(height>bottom()-70-continuationHeight)throw new HttpError(413,'REPORT_PDF_BLOCK_LIMIT','A complete report block exceeds one print page. The readable report and full JSON are unchanged.');if(y+height>bottom())newPage();}
  function paragraph(value:string,size=9,color=palette.ink,face:'body'|'bold'|'serif'='body'){
    // Bound individual flow blocks without dropping or shortening source text.
    const words=value.split(/(?<=\s)/);let block='';
    const draw=()=>{if(!block)return;check(block,face);pdf.font(face).fontSize(size);const height=pdf.heightOfString(block,{width:width(),lineGap:2});ensure(height+8);text(block,left,y,width(),size,face,color);y+=height+8;block='';};
    for(const word of words){if(block.length+word.length>1400)draw();if(word.length>1400){for(let i=0;i<word.length;i+=180){block=word.slice(i,i+180);draw();}}else block+=word;}draw();
  }
  function keepParagraphs(parts:[string,number,'body'|'bold'|'serif'][],extra=0){
    const height=parts.reduce((sum,[value,size,face])=>{pdf.font(face).fontSize(size);return sum+pdf.heightOfString(value,{width:width(),lineGap:2})+8;},extra);
    // Ordinary evidence cards stay whole. An unusually long source still flows
    // without truncation, while its heading remains with the first paragraph.
    ensure(parts.every(([value])=>value.length<=1400)&&height<=bottom()-70?height:125);
  }
  function heading(kicker:string,title:string,description?:string){
    const parts:[[string,number,'bold'|'serif'|'body'],...[string,number,'bold'|'serif'|'body'][]]=[[kicker.toUpperCase(),8,'bold'],[title,25,'serif'],...(description?[[description,9,'body'] as [string,number,'body']]:[])];
    const height=parts.reduce((sum,[value,size,face])=>{pdf.font(face).fontSize(size);return sum+pdf.heightOfString(value,{width:width(),lineGap:2})+8;},6);
    // Keep the complete heading and a first line/row of its content together.
    ensure(height+40);paragraph(kicker.toUpperCase(),8,palette.green,'bold');paragraph(title,25,palette.ink,'serif');if(description)paragraph(description,9,palette.muted);y+=6;
  }
  function rule(){ensure(16);pdf.moveTo(left,y).lineTo(pdf.page.width-right,y).strokeColor(palette.line).lineWidth(.7).stroke();y+=16;}
  function table(columns:{label:string;weight:number}[],rows:(string|number)[][],size=8){
    const totalWeight=columns.reduce((sum,column)=>sum+column.weight,0),widths=columns.map(column=>width()*column.weight/totalWeight);
    pdf.font('bold').fontSize(7);const headerHeight=Math.max(27,...columns.map((column,index)=>pdf.heightOfString(column.label,{width:widths[index]-14,lineGap:2})+14));
    const header=()=>{ensure(headerHeight);pdf.rect(left,y,width(),headerHeight).fill(palette.ink);let x=left;columns.forEach((column,index)=>{text(column.label,x+7,y+7,widths[index]-14,7,'bold',palette.white);x+=widths[index];});y+=headerHeight;};
    if(rows.length){pdf.font('body').fontSize(size);const firstHeight=Math.max(24,...rows[0].map((value,column)=>pdf.heightOfString(String(value),{width:widths[column]-14,lineGap:2})+14));ensure(headerHeight+firstHeight);}
    header();
    rows.forEach((row,index)=>{
      const strings=row.map(String);strings.forEach(value=>check(value,'body'));pdf.font('body').fontSize(size);
      const height=Math.max(24,...strings.map((value,column)=>pdf.heightOfString(value,{width:widths[column]-14,lineGap:2})+14));
      if(height>bottom()-100)throw new HttpError(413,'REPORT_PDF_ROW_LIMIT','An exact evidence row is too large for a print page. Read its unchanged full value in the report or JSON.');
      if(y+height>bottom()){newPage();header();}
      if(index%2===0)pdf.rect(left,y,width(),height).fill('#EDF1E8');
      let x=left;strings.forEach((value,column)=>{text(value,x+7,y+7,widths[column]-14,size);x+=widths[column];});
      y+=height;pdf.moveTo(left,y).lineTo(pdf.page.width-right,y).strokeColor(palette.line).lineWidth(.4).stroke();
    });y+=14;
  }
  function nativeRows(columns:string[],rows:Record<string,unknown>[]){
    const value=(row:Record<string,unknown>,column:string)=>row[column]===null?'Unknown':String(row[column]??'');
    if(columns.length<=5){table(columns.map(label=>({label,weight:1})),rows.map(row=>columns.map(column=>value(row,column))),8);return;}
    // Wide records use paired short fields, with long values spanning the page.
    // Every mapped value remains printed; no excerpt or citation is shortened.
    const gap=20,fieldWidth=(width()-gap)/2;
    const height=(value:string,w:number)=>{pdf.font('body').fontSize(8);return pdf.heightOfString(value,{width:w,lineGap:2});};
    for(const [index,row] of rows.entries()){
      const bands:string[][]=[];
      let pair:string[]=[];
      const flush=()=>{if(pair.length){bands.push(pair);pair=[];}};
      for(const column of columns){
        const field=column+': '+value(row,column);
        if(column==='Excerpt'||field.length>1400||height(field,fieldWidth)>38){flush();bands.push([field]);}
        else{pair.push(field);if(pair.length===2)flush();}
      }
      flush();
      const bandHeight=(band:string[])=>Math.max(...band.map(field=>height(field,band.length===2?fieldWidth:width())))+8;
      const totalHeight=28+bands.reduce((sum,band)=>sum+bandHeight(band),0);
      const whole=bands.every(band=>band.every(field=>field.length<=1400))&&totalHeight<=bottom()-70;
      ensure(whole?totalHeight:70);
      continuation=`Row ${index+1} of ${rows.length} / ${row.Evidence??row.Transition??row.Order??String(row[columns[0]]??'Saved native record')}`;
      rule();text(`Row ${index+1} of ${rows.length}`,left,y,width(),7,'bold',palette.muted);y+=12;
      for(const band of bands){
        if(band.length===1){paragraph(band[0],8);continue;}
        const blockHeight=bandHeight(band);ensure(blockHeight);
        band.forEach((field,column)=>text(field,left+column*(fieldWidth+gap),y,fieldWidth,8));y+=blockHeight;
      }
      continuation=null;continuationHeight=0;
    }
  }
  function bars(rows:{label:string;value:number}[],maximum:number,format=(value:number)=>String(value)){
    for(const row of rows){ensure(35);text(row.label,left,y,125,8);const barX=left+132,barWidth=width()-205;pdf.roundedRect(barX,y+1,barWidth,13,3).fill('#E0E6DA');if(row.value>0&&maximum>0)pdf.roundedRect(barX,y+1,barWidth*Math.min(1,row.value/maximum),13,3).fill(palette.green);text(format(row.value),barX+barWidth+10,y,63,8,'bold');y+=29;}y+=6;
  }
  function regionalReferences(instrument:InstrumentResult){
    const ratio=instrument.unit==='late / due shipments';
    const scale=ratio?1:Math.max(1,...instrument.groups.flatMap(group=>[
      group.baseline?.originalValue??0,group.baseline?.selectedValue??0,
      ...(group.daily??[]).flatMap(day=>[day.originalValue??0,day.selectedValue??0]),
    ]));
    const value=(amount:number|null|undefined)=>amount==null?'Unknown':ratio?(amount*100).toFixed(1)+'%':String(amount);
    paragraph('Daily original context'+(instrument.highlighted?' and selected cohort':'')+' on one shared scale. Grey band: historical original reference.'+(instrument.highlighted?' Rose stipple: selected cohort. Dashed line: historical selection.':'')+' Historical references are measured inventories, not confidence intervals. ? means unknown: no denominator.',8,palette.muted);
    for(const group of instrument.groups){
      const baseline=group.baseline!,days=group.daily??[];
      ensure(185);text(group.label,left,y,width(),10,'bold');y+=23;
      const top=y,chartLeft=left+34,chartWidth=width()-42,chartHeight=64,axis=top+chartHeight;
      pdf.moveTo(chartLeft,top).lineTo(chartLeft,axis).lineTo(chartLeft+chartWidth,axis).strokeColor(palette.line).lineWidth(.7).stroke();
      text(ratio?'100%':String(scale),left,top-5,30,7,'body',palette.muted);
      text('0',left,axis-5,30,7,'body',palette.muted);
      if(baseline.originalValue!==null){
        const at=axis-chartHeight*baseline.originalValue/scale;
        pdf.rect(chartLeft,at-3,chartWidth,6).fill('#D7DCDD');
        pdf.moveTo(chartLeft,at).lineTo(chartLeft+chartWidth,at).strokeColor('#667573').lineWidth(.7).stroke();
      }
      for(const [index,day] of days.entries()){
        const step=chartWidth/Math.max(1,days.length),x=chartLeft+index*step+3,barWidth=Math.max(2,step-7);
        const original=day.originalValue,selected=day.selectedValue;
        if(original!=null&&original>0)pdf.rect(x,axis-chartHeight*original/scale,barWidth,chartHeight*original/scale).fill('#B6C9BE');
        if(instrument.highlighted&&selected!=null&&selected>0){
          const height=chartHeight*selected/scale,at=axis-height,selectedX=x+barWidth*.18,selectedWidth=barWidth*.64;
          pdf.rect(selectedX,at,selectedWidth,height).fill('#E898A2');
          for(let dx=4;dx<selectedWidth;dx+=7)for(let dy=4;dy<height;dy+=7)pdf.circle(selectedX+dx,at+dy,.65).fill('#803D4A');
        }
        if(original==null)text('?',x,axis-12,barWidth,8,'bold',palette.amber,{align:'center'});
        if(instrument.highlighted&&selected==null)text('?',x,axis-25,barWidth,8,'bold','#803D4A',{align:'center'});
        text(day.day.slice(5),x-2,axis+5,step,7,'body',palette.muted,{align:'center'});
      }
      if(instrument.highlighted&&baseline.selectedValue!==null){
        const at=axis-chartHeight*baseline.selectedValue/scale;
        pdf.save().moveTo(chartLeft,at).lineTo(chartLeft+chartWidth,at).dash(4,{space:3}).strokeColor('#596663').lineWidth(1).stroke().restore();
      }
      y=axis+27;
      paragraph('Baseline '+reportTime(baseline.at)+' · original '+value(baseline.originalValue)+' ('+baseline.originalOrderCount+' orders; '+baseline.originalNumerator+'/'+baseline.originalDenominator+' late/due) · selected '+value(baseline.selectedValue)+' ('+baseline.selectedOrderCount+' orders; '+baseline.selectedNumerator+'/'+baseline.selectedDenominator+' late/due).',8,palette.muted);
      if(baseline.originalValue===null)paragraph('Historical reference unknown: no due shipments in this original cohort.',8,palette.amber);
      y+=9;
    }
  }
  try{
    newPage('AN IMMUTABLE EDITION');
    paragraph(d.workspace.organizationName??'PRIVATE MERCHANT WORKSPACE',8,palette.green,'bold');
    paragraph(d.title,35,palette.ink,'serif');
    paragraph(d.description||'The evidence, the choices, and the record that remains.',11,palette.muted);
    paragraph(d.workspace.merchantName+' / '+d.workspace.name,10,palette.ink,'bold');y+=14;
    ensure(158);const coverY=y;pdf.roundedRect(left,coverY,width(),143,10).fill(palette.ink);
    text('THE SAVED INVESTIGATION',left+20,coverY+18,width()-40,8,'bold',palette.lime);
    const statWidth=(width()-40)/3;
    [[String(d.snapshot.totals.orders),'orders in scope'],[String(d.snapshot.totals.affected),'affected at T'],[reportMoney(d.snapshot.totals.capturedMinor,d.snapshot.context.currency),'captured at T']].forEach(([value,label],index)=>{
      text(value,left+20+statWidth*index,coverY+48,statWidth-12,index===2?22:31,'serif',palette.white);
      text(label,left+20+statWidth*index,coverY+97,statWidth-10,8,'body','#D1DDD1');
    });y=coverY+165;
    paragraph(d.nativePrint?'One edition. The exact saved views.':'One edition. Six ways to read it.',22,palette.ink,'serif');
    paragraph('Commerce River / Time Dial / Evidence Lens / Recovery Branches / Regional Impact / Deadline Strip',9,palette.green,'bold');
    paragraph(d.nativePrint?'The following exact tables use the saved native mappings and filters. Unsupported mappings are identified explicitly. Complete authorized sources remain in the embedded JSON.':'The static instruments cover the whole admitted snapshot. Exact native configuration and undo/redo history are included in the embedded JSON. Saved proposals and observed outcomes retain their own clocks and source labels.',9,palette.muted);
    rule();
    paragraph('Saved '+reportTime(d.createdAt)+' by '+d.creator.displayName+' ('+d.creator.role+'). Browser identity is self-declared.',8,palette.muted);
    paragraph('Document SHA-256: '+summary.documentHash,7,palette.muted);
    paragraph('Snapshot SHA-256: '+d.snapshot.hash,7,palette.muted);
    paragraph('Edition: '+d.id+(d.parentId?' / Derived from: '+d.parentId:''),7,palette.muted);

    if(d.nativePrint){
      for(const widget of d.nativePrint.widgets){
        newPage('SAVED NATIVE VIEW / '+widget.type.toUpperCase());
        heading(widget.pageId+' / '+widget.widgetId,widget.title,widget.status==='exact'?'Exact installed-native query at saved T/K and filter scope.':'Unsupported mapping; no substitute result.');
        if(widget.status==='unsupported'){paragraph(widget.reason??'No exact static adapter is available.',10,palette.amber);continue;}
        for(const note of widget.instrument?.notes??[])paragraph(note,8,palette.muted);
        if(widget.instrument){
          paragraph(widget.instrument.scopeLabel??`${widget.instrument.scope} orders in the native result; ${widget.instrument.selected} in the shared selection.`,9,palette.green,'bold');
          if(widget.instrument.kind==='impact-map'&&widget.instrument.groups.some(group=>group.baseline)&&widget.rows.some(row=>row.Period==='Daily'))regionalReferences(widget.instrument);
          else if(widget.instrument.groups.length){
            const ratio=widget.instrument.kind==='impact-map'&&widget.instrument.unit==='late / due shipments',money=widget.instrument.kind!=='recovery-branches'&&widget.instrument.unit.endsWith('minor units');
            const maximum=ratio?1:Math.max(1,...widget.instrument.groups.map(group=>group.value));
            for(const group of widget.instrument.groups){
              ensure(60);paragraph(group.label,9,palette.ink,'bold');
              const display=(value:number,known=true)=>!known?'Unknown':ratio?(value*100).toFixed(1)+'%':money?reportMoney(value,d.snapshot.context.currency):String(value);
              const known=!ratio||Boolean(group.denominator),originalKnown=!ratio||Boolean(group.originalDenominator);
              const barX=left,barWidth=width()*.56;
              pdf.roundedRect(barX,y,barWidth,11,2).fill('#E0E6DA');
              if(group.value>0&&originalKnown)pdf.roundedRect(barX,y,barWidth*Math.min(1,group.value/maximum),11,2).fill('#A8BEA1');
              if(group.selected>0&&known)pdf.roundedRect(barX,y,barWidth*Math.min(1,group.selected/maximum),6,2).fill(palette.ink);
              text(display(group.selected,known)+' selected / '+display(group.value,originalKnown)+' original',barX+barWidth+12,y-1,width()-barWidth-12,8,'body');y+=25;
            }
          }
        }
        paragraph(widget.rows.length+' complete rows. '+(widget.instrument?.unit??'Mapped native fields')+'.',8,palette.muted);
        nativeRows(widget.columns,widget.rows);
        if(widget.originalRows){paragraph('Original denominator, before shared highlight',11,palette.ink,'bold');nativeRows(widget.columns,widget.originalRows);}
      }
      if(d.findingRevisions?.length){newPage('SHARED FINDING VERSIONS');for(const finding of d.findingRevisions){heading('Review '+finding.sequence,finding.title);paragraph(finding.interpretation);paragraph('Counterpoint: '+finding.counterpoint);paragraph('State: '+finding.state+' / '+finding.id+' / SHA-256 '+finding.hash,7);for(const citation of finding.citations)paragraph(citation.relation+' / '+citation.id+' / '+citation.hash,7);}}
    }else{
    newPage('01 / COMMERCE RIVER');
    heading('01 / Commerce River','Where the orders stood.','Inventory counts each admitted order once at event time T, using knowledge available by K. It is not a transition count.');
    bars(instruments.inventory.map(row=>({...row,label:row.label.replaceAll('_',' ')})),d.snapshot.totals.orders);
    paragraph('Inventory total: '+instruments.inventory.reduce((sum,row)=>sum+row.value,0)+' orders. Captured '+d.snapshot.totals.captures+'; delivered '+d.snapshot.totals.delivered+'; affected '+d.snapshot.totals.affected+'.',9);
    table([{label:'SOURCE COVERAGE',weight:3},{label:'COUNT',weight:1}],[[ 'Sample payments',d.snapshot.sourceCoverage.samplePayments],['Verified sandbox payments',d.snapshot.sourceCoverage.sandboxPayments],['Fixture shipping records',d.snapshot.sourceCoverage.fixtureShipments],['Provider disputes',d.snapshot.sourceCoverage.providerDisputes]]);
    paragraph('Transition inventory: '+d.snapshot.tables.transition_snapshot.length+' state changes from '+reportTime(instruments.transitionRange.from)+' through '+reportTime(instruments.transitionRange.to)+'. An order may contribute more than one change.',8,palette.muted);
    table([{label:'TRANSITION DIMENSION',weight:3},{label:'CHANGES',weight:1}],instruments.transitions.map(row=>[row.label,row.value]));
    newPage('02 / TIME DIAL');
    heading('02 / Time Dial','Two clocks. One saved view.','T asks what had happened. K asks what was known. Both are pinned to this edition, even when later evidence changes the current investigation.');
    ensure(140);const clockWidth=(width()-16)/2,clockY=y;
    [['T','EVENT TIME',d.snapshot.context.asOf,'Inventory at this moment.'],['K','KNOWLEDGE CUTOFF',d.snapshot.context.knownAt,'Evidence admitted by this moment.']].forEach(([mark,label,value,note],index)=>{
      const x=left+index*(clockWidth+16);pdf.roundedRect(x,clockY,clockWidth,116,8).fill(index===0?palette.ink:'#E0E6DA');const color=index===0?palette.white:palette.ink;
      text(mark,x+15,clockY+10,40,30,'serif',color);text(label,x+63,clockY+19,clockWidth-77,8,'bold',color);
      text(reportTime(value),x+15,clockY+61,clockWidth-30,9,'bold',color);text(note,x+15,clockY+87,clockWidth-30,8,'body',color);
    });y=clockY+140;
    table([{label:'CLOCK',weight:2},{label:'EXACT UTC VALUE',weight:5}],[['Event time T',reportTime(d.snapshot.context.asOf)],['Knowledge cutoff K',reportTime(d.snapshot.context.knownAt)],['Clock domain',d.snapshot.context.clockDomain],['Report generation',reportTime(d.createdAt)],['Observed outcomes captured',reportTime(d.observed.capturedAt)]]);
    paragraph((d.findingRevisions?'Source cohort revision ':'Finding revision ')+d.snapshot.context.cohortVersion+' / '+d.snapshot.context.semanticModelVersion+' / '+d.snapshot.context.rolePolicyVersion+'. Replaying narrative time does not change provider observation times or execute an action.',8,palette.muted);

    newPage('03 / EVIDENCE LENS');
    heading('03 / Evidence Lens','An explanation you can inspect.','Source excerpts are quoted evidence, never instructions. A supported pattern is not proof of causation.');
    for(const detector of d.snapshot.detectors){ensure(105);paragraph(detector.title+' / '+detector.status.replaceAll('_',' '),12,palette.ink,'bold');paragraph(detector.explanation,9);paragraph('Baseline '+detector.baselineNumerator+'/'+detector.baselineDenominator+'; current '+detector.currentNumerator+'/'+detector.currentDenominator+'; formula '+detector.formulaVersion+'; '+reportSource(detector.sourceClass)+'.',8,palette.muted);}
    const cited=new Set([...d.findings.flatMap(finding=>finding.evidence.map(row=>row.id)),...(d.findingRevisions??[]).flatMap(finding=>finding.citations.map(row=>row.id))]),narrative=d.snapshot.evidence.filter(row=>row.orderId===null||cited.has(row.id));
    if(!narrative.length)paragraph('No aggregate or explicitly cited excerpts were saved. All '+d.snapshot.evidence.length+' exact source records remain in the embedded JSON.',9);
    for(const source of narrative){
      const label=reportSource(source.sourceClass)+' / '+source.sourceLabel+(source.untrusted?' / untrusted source text':''),clock='Occurred '+reportTime(source.occurredAt)+' / known '+reportTime(source.ingestedAt)+' / '+source.id,coverage=source.supports.length+' supporting event IDs / '+source.contradicts.length+' counterpoint event IDs. Complete lists are preserved with this source record in the embedded JSON.';
      keepParagraphs([[source.title,11,'bold'],[label,8,'body'],[source.excerpt,9,'body'],[clock,7,'body'],[coverage,7,'body']],16);
      rule();paragraph(source.title,11,palette.ink,'bold');paragraph(label,8,palette.green);paragraph(source.excerpt,9);paragraph(clock,7,palette.muted);paragraph(coverage,7,palette.muted);
    }
    for(const finding of d.findings){ensure(125);rule();paragraph('SAVED HYPOTHESIS / '+finding.title,11,palette.ink,'bold');paragraph(finding.interpretation,9);paragraph('Counterpoint: '+finding.counterpoint,9,palette.amber);paragraph('Finding '+finding.id+' / status '+finding.status+' / '+finding.evidence.length+' source citations / saved '+reportTime(finding.createdAt),7,palette.muted);}
    for(const finding of d.findingRevisions??[]){ensure(155);rule();paragraph('SHARED EXACT FINDING / REVIEW '+finding.sequence,8,palette.muted,'bold');paragraph(finding.title,12,palette.ink,'bold');paragraph(finding.state.replaceAll('_',' ')+' / '+finding.facts.affectedCount+' affected of '+finding.facts.scopeCount+' / source cohort v'+finding.cohortVersion,8,palette.muted);paragraph(finding.interpretation,9);paragraph('Counterpoint: '+finding.counterpoint,9,palette.amber);paragraph('Recorded reason: '+finding.reason,8,palette.muted);paragraph('T '+reportTime(finding.context.asOf)+' / K '+reportTime(finding.context.knownAt)+' / '+finding.actorRole+' / '+finding.actorId,7,palette.muted);paragraph('Version '+finding.id+' / SHA-256 '+finding.hash,7,palette.muted);for(const source of finding.citations)paragraph(source.relation+' / '+(source.scope==='earlier_version'?'earlier evidence / ':'')+source.sourceClass+' / '+source.id+' / SHA-256 '+source.hash,7,palette.muted);}
    paragraph('Coverage: '+narrative.length+' aggregate or cited excerpts shown here; '+d.snapshot.evidence.length+' complete evidence records are available in JSON. '+(d.findingRevisions?'This edition preserves '+d.findingRevisions.length+' explicitly selected, shared finding version'+(d.findingRevisions.length===1?'':'s')+' with exact source dependencies.':d.findings.length+' findings belong to the creating member and this exact snapshot.'),8,palette.muted);

    newPage('04 / RECOVERY BRANCHES');
    heading('04 / Recovery Branches','What the policy would allow.','Scenario totals are deterministic calculations for this snapshot. They are distinct from selected saved approvals and observed outcomes.');
    const branches=d.snapshot.branches;
    table([{label:'POLICY FACT',weight:2.2},...branches.map(branch=>({label:branch.name.toUpperCase(),weight:2.5}))],[
      ['Policy',...branches.map(branch=>branch.policyId)],['Grace period',...branches.map(branch=>branch.graceHours+' hours')],['Eligible refunds',...branches.map(branch=>branch.eligibleCount)],['Refund total',...branches.map(branch=>reportMoney(branch.refundTotalMinor,recoveryPolicyCurrency(branch)))],['Budget cap',...branches.map(branch=>reportMoney(branch.budgetMinor,recoveryPolicyCurrency(branch)))],['Tracking / dispute responses',...branches.map(branch=>branch.trackingCount+' / '+branch.disputeCount)],
    ]);
    for(const branch of branches){ensure(125);paragraph(branch.name,13,palette.ink,'serif');paragraph(branch.id==='comprehensive'?'No-grace comparison only. No policy override is authorized by this report.':'Targeted proposal using the stated '+branch.graceHours+'-hour grace period.',9,palette.muted);paragraph('Exclusion checks: '+Object.entries(branch.exclusionCounts).map(([reason,count])=>reason.replaceAll('_',' ')+' '+count).join('; ')+'. Checks can overlap for one order.',8,palette.muted);}
    ensure(95);
    paragraph('Selected saved manifests: '+d.plans.length+'. Their complete action and policy rows appear in the appendix and JSON. Exporting this report grants no approval and starts no execution.',9,palette.ink,'bold');
    for(const plan of d.plans){ensure(80);paragraph(plan.id+' / '+plan.status+' / '+plan.executionMode,9,palette.green,'bold');paragraph('Frozen '+plan.branch.actions.length+' actions / '+plan.branch.eligibleCount+' refunds / '+reportMoney(plan.branch.refundTotalMinor,recoveryPolicyCurrency(plan.branch))+' / cap '+reportMoney(plan.branch.budgetMinor,recoveryPolicyCurrency(plan.branch))+'. Hash '+plan.hash,8,palette.muted);}

    newPage('05 / REGIONAL IMPACT');
    heading('05 / Regional Impact','The pattern, with denominators.','Coarse regions protect individual locations. Shares use known shipments due by the saved inventory time; empty denominators stay unknown.');
    bars(instruments.regions.map(row=>({label:String(row.regionCode),value:Number(row.lateShare??0)})),1,value=>(value*100).toFixed(1)+'%');
    table([{label:'REGION',weight:2},{label:'LATE / DUE',weight:2},{label:'CURRENT',weight:1.5},{label:'BASELINE',weight:2}],instruments.regions.map(row=>[String(row.region),row.lateCount+' / '+row.eligibleShipmentCount,row.lateShare===null?'Unknown':(Number(row.lateShare)*100).toFixed(1)+'%',row.baselineNumerator+' / '+row.baselineDenominator]));
    paragraph('One common 0-100% scale. All '+d.snapshot.tables.regional_snapshot.length+' region-day rows, exact baseline cutoffs and denominators are retained in JSON.',8,palette.muted);
    newPage('06 / DEADLINE STRIP');
    heading('06 / Deadline Strip','A deadline only when it is sourced.','Only a saved provider deadline is verified. Remaining time is compared with report generation, not narrative event time.');
    if(!instruments.deadlines.length)paragraph('No open dispute deadline rows are present in this saved snapshot.',10);
    else table([{label:'ORDER / SOURCE',weight:2},{label:'STATE',weight:2},{label:'SAVED DEADLINE',weight:3}],instruments.deadlines.map(row=>[String(row.reference)+'\n'+reportSource(String(row.sourceClass)),String(row.state??'Unknown'),row.verified?reportTime(String(row.dueAt)): 'Unknown - no verified provider deadline']));
    paragraph('A waiting-for-buyer state or successful evidence submission is not a resolved case. The observed-case appendix retains later provider states separately.',8,palette.amber);

    }

    newPage('OUTCOMES / HISTORY / AUDIT');
    heading('The record that remains','Observed outcomes, separate histories.','These receipts were observed by the edition capture time. They do not retroactively change the saved T/K snapshot.');
    if(instruments.operationStates.length)table([{label:'OBSERVED OPERATION STATE',weight:3},{label:'COUNT',weight:1}],instruments.operationStates.map(row=>[row.label.replaceAll('_',' '),row.value]));
    if(!d.observed.operations.length)paragraph('No relevant operation receipts were present when this edition was created. A proposal is not an executed action.',9,palette.muted);
    for(const source of ['sandbox','sample'] as const){const refunds=d.observed.operations.filter(row=>row.kind==='refund'&&row.status==='provider_success'&&row.sourceClass===source);if(refunds.length)paragraph(reportSource(source)+': '+refunds.length+' confirmed refund receipts totaling '+reportMoney(refunds.reduce((sum,row)=>sum+row.amountMinor,0))+'.',9);}
    if(d.observed.cases.length)table([{label:'CASE / ORDER',weight:3},{label:'PROVIDER STATE',weight:3},{label:'OBSERVED UTC',weight:3}],d.observed.cases.map(row=>[row.id+'\n'+row.orderId,row.status+' / '+row.stage,reportTime(row.observedAt)]));
    heading('Native layout history','Who changed the investigation.');
    paragraph('Saved native revision '+d.layout.version+'; '+d.coverage.nativePages+' pages; '+d.coverage.nativeWidgets+' widgets; '+d.coverage.undoEntries+' undo entries and '+d.coverage.redoEntries+' redo entries. These entries change report layout, never financial state.',9);
    paragraph('Layout SHA-256: '+d.layout.hash,7,palette.muted);
    const entries=[...d.layout.history.undo.map(row=>({...row,stack:'undo'})),...d.layout.history.redo.map(row=>({...row,stack:'redo'}))];
    if(entries.length)table([{label:'NATIVE ENTRY',weight:3},{label:'STACK / SOURCE',weight:3}],entries.map(row=>[row.id,row.stack+' / '+JSON.stringify(row.source)]),7);
    heading('Workspace audit','A distinct record of decisions.');
    const auditRows=d.audit.events.slice(-30);
    paragraph('The '+auditRows.length+' latest audit entries are printed below. All '+d.audit.events.length+' entries through sequence '+d.audit.throughSequence+' are included in JSON. The layout history above is independent.',8,palette.muted);
    if(auditRows.length)table([{label:'UTC / ACTOR',weight:3},{label:'EVENT / SUMMARY',weight:5}],auditRows.map(row=>[reportTime(row.timestamp)+'\n'+row.actorId,row.type+'\n'+row.summary]),7);

    for(const plan of d.plans){
      newPage('APPENDIX / EXACT SAVED MANIFEST');
      heading('Exact manifest / '+plan.executionMode,plan.branch.name,plan.id);
      paragraph('Status at export: '+plan.status+'. Approved by: '+(plan.approvedBy??'Not approved')+'. Approved at: '+reportTime(plan.approvedAt)+'.',9);
      paragraph('Policy '+plan.branch.policyId+' / '+plan.branch.graceHours+'-hour grace / '+plan.branch.eligibleCount+' eligible refunds / '+reportMoney(plan.branch.refundTotalMinor,recoveryPolicyCurrency(plan.branch))+' / cap '+reportMoney(plan.branch.budgetMinor,recoveryPolicyCurrency(plan.branch))+'.',9);
      if(plan.branch.id==='comprehensive')paragraph('No-grace comparison. This edition grants no policy override or execution permission.',9,palette.amber,'bold');
      paragraph('Manifest SHA-256: '+plan.hash+'\nSnapshot SHA-256: '+plan.snapshotHash,7,palette.muted);
      paragraph('Frozen T '+reportTime(plan.context?.asOf)+' / K '+reportTime(plan.context?.knownAt)+' / expires '+reportTime(plan.expiresAt)+'. Full payloads, conditions and evidence IDs are in the attached JSON.',8,palette.muted);
      table([{label:'ORDER / KIND / SOURCE',weight:3},{label:'EXACT ACTION / OPERATION ID',weight:6},{label:'AMOUNT',weight:1.8}],plan.branch.actions.map(action=>[action.reference+' / '+action.kind+'\n'+reportSource(action.sourceClass),action.id+'\n'+String(action.payload.operationId),reportMoney(action.amountMinor,action.currency)]),7);
      heading('Exact eligibility rows','Every inclusion and exclusion.');
      table([{label:'ORDER',weight:3},{label:'POLICY RESULT',weight:5}],plan.branch.rows.map(row=>[row.orderId,row.eligible?'Eligible':row.excludedReasons.join('; ')||'Not eligible']),7);
    }
    if(d.observed.operations.length){newPage('APPENDIX / OBSERVED OPERATION RECEIPTS');heading('Observed operation receipts','An outcome for every saved identity.');table([{label:'OPERATION / KIND',weight:4},{label:'STATE / SOURCE',weight:3},{label:'AMOUNT / PROVIDER ID',weight:3}],d.observed.operations.map(row=>[row.id+'\n'+row.kind,row.status+'\n'+reportSource(row.sourceClass),reportMoney(row.amountMinor,row.currency)+'\n'+(row.providerId??'No confirmed provider ID')]),7);}

    newPage('PROVENANCE / READING THIS EDITION');
    heading('Provenance','What this edition can establish.');
    d.coverage.limitations.forEach(value=>paragraph(value,9));
    table([{label:'TABLE',weight:3},{label:'ROWS / SHA-256',weight:6}],Object.entries(d.snapshot.tables).map(([name,rows])=>[name,rows.length+'\n'+d.snapshot.tableHashes[name]]),7);
    const sourceCount=Object.hasOwn(d.snapshot.tables,'regional_baseline_order_snapshot')?String(Object.keys(d.snapshot.tables).length):'six';
    paragraph('The attached glasshouse-edition.json contains this full immutable edition, all '+sourceCount+' exact tables, source evidence, native history, selected manifests, safe observed receipts and audit. Its document hash is '+summary.documentHash+'.',9);
    paragraph('PDF renderer: '+(d.schemaVersion===2?NATIVE_REPORT_RENDERER_VERSION:REPORT_RENDERER_VERSION)+' / PDFKit 0.20.2 / '+paper+'. Fonts: unmodified Noto Sans and Noto Serif under SIL OFL 1.1. The PDF is a deterministic semantic presentation; the separately hashed JSON is the canonical evidence.',8,palette.muted);
    const attachment={name:'glasshouse-edition.json',type:'application/json',description:'Complete immutable Glasshouse edition and exact native evidence',creationDate:new Date(d.createdAt),modifiedDate:new Date(d.createdAt),relationship:'Source' as const};
    pdf.file(Buffer.from(JSON.stringify(report,null,2)+'\n'),attachment);
    const pages=pdf.bufferedPageRange().count;
    for(let index=0;index<pages;index++){pdf.switchToPage(index);const current=pdf.page,margin=current.margins.bottom;current.margins.bottom=0;const at=current.height-39;pdf.moveTo(left,at-8).lineTo(current.width-right,at-8).strokeColor(palette.line).lineWidth(.7).stroke();text('PRIVATE / '+d.id.slice(-12)+' / '+summary.documentHash.slice(0,16),left,at,width()-65,7,'body',palette.muted,{lineBreak:false});text((index+1)+' / '+pages,current.width-108,at,60,7,'bold',palette.muted,{align:'right',lineBreak:false});current.margins.bottom=margin;}
    if(pdf.bufferedPageRange().count!==pages)throw new HttpError(409,'REPORT_PDF_PAGINATION','A page footer changed the admitted page count. The saved report and full JSON remain available.');
    pdf.end();return {bytes:await complete,pages};
  }catch(error){pdf.destroy();throw error;}
}
