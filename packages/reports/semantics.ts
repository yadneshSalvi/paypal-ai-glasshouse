import type {Snapshot,TableRow} from '../domain/types';
import type {ReportDocument} from './types';

const count=(rows:readonly TableRow[],key:string)=>{
  const result=new Map<string,number>();for(const row of rows){const value=String(row[key]??'unknown');result.set(value,(result.get(value)??0)+1);}
  return [...result].sort(([a],[b])=>a.localeCompare(b)).map(([label,value])=>({label,value}));
};
export function reportInstruments(document:ReportDocument){
  const snapshot=document.snapshot;
  const inventory=count(snapshot.tables.order_snapshot,'fulfillmentState');
  const transitions=count(snapshot.tables.transition_snapshot,'dimension');
  const transitionTimes=snapshot.tables.transition_snapshot.map(row=>String(row.transitionTime)).sort();
  const latestByRegion=new Map<string,TableRow>();
  for(const row of snapshot.tables.regional_snapshot){const code=String(row.regionCode),old=latestByRegion.get(code);if(!old||String(row.inventoryAt)>String(old.inventoryAt))latestByRegion.set(code,row);}
  const regions=[...latestByRegion.values()].sort((a,b)=>String(a.regionCode).localeCompare(String(b.regionCode)));
  const deadlines=snapshot.tables.deadline_snapshot.map(row=>{
    const known=row.sourceClass==='sandbox'&&row.dueDateVerified===true&&typeof row.dueAt==='string'&&Number.isFinite(Date.parse(row.dueAt));
    const remainingMs=known?Date.parse(String(row.dueAt))-Date.parse(document.createdAt):null;
    return {...row,verified:known,remainingMs,comparisonAt:document.createdAt} as TableRow&{verified:boolean;remainingMs:number|null;comparisonAt:string};
  }).sort((a,b)=>a.verified&&b.verified?String(a.dueAt).localeCompare(String(b.dueAt)):a.verified?-1:b.verified?1:String(a.id).localeCompare(String(b.id)));
  const operationStates=count(document.observed.operations.map(row=>({state:row.status})),'state');
  return {inventory,transitions,transitionRange:{from:transitionTimes[0]??null,to:transitionTimes.at(-1)??null},regions,deadlines,operationStates};
}
export const reportMoney=(minor:number,currency='USD')=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:2}).format(minor/100);
export const reportTime=(iso:string|null|undefined)=>iso&&Number.isFinite(Date.parse(iso))?new Date(iso).toISOString().replace('T',' ').replace('.000Z','Z').replace(/Z$/,' UTC'):'Unknown';
export const reportSource=(source:string)=>({sample:'Sample',fixture_shipping:'Fixture shipping',fixture_support:'Fixture support',sandbox:'PayPal sandbox',replay:'Replay',modelled:'Modelled'}[source]??source);
export function snapshotFacts(snapshot:Snapshot){return {affected:snapshot.totals.affected,orders:snapshot.totals.orders,capturedMinor:snapshot.totals.capturedMinor,refundMinor:snapshot.totals.refundMinor,openDisputes:snapshot.totals.openDisputes,currency:snapshot.context.currency,clock:snapshot.context.clockDomain,asOf:snapshot.context.asOf,knownAt:snapshot.context.knownAt};}
export function historyCounts(history:ReportDocument['layout']['history']){
  return {nativePages:history.current.pages.length,nativeWidgets:history.current.pages.reduce((total,page)=>total+Object.values(page.widgets??{}).filter(Boolean).length,0),undoEntries:history.undo.length,redoEntries:history.redo.length};
}
