import {createDataEngine,type AgStudioQuery,type AgStudioQueryField,type AgStudioFilterDefinition,type AgFilterDefinition,type AgWidgetFieldReference,type AgPageState,type AgFilterState,type AgFilterModelState,type AgCrossFilterState,type AgReportState,type AgDataEngine,type AgDataSourcesDefinition} from 'ag-studio';
import type {Snapshot} from '../domain/types';
import type {GlasshouseRegistry,InstrumentData,InstrumentFormat,WidgetKind} from './types';
import {studioData,fieldsFor} from './data';
import {instrumentResult,normalizeInstrumentRows,type InstrumentResult} from './instrument-model';
import {getWidgetCrossFilterConfig} from './widget-metadata';

export interface NativePrintWidget {pageId:string;widgetId:string;type:string;title:string;status:'exact'|'unsupported';reason?:string;columns:string[];rows:Array<Record<string,string|number|boolean|null>>;originalRows?:Array<Record<string,string|number|boolean|null>>;instrument?:InstrumentResult;mapping:unknown;filter:unknown;query?:AgStudioQuery}
export interface NativePrint {version:1;engine:'AG Studio 3.1.0';snapshotHash:string;capturedAt:string;widgets:NativePrintWidget[]}
const custom=new Set(['commerce-river','time-dial','evidence-lens','recovery-branches','impact-map','deadline-strip']);
const flat=new Set(['grid','value','line-chart','area-chart','column-chart-grouped','column-chart-stacked','bar-chart-grouped','bar-chart-stacked','pie-chart','donut-chart']);
const filterOperators=new Set(['equals','notEqual','isIn','isNull','isNotNull','isTrue','isFalse','lessThan','lessThanOrEqual','greaterThan','greaterThanOrEqual','between','contains','notContains','startsWith','endsWith','like','notLike']);
const aggregations=new Set(['sum','count','countd','avg','min','max']);
const alias=(ref:AgWidgetFieldReference)=>ref.id+(ref.aggregation?':'+ref.aggregation:'');
function field(ref:AgWidgetFieldReference,snapshot:Snapshot):AgStudioQueryField{
  if(Object.keys(ref).some(key=>!['id','aggregation'].includes(key)))throw new Error('This field uses a bucket, empty-member or custom transform that this print version does not support.');
  const split=ref.id.indexOf('.'),sourceId=ref.id.slice(0,split),fieldId=ref.id.slice(split+1),rows=snapshot.tables[sourceId];
  const definition=rows?fieldsFor(sourceId,rows)?.find(field=>field.id===fieldId):undefined;
  if(split<1||!rows||!definition)throw new Error('The mapped field is not an admitted scalar source column. Calculated fields require a separately supported print adapter.');
  if(ref.aggregation&&!aggregations.has(ref.aggregation))throw new Error('This aggregation is not supported by this exact print adapter.');
  const dataType=definition.format==='dateTimeFormat'?'datetime':definition.format==='integerFormat'?'number':definition.format==='booleanFormat'?'boolean':'string';
  return {key:alias(ref),sourceId,fieldId:ref.id,dataType,...ref.aggregation?{aggregation:ref.aggregation,sourceField:{key:ref.id,sourceId,fieldId:ref.id,dataType}}:{}};
}
const and=(conditions:AgStudioFilterDefinition[]):AgStudioFilterDefinition|undefined=>conditions.length?{combinator:'and',conditions}:undefined;
function filterValue(resolved:AgStudioQueryField,value:import('ag-studio').AgStudioFilterCondition['value']):import('ag-studio').AgStudioFilterCondition['value']{
  if(resolved.dataType!=='datetime'||value===null||value===undefined)return value;
  if(Array.isArray(value))return value.map(item=>filterValue(resolved,item)) as import('ag-studio').AgPrimitive[];
  if(value instanceof Date&&Number.isFinite(value.getTime()))return value;
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value)))return new Date(value);
  throw new Error('This temporal native filter does not contain an exact timestamp with an explicit offset.');
}
function condition(ref:AgWidgetFieldReference,model:AgFilterModelState,snapshot:Snapshot):AgStudioFilterDefinition{
  if('conditions' in model){if(model.conditions.length>2||model.conditions.some(item=>'conditions'in item))throw new Error('This native filter group is invalid.');return {combinator:model.operator.toLowerCase() as 'and'|'or',conditions:model.conditions.map(child=>condition(ref,child,snapshot))};}
  if(!filterOperators.has(model.operator))throw new Error(`Filter ${model.operator} needs an exact print adapter; the saved native filter is retained.`);
  if(ref.aggregation)throw new Error('An aggregated filter requires a supported post-aggregation print adapter.');
  const resolved=field(ref,snapshot);
  return {field:resolved,operator:model.operator as never,value:filterValue(resolved,model.value),options:model.options};
}
function filters(rows:AgFilterState[]|undefined,snapshot:Snapshot){return (rows??[]).filter(row=>row.model).map(row=>condition(row.field,row.model!,snapshot));}
function crosses(state:AgCrossFilterState|undefined,snapshot:Snapshot,excludeWidgetId?:string){
  const result:AgStudioFilterDefinition[]=[];
  for(const [owner,selections] of Object.entries(state?.values??{}).sort(([a],[b])=>a.localeCompare(b))){
    if(owner===excludeWidgetId)continue;
    for(const selection of selections.slice().sort((a,b)=>a.group-b.group)){
    if(selection.type==='value'){const resolved=field(selection.field,snapshot);result.push({field:resolved,operator:'isIn',value:filterValue(resolved,selection.values),options:{crossFilter:true}});}
    else if(selection.type==='range'){const resolved=field(selection.field,snapshot),options={crossFilter:true};if(selection.from!==undefined&&selection.to!==undefined)result.push({field:resolved,operator:'between',value:filterValue(resolved,[selection.from,selection.to]),options});else if(selection.from!==undefined)result.push({field:resolved,operator:'greaterThanOrEqual',value:filterValue(resolved,selection.from),options});else if(selection.to!==undefined)result.push({field:resolved,operator:'lessThanOrEqual',value:filterValue(resolved,selection.to),options});}
    else result.push({combinator:'or',conditions:selection.values.map(pair=>({combinator:'and',conditions:pair.map(value=>{const resolved=field(value.field,snapshot);return {field:resolved,operator:value.value===null?'isNull':'equals',value:filterValue(resolved,value.value),options:{crossFilter:true}};})}))});
    }
  }
  return result;
}
/** Shared exact native scope for static output and read-only drill-through. Unsupported
 * native filters fail closed; no local JavaScript predicate substitutes for native filtering. */
export function pageScopeFilter(state:AgReportState<GlasshouseRegistry>,widgetId:string,snapshot:Snapshot):AgStudioFilterDefinition|undefined{
  const page=state.pages.find(page=>page.id===state.selectedPageId);if(!page)throw new Error('The selected native report page is missing.');
  return and([...filters(page.filter?.page,snapshot),...filters(page.filter?.widget?.[widgetId],snapshot),...crosses(page.crossFilter,snapshot)]);
}
function buildQuery(refs:AgWidgetFieldReference[],filter:AgStudioFilterDefinition|undefined,snapshot:Snapshot,sort?:{field:AgWidgetFieldReference;direction:'asc'|'desc'}[]):AgStudioQuery{
  const fields=refs.map(ref=>field(ref,snapshot));if(!fields.length)throw new Error('This widget has no mapped fields.');
  const sources=new Set(fields.map(f=>f.sourceId));
  // Filters on related sources are evaluated by the installed engine as native
  // relationship filters. Only projected/aggregated source grains are restricted.
  if(sources.size>1)throw new Error('This mapping joins source grains. Its exact native configuration is retained; this print adapter does not flatten a money-multiplying join.');
  const sourceId=fields[0].sourceId!,filterSources=new Set<string>();
  const visit=(value:AgStudioFilterDefinition)=>{if('conditions'in value)value.conditions.forEach(visit);else if('field'in value)filterSources.add(value.field.sourceId!);else throw new Error('A native predicate needs a separately supported exact filter adapter.');};if(filter)visit(filter);
  const joins:NonNullable<AgStudioQuery['joins']>=[];
  for(const other of filterSources){
    if(other===sourceId)continue;
    const relation=studioData(snapshot).relationships?.find(relation=>typeof relation.source==='string'&&typeof relation.target==='string'&&[relation.source.split('.')[0],relation.target.split('.')[0]].includes(sourceId)&&[relation.source.split('.')[0],relation.target.split('.')[0]].includes(other));
    if(!relation)throw new Error('This filter crosses a source relationship without a supported exact semi-join. Its native configuration is retained.');
    if(typeof relation.source!=='string'||typeof relation.target!=='string')throw new Error('This source relationship is not a supported scalar relation.');
    const forward=relation.source.startsWith(sourceId+'.');
    // These are the public query clauses emitted by AG Studio 3.1 for this
    // declared relation. A semi-join preserves the projected source grain;
    // multiple matching child receipts never multiply order money.
    joins.push({sourceId:other,leftSourceId:sourceId,joinType:'semi-left',leftField:field({id:forward?relation.source:relation.target},snapshot),rightField:field({id:forward?relation.target:relation.source},snapshot),cardinality:forward?'one-to-many':'many-to-one',isFilterOnly:true});
  }
  const dimensions=fields.filter(f=>!f.aggregation).map(f=>({field:f})),measures=fields.filter(f=>f.aggregation).map(f=>({field:f}));
  return {axes:[{dimensions}],measures,joins,filter,sort:sort?.map(item=>({field:field(item.field,snapshot),direction:item.direction})),limit:{count:25_001}};
}
async function execute(engine:AgDataEngine,query:AgStudioQuery){
  let invalid=false;const validation=(event:unknown)=>{if(event&&typeof event==='object'&&'issues'in event&&Array.isArray(event.issues)&&event.issues.length)invalid=true;};
  engine.addEventListener?.('validation',validation,false);
  try{const [result]=await engine.execute({query,options:{shape:'rows',strict:true},info:{widgetId:'immutable-print'}});await new Promise(resolve=>setTimeout(resolve,0));
    if(invalid||result.metadata?.error||result.dataShape!=='rows')throw new Error('The detached installed native engine refused this print query.');
    if(result.rows.length>25_000)throw new Error('The complete native result exceeds this print edition’s 25,000-row bound. No truncated result is presented as exact.');
    return result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value??null]))) as NativePrintWidget['rows'];
  }finally{engine.removeEventListener?.('validation',validation,false);}
}
export async function nativePrint(snapshot:Snapshot,state:AgReportState<GlasshouseRegistry>,capturedAt:string):Promise<NativePrint>{
  const output:NativePrint={version:1,engine:'AG Studio 3.1.0',snapshotHash:snapshot.hash,capturedAt,widgets:[]};
  const count=state.pages.reduce((sum,page)=>sum+Object.keys(page.widgets??{}).length,0);if(count>200)throw new Error('An exact print edition supports up to 200 native widgets.');
  for(const page of state.pages)for(const [widgetId,widget] of Object.entries(page.widgets??{}).sort(([a],[b])=>{
    const left=page.widgetLayout?.[a],right=page.widgetLayout?.[b];return (left?.yTrack??0)-(right?.yTrack??0)||(left?.xTrack??0)-(right?.xTrack??0)||a.localeCompare(b);
  })){
    if(!widget)continue;
    const entry:NativePrintWidget={pageId:page.id,widgetId,type:widget.type,title:widget.format?.title?.text??widget.type,status:'unsupported',columns:[],rows:[],mapping:widget.dataMapping??{},filter:{page:page.filter?.page??[],widget:page.filter?.widget?.[widgetId]??[],crossFilter:page.crossFilter??null}};
    let engine:AgDataEngine|undefined;
    try{
      if(!custom.has(widget.type)&&!flat.has(widget.type))throw new Error('This widget type has no exact static adapter in this edition. Its complete native configuration remains in JSON.');
      if(state.schema&&(Object.keys(state.schema).some(key=>!['fields'].includes(key))||Object.values(state.schema.fields??{}).some(field=>field.expression!==undefined||field.format!==undefined)))throw new Error('This authored schema transform or field format needs a separately supported print adapter.');
      const mapping=widget.dataMapping as Record<string,AgWidgetFieldReference[]|undefined>,slots=custom.has(widget.type)?['orderId','category','value','time','snapshot']:widget.type==='grid'?['cols']:widget.type==='value'?['value','sparklineX']:['categoryKey','legendKey','valueKey','tooltipKey'];
      if(Object.entries(mapping??{}).some(([name,value])=>value?.length&&!slots.includes(name)))throw new Error('This native data slot needs a separately supported print adapter.');
      // JSONB preserves arrays but may reorder object properties. Authored widget
      // layout and declared slot order, never object insertion order, define print order.
      const refs=slots.filter(name=>widget.type!=='commerce-river'||name!=='time').flatMap(name=>mapping?.[name]??[]);
      const chart=!custom.has(widget.type)&&widget.type!=='grid'&&widget.type!=='value';
      if(chart){
        if(mapping.categoryKey?.length!==1||!mapping.valueKey?.length||mapping.valueKey.some(ref=>!ref.aggregation)||mapping.tooltipKey?.some(ref=>!ref.aggregation))throw new Error('This exact chart adapter requires one category and explicitly aggregated value and tooltip fields.');
        if(mapping.legendKey?.length&&(widget.format as {seriesLimit?:{enabled?:boolean}})?.seriesLimit?.enabled!==false)throw new Error('A chart with an active legend series limit needs a supported ranking adapter. Disable that limit to export every exact legend member.');
      }
      if(widget.type==='value'&&(mapping.sparklineX?.length||mapping.value?.length!==1||!mapping.value[0].aggregation))throw new Error('This exact value adapter requires one explicit aggregation without a sparkline.');
      const definition=getWidgetCrossFilterConfig(widget.type);if(!definition)throw new Error('The widget type is not registered in this exact print edition.');
      // The clock reconstructs the shared report and deliberately ignores peer
      // selections, including a Filter value retained in an earlier layout.
      const format=widget.format??{},cross=widget.type==='time-dial'?'none':format.crossFilter??definition.defaultMode;
      const base=[...filters(page.filter?.page,snapshot),...filters(page.filter?.widget?.[widgetId],snapshot)],shared=cross==='none'?[]:crosses(page.crossFilter,snapshot);
      // AG Studio 3.1 resolveCrossFilteredQueries keeps other widgets' selections
      // in a highlight-capable Filter widget's original result. Its own selection
      // is applied only to the subset, even when the configured mode is Filter.
      const originalCross=cross==='filter'?(definition.supportsHighlight?crosses(page.crossFilter,snapshot,widgetId):shared):[];
      const category=chart?mapping.categoryKey![0]:undefined,categoryType=category?field(category,snapshot).dataType:undefined;
      const sort=widget.sort?.length?widget.sort:category&&['datetime','number'].includes(categoryType??'')?[{field:category,direction:'asc' as const}]:undefined;
      const query=buildQuery(refs,and([...base,...originalCross]),snapshot,sort as never);
      engine=createDataEngine(studioData(snapshot) as AgDataSourcesDefinition);await engine.init?.();engine.finalize?.();
      entry.query=query;
      const original=await execute(engine,query),subset=shared.length&&(cross==='highlight'||cross==='filter'&&definition.supportsHighlight)?await execute(engine,buildQuery(refs,and([...base,...shared]),snapshot,sort as never)):null;
      entry.status='exact';
      if(custom.has(widget.type)){
        const keys={orderId:mapping.orderId?.[0]?alias(mapping.orderId[0]):'',category:mapping.category?.[0]?alias(mapping.category[0]):undefined,value:mapping.value?.[0]?alias(mapping.value[0]):undefined,time:mapping.time?.[0]?alias(mapping.time[0]):undefined};
        const result=instrumentResult({snapshot,kind:widget.type as WidgetKind,format:format as InstrumentFormat,mapping:{orderId:mapping.orderId?.[0]?.id??'',category:mapping.category?.[0]?.id,value:mapping.value?.[0]?.id,time:mapping.time?.[0]?.id},original:normalizeInstrumentRows(original,keys),subset:subset?normalizeInstrumentRows(subset,keys):null},capturedAt);
        if(result.error)throw new Error(result.error);
        entry.instrument=result;entry.title=format.title?.text??result.title;entry.columns=result.columns;entry.rows=result.rows;
      }else{entry.columns=refs.map(alias);entry.rows=subset??original;if(subset)entry.originalRows=original;}
    }catch(reason){entry.status='unsupported';entry.reason=reason instanceof Error?reason.message:'This native mapping could not be reproduced exactly.';entry.rows=[];delete entry.instrument;}
    finally{engine?.dispose?.();}output.widgets.push(entry);
  }
  return output;
}

/** Run an exact order scope through a separate installed engine for drill-through. */
export async function nativeOrderScope(snapshot:Snapshot,state:AgReportState<GlasshouseRegistry>,extra?:AgStudioFilterDefinition):Promise<string[]>{
  const page=state.pages.find(page=>page.id===state.selectedPageId);if(!page)throw new Error('The current report is unavailable.');
  const query=buildQuery([{id:'order_snapshot.id'}],and([...filters(page.filter?.page,snapshot),...crosses(page.crossFilter,snapshot),...extra?[extra]:[]]),snapshot);
  const engine=createDataEngine(studioData(snapshot) as AgDataSourcesDefinition);try{await engine.init?.();engine.finalize?.();return (await execute(engine,query)).map(row=>String(row['order_snapshot.id']));}finally{engine.dispose?.();}
}
export function orderIdDrillFilter(ids:readonly string[]):AgFilterDefinition{return {field:{id:'order_snapshot.id'},operator:'isIn',value:[...ids]};}
