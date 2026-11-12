import test from 'node:test';
import assert from 'node:assert/strict';
import {act} from 'react';
import type {AgWidgetField,AgWidgetParams} from 'ag-studio';
import {buildSnapshot} from '../packages/domain';
import type {Snapshot} from '../packages/domain/types';
import type {InstrumentData,InstrumentFormat} from '../packages/studio/types';
import {instrumentCorpus,times} from './reference/instrument-corpus';
import {nativeStudio} from './helpers/studio-native';
import {productionInstrumentStudio} from './helpers/instrument-react';

type Production=Awaited<ReturnType<typeof productionInstrumentStudio>>;
type NativeParams=AgWidgetParams<InstrumentData>&{dataMapping:Record<string,AgWidgetField[]>};
async function historyFor(t:import('node:test').TestContext,snapshot:Snapshot,formats:Record<string,InstrumentFormat>={}){
  const canonical=await nativeStudio(t,undefined,{snapshot}),state=structuredClone(canonical.api.getState()),page=state.pages[0];
  delete page.widgets!.records;delete page.widgetLayout!.records;
  for(const [id,format] of Object.entries(formats)){const widget=page.widgets![id] as InstrumentData;page.widgets![id]={...widget,format:{...widget.format,...format}};}
  canonical.api.setState(state);await new Promise(resolve=>setTimeout(resolve,50));canonical.api.clearHistory();const history=structuredClone(canonical.api.getHistory());canonical.destroy();return history;
}
function button(h:Production,selector:string,label:string){const found=[...h.win.document.querySelectorAll<HTMLButtonElement>(selector)].find(node=>node.getAttribute('aria-label')===label||node.textContent?.trim()===label);assert(found,'Expected real control: '+label);return found;}
async function press(h:Production,target:HTMLElement){await act(async()=>{target.focus();target.click();});await h.flush();}
function selectedIds(h:Production,widgetId:string){const state=h.api.getState(),selection=state.pages.find(page=>page.id===state.selectedPageId)?.crossFilter?.values?.[widgetId]?.find(selection=>selection.group===0);assert(selection?.type==='multiValue','An exact native ID selection is required for '+widgetId);return selection.values.map(pair=>String(pair[0].value)).sort();}
function crossValues(h:Production){const state=h.api.getState();return structuredClone(state.pages.find(page=>page.id===state.selectedPageId)?.crossFilter?.values??{});}

test('actual StudioWorkspace, NativeStudio and TimeDial forward EUR and GBP reconstruction intents intact',async t=>{
  const snapshot=buildSnapshot(instrumentCorpus(),{asOf:times.end,knownAt:times.known,semanticModelVersion:'commerce-semantic-v3'}),canonical=await nativeStudio(t,undefined,{snapshot}),state=structuredClone(canonical.api.getState()),page=state.pages[0];
  page.widgets={dial:page.widgets!.dial};page.widgetLayout={dial:{xTrack:0,yTrack:0,xSpan:24,ySpan:32}};
  // The state-only native helper canonicalizes history, then releases its DOM.
  // The regression itself mounts every production React boundary, with the
  // actual registered TimeDial renderer and installed AG Studio library.
  canonical.api.setState(state);await new Promise(resolve=>setTimeout(resolve,50));canonical.api.clearHistory();const history=structuredClone(canonical.api.getHistory());canonical.destroy();
  const h=await productionInstrumentStudio(t,snapshot,history);
  assert.equal(h.win.document.querySelectorAll('[data-widget="time-dial"]').length,1);
  for(const currency of ['EUR','GBP']){
    const select=h.win.document.querySelector<HTMLSelectElement>('select[aria-label="Report denomination"]');assert(select);
    await act(async()=>{select.value=currency;select.dispatchEvent(new h.win.Event('change',{bubbles:true}));});
    const submit=[...h.win.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.includes('Reconstruct all views'));assert(submit);
    await act(async()=>{submit.click();});
    assert.deepEqual(h.times.at(-1),[snapshot.context.asOf,snapshot.context.knownAt,snapshot.context.clockDomain,currency],'The real TimeDial fourth argument must survive StudioInstance’s public bridge');
  }
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.networkAttempts,[]);
});

test('real Evidence and Deadline controls emit cited native order selections, separate proof and preserve peer selections on clear',async t=>{
  const dataset=instrumentCorpus();
  delete dataset.events.find(event=>event.orderId==='d'&&event.type==='dispute.observed')!.payload.sellerResponseDueAt;
  dataset.evidence.push(
    {id:'cohort-cited-exact',tenantId:dataset.tenantId,orderId:null,kind:'finding',title:'Two explicitly cited orders',excerpt:'Fictional component fixture with an evidence link and a transition source link.',sourceClass:'sample',sourceLabel:'Synthetic React qualification',occurredAt:times.end,ingestedAt:times.known,supports:['reference-source-a','event:d:dispute.observed','cohort-cited-exact','not-an-order-link'],contradicts:['reference-counter-evidence']},
    {id:'cohort-without-links',tenantId:dataset.tenantId,orderId:null,kind:'finding',title:'Finding without order links',excerpt:'This aggregate statement supplies no admitted order citations.',sourceClass:'sample',sourceLabel:'Synthetic React qualification',occurredAt:times.end,ingestedAt:times.known,supports:['a','missing-source'],contradicts:[]},
    {id:'direct-d',tenantId:dataset.tenantId,orderId:'d',kind:'dispute',title:'Explicit order D source',excerpt:'A source explicitly bound to fictional order d.',sourceClass:'sample',sourceLabel:'Synthetic React qualification',occurredAt:times.end,ingestedAt:times.known,supports:[],contradicts:[]},
  );
  const snapshot=buildSnapshot(dataset,{asOf:times.end,knownAt:times.known,semanticModelVersion:'commerce-semantic-v3'}),h=await productionInstrumentStudio(t,snapshot,await historyFor(t,snapshot,{deadlines:{deadlineOwner:'merchant',showUnknown:true}}));
  await press(h,button(h,'.region-rows>button','Pacific Northwest3 / 3 original'));
  await h.until(()=>h.counts.get('river')?.selected===3,'The actual River getData did not receive the map cohort');
  const mapSelection=crossValues(h).map,mapRegion=mapSelection?.find(selection=>selection.group===0);assert.equal(mapRegion?.type,'value','The real Map preserves a mapped region predicate');assert(mapRegion?.type==='value');assert.equal(mapRegion.field.id,'order_snapshot.regionCode');assert.deepEqual(mapRegion.values,['PNW']);
  const missing=h.win.document.querySelector<HTMLElement>('[data-evidence="cohort-without-links"]');assert(missing);assert.match(missing.textContent??'',/no cited order links in the admitted snapshot/);assert.equal([...missing.querySelectorAll('button')].some(node=>node.textContent?.includes('Select')),false);
  const beforeExpand=crossValues(h);await press(h,button(h,'[data-evidence="cohort-cited-exact"] button','Expand source: Two explicitly cited orders'));assert.deepEqual(crossValues(h),beforeExpand,'Expansion does not change native selection');
  const citedControl=button(h,'[data-evidence="cohort-cited-exact"] button','Select 2 linked orders across views for Two explicitly cited orders');await press(h,citedControl);
  await h.until(()=>h.counts.get('river')?.selected===2,'The actual River getData did not receive cited evidence IDs');
  assert.deepEqual(selectedIds(h,'evidence'),['a','d']);assert.deepEqual(crossValues(h).map,mapSelection);assert.equal(h.win.document.activeElement,citedControl,'The real source selection retains keyboard focus');assert.equal(citedControl.getAttribute('aria-pressed'),'true');
  const evidenceSelection=crossValues(h).evidence,proofBefore=crossValues(h);
  await press(h,button(h,'[data-widget="deadline-strip"] button','Open case proof for REF-D'));assert.deepEqual(h.orders,['d']);assert.deepEqual(crossValues(h),proofBefore,'Opening proof does not select the case');
  assert.match(h.win.document.querySelector('[data-widget="deadline-strip"]')?.textContent??'',/Deadline unknown/);assert.doesNotMatch(h.win.document.querySelector('[data-widget="deadline-strip"] [data-order="d"]')?.textContent??'',/remaining|Overdue/);
  const caseControl=button(h,'[data-widget="deadline-strip"] button','Select case order REF-D across views');await press(h,caseControl);
  await h.until(()=>h.counts.get('river')?.selected===1,'The actual River getData did not receive the deadline order');
  assert.deepEqual(selectedIds(h,'deadlines'),['d']);assert.deepEqual(crossValues(h).evidence,evidenceSelection);assert.deepEqual(crossValues(h).map,mapSelection);assert.equal(h.win.document.activeElement,caseControl);assert.equal(caseControl.getAttribute('aria-pressed'),'true');
  await press(h,button(h,'[data-widget="evidence-lens"] button','Clear this lens’s selection'));
  assert.equal(crossValues(h).evidence,undefined);assert.deepEqual(selectedIds(h,'deadlines'),['d']);assert.deepEqual(crossValues(h).map,mapSelection);
  await press(h,button(h,'[data-widget="deadline-strip"] button','Clear this strip’s selection'));
  await h.until(()=>h.counts.get('river')?.selected===3,'Clearing the strip must restore the other widget’s full selected cohort');
  assert.equal(crossValues(h).deadlines,undefined);assert.deepEqual(crossValues(h).map,mapSelection);
  await press(h,button(h,'[data-evidence="direct-d"] button','Select 1 linked order across views for Explicit order D source'));
  await h.until(()=>h.counts.get('river')?.selected===1,'The direct source order did not reach peer data');assert.deepEqual(selectedIds(h,'evidence'),['d']);
  const directBefore=crossValues(h);await press(h,button(h,'[data-evidence="direct-d"] button','Open order proof for REF-D'));assert.deepEqual(h.orders,['d','d']);assert.deepEqual(crossValues(h),directBefore);
  await press(h,button(h,'[data-widget="evidence-lens"] button','Clear this lens’s selection'));
  await press(h,button(h,'[data-widget="evidence-lens"] button','Show exact data table'));
  const tableControl=button(h,'[data-widget="evidence-lens"] button','Select linked orders across views for direct-d');await press(h,tableControl);
  assert.deepEqual(selectedIds(h,'evidence'),['d']);assert.equal(h.win.document.activeElement,tableControl,'Exact evidence identity preserves focus as native rows narrow');assert.equal(tableControl.getAttribute('aria-pressed'),'true');
  await press(h,button(h,'[data-widget="deadline-strip"] button','Show exact data table'));
  await press(h,button(h,'[data-widget="deadline-strip"] button','Select linked orders across views for d'));
  assert.deepEqual(selectedIds(h,'deadlines'),['d']);
  await press(h,button(h,'[data-widget="evidence-lens"] button','Clear this lens’s selection'));
  await h.until(()=>h.counts.get('river')?.selected===1,'The table controls must preserve the native case selection');
  const selectedState=structuredClone(h.api.getState()),beforeDisabled=crossValues(h);
  await act(async()=>{for(const id of ['evidence','deadlines']){
    const state=h.api.getState(),widget=state.pages[0].widgets![id] as InstrumentData,widgetType=id==='evidence'?'evidence-lens':'deadline-strip';
    const configured=await h.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType}}).apply({widgetId:id,op:'patch',value:{format:{...widget.format,triggerCrossFilter:false}}});assert.equal(configured.success,true);
  }});
  await h.until(()=>Boolean(h.win.document.querySelector<HTMLButtonElement>('[data-widget="evidence-lens"] button[aria-label="Select linked orders across views for direct-d"]')?.disabled&&h.win.document.querySelector<HTMLButtonElement>('[data-widget="deadline-strip"] button[aria-label="Select linked orders across views for d"]')?.disabled),'Native trigger-disabled settings must disable both outward selection controls');
  // The installed SDK may remove a widget's own selection when disabling its
  // trigger. Compare actions with that admitted state, retaining peer choices.
  const disabledSelections=crossValues(h);assert.deepEqual(disabledSelections.map,beforeDisabled.map);
  await press(h,button(h,'[data-widget="evidence-lens"] button','Select linked orders across views for direct-d'));await press(h,button(h,'[data-widget="deadline-strip"] button','Select linked orders across views for d'));assert.deepEqual(crossValues(h),disabledSelections,'Trigger-disabled controls cannot change native selections');
  await press(h,button(h,'[data-widget="deadline-strip"] button','Open order proof for REF-D'));assert.deepEqual(h.orders,['d','d','d']);assert.deepEqual(crossValues(h),disabledSelections,'Disabling outbound selection leaves the separate proof action available');
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.networkAttempts,[]);await h.destroy();
  // Independently read actual installed widget APIs from the exact state the
  // real React controls produced. Empty renderers here qualify queries only.
  const params=new Map<string,NativeParams>(),peer=await nativeStudio(t,selectedState,{snapshot,onWidget:p=>params.set(p.widgetId,p as NativeParams)});
  for(const id of ['river','map','evidence','deadlines']){
    const p=params.get(id)!;assert(p);const fields=Object.entries(p.dataMapping).filter(([slot])=>id!=='river'||slot!=='time').flatMap(([,fields])=>fields),response=await p.widgetApi.getData({fields},{queryId:'react-produced-selection-'+id,crossFilter:['river','map'].includes(id)?'highlight':'filter'}),key=p.dataMapping.orderId![0].key;
    assert.equal(response.results.metadata?.error,undefined);assert.equal(response.crossFilter?.metadata?.error,undefined);assert.deepEqual((response.crossFilter?.rows??response.results.rows).map(row=>row[key]),['d']);
    if(['river','map'].includes(id))assert.equal(response.results.rows.length,6,'Highlight original denominator survives real control selections');
  }
  assert.deepEqual(peer.errors,[]);
});

test('actual regional small multiples retain original daily bars, exact historical references, selected rose stipple and Unknown denominators',async t=>{
  const snapshot=buildSnapshot(instrumentCorpus(),{asOf:times.end,knownAt:times.known,semanticModelVersion:'commerce-semantic-v3'}),h=await productionInstrumentStudio(t,snapshot,await historyFor(t,snapshot,{map:{displayMode:'small-multiples',measure:'late-share'}}));
  const delayed=[...h.win.document.querySelectorAll<HTMLButtonElement>('.river-state-cards>button')].find(node=>node.querySelector('.river-card-title')?.textContent?.trim()==='delayed');assert(delayed);await press(h,delayed);
  await h.until(()=>h.counts.get('map')?.selected===2,'The actual map getData did not receive the delayed-order cohort');
  const pnw=button(h,'.small-multiples>button','Select Pacific Northwest across views'),unknown=button(h,'.small-multiples>button','Select Unknown region across views'),sw=button(h,'.small-multiples>button','Select Southwest across views');
  for(const panel of [pnw,unknown,sw])assert.match(panel.querySelector('svg')?.getAttribute('aria-label')??'',/shared scale 0 to 100%/);
  const original=pnw.querySelector<SVGRectElement>('[data-history-day="2026-11-06"] [data-series="original"]'),selected=pnw.querySelector<SVGRectElement>('[data-history-day="2026-11-06"] [data-series="selected"]');assert(original);assert(selected);
  assert.equal(original.dataset.value,'0.5');assert.equal(original.dataset.denominator,'4');assert.equal(selected.dataset.value,'1');assert.equal(selected.dataset.denominator,'1');assert.equal(selected.getAttribute('fill'),'#ff4d6d');assert(Number(selected.getAttribute('width'))<Number(original.getAttribute('width')),'A narrower selected bar must keep the original context visible');assert(Number(selected.getAttribute('height'))>Number(original.getAttribute('height')));
  assert(pnw.querySelector('[data-history-day="2026-11-06"] rect[fill^="url("]'),'The selected overlay carries texture as well as color');
  const reference=pnw.querySelector<SVGRectElement>('[data-series="historical-original"]');assert(reference);assert.equal(reference.dataset.referenceAt,'2026-11-03T07:59:59.999Z');assert.equal(reference.dataset.value,String(2/3));assert.equal(reference.dataset.denominator,'3');assert.equal(reference.getAttribute('fill'),'#b6c1c5');
  assert.equal(pnw.querySelector('[data-series="historical-selected"]'),null,'A selected cohort with no historical due denominator must not receive a zero baseline');assert.match(pnw.textContent??'',/selected Unknown \(no denominator\).*0\/0 late\/due/);
  assert(sw.querySelector('[data-series="historical-selected"][stroke-dasharray]'),'The known selected historical reference has its own neutral dashed line');
  assert(unknown.querySelector('[data-series="original-unknown"]'));assert.equal(unknown.querySelector('[data-series="historical-original"]'),null);assert.match(unknown.textContent??'',/original Unknown \(no denominator\)/);
  await press(h,button(h,'[data-widget="impact-map"] button','Show exact data table'));
  const table=h.win.document.querySelector('[data-widget="impact-map"] table');assert(table);const headers=[...table.querySelectorAll('thead th')].map(node=>node.textContent!),rows=[...table.querySelectorAll('tbody tr')].map(row=>Object.fromEntries([...row.querySelectorAll('td')].map((cell,index)=>[headers[index],cell.textContent])));
  const historical=rows.find(row=>row.Region==='Pacific Northwest'&&row.Period==='Historical baseline');assert(historical);assert.equal(historical.Time,'2026-11-03T07:59:59.999Z');assert.equal(historical['Original value'],String(2/3));assert.equal(historical['Selected value'],'Unknown');assert.equal(historical['Original due'],'3');assert.equal(historical['Selected due'],'0');assert.equal(historical['Original orders'],'3');assert.equal(historical['Selected orders'],'1');
  const current=rows.find(row=>row.Region==='Pacific Northwest'&&row.Time==='2026-11-06');assert(current);assert.equal(current['Original value'],'0.5');assert.equal(current['Selected value'],'1');assert.equal(current['Original due'],'4');assert.equal(current['Selected due'],'1');
  await act(async()=>{const configured=await h.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'impact-map'}}).apply({widgetId:'map',op:'patch',value:{format:{displayMode:'small-multiples',measure:'count',showTable:false}}});assert.equal(configured.success,true);});
  await h.until(()=>Boolean(h.win.document.querySelector('.small-multiples')),'Count mode must return the real regional chart');
  for(const panel of h.win.document.querySelectorAll('.small-multiples>button'))assert.match(panel.querySelector('svg')?.getAttribute('aria-label')??'',/shared scale 0 to 3\./);
  const countPanel=button(h,'.small-multiples>button','Select Pacific Northwest across views');assert.equal(countPanel.querySelector('[data-history-day="2026-11-06"] [data-series="original"]')?.getAttribute('data-value'),'3');assert.equal(countPanel.querySelector('[data-history-day="2026-11-06"] [data-series="selected"]')?.getAttribute('data-value'),'1');assert.equal(countPanel.querySelector('[data-series="historical-original"]')?.getAttribute('data-value'),'3');assert.equal(countPanel.querySelector('[data-series="historical-selected"]')?.getAttribute('data-value'),'1');
  await act(async()=>{const configured=await h.api.defineAiCommand({type:'AgConfigureWidgetCommand',params:{widgetType:'impact-map'}}).apply({widgetId:'map',op:'patch',value:{format:{displayMode:'small-multiples',measure:'value',showTable:false}}});assert.equal(configured.success,true);});
  await h.until(()=>Boolean(h.win.document.querySelector('[data-widget="impact-map"] .widget-empty')?.textContent?.includes('Daily mapped money is not an inventory history')),'The production map must explicitly refuse unsupported value history');
  assert.equal(h.win.document.querySelector('[data-widget="impact-map"] .small-multiples'),null);assert.deepEqual(h.errors,[]);assert.deepEqual(h.networkAttempts,[]);
});

test('actual legacy v2 regional history retains its selected series and cannot invent v3 context or a historical baseline',async t=>{
  const snapshot=buildSnapshot(instrumentCorpus(),{asOf:times.end,knownAt:times.known,semanticModelVersion:'commerce-semantic-v2'}),h=await productionInstrumentStudio(t,snapshot,await historyFor(t,snapshot,{map:{displayMode:'small-multiples',measure:'late-share'}}));
  const delayed=[...h.win.document.querySelectorAll<HTMLButtonElement>('.river-state-cards>button')].find(node=>node.querySelector('.river-card-title')?.textContent?.trim()==='delayed');assert(delayed);await press(h,delayed);
  await h.until(()=>h.counts.get('map')?.selected===2,'The legacy native selected series did not refresh');
  const map=h.win.document.querySelector('[data-widget="impact-map"]');assert(map);assert.match(map.textContent??'',/Daily values for this saved selection/);assert.match(map.textContent??'',/Historical reference unavailable in this saved edition/);assert(map.querySelector('[data-series="legacy-selected"]'));assert.equal(map.querySelector('[data-series="original"]'),null);assert.equal(map.querySelector('[data-series="selected"]'),null);assert.equal(map.querySelector('[data-series^="historical-"]'),null);
  await press(h,button(h,'[data-widget="impact-map"] button','Show exact data table'));assert.deepEqual([...map.querySelectorAll('thead th')].map(node=>node.textContent),['Region','Day','Value','Late','Due']);assert.doesNotMatch(map.querySelector('tbody')?.textContent??'',/Historical baseline/);assert.deepEqual(h.errors,[]);assert.deepEqual(h.networkAttempts,[]);
});
