import type {AgStudioApi,AgCrossFilterSelectionState} from 'ag-studio';
import type {GlasshouseRegistry} from './types';
import type {Snapshot} from '../domain/types';

/** Update only this native widget's selection. The SDK's resetCrossFilter clears
 * the whole page; using the public report state keeps other selections intact. */
export function clearNativeSelection(api:AgStudioApi<GlasshouseRegistry>,widgetId:string,group?:number){
 const state=api.getState();api.setState({...state,pages:state.pages.map(page=>{
  if(page.id!==state.selectedPageId)return page;
  const values={...page.crossFilter?.values},kept=group===undefined?[]:(values[widgetId]??[]).filter(selection=>selection.group!==group);
  if(kept.length)values[widgetId]=kept;else delete values[widgetId];
  return {...page,crossFilter:{values}};
 })});
}

/** One native state transaction for an exact ID cohort. It avoids hundreds of
 * incremental selection/history writes and keeps every selected identity. */
export function setNativeOrderSelection(api:AgStudioApi<GlasshouseRegistry>,widgetId:string,fieldId:string,orderIds:readonly string[],group=0){
 const state=api.getState(),ids=[...new Set(orderIds)].sort();
 if(!ids.length)return;
 api.setState({...state,pages:state.pages.map(page=>{
  if(page.id!==state.selectedPageId||page.widgets?.[widgetId]?.format?.triggerCrossFilter===false)return page;
  const values={...page.crossFilter?.values},previous=values[widgetId]??[],current=previous.find(selection=>selection.group===group),same=current?.type==='multiValue'&&current.values.length===ids.length&&current.values.every(pair=>pair.length===1&&pair[0].field.id===fieldId&&ids.includes(String(pair[0].value)));
  const selection:AgCrossFilterSelectionState={type:'multiValue',group,values:ids.map(value=>[{field:{id:fieldId},value}])};
  values[widgetId]=[...previous.filter(item=>item.group!==group),...same?[]:[selection]];
  if(!values[widgetId].length)delete values[widgetId];
  return {...page,crossFilter:{values}};
 })});
}

/** Resolve only citations present in this admitted snapshot. A cohort excerpt
 * is not an order set; its explicit evidence/transition links establish one. */
export function evidenceOrderSelection(snapshot:Snapshot,evidenceId:string,visibleOrderIds:readonly string[]){
 const allowed=new Set(snapshot.orders.map(order=>order.id)),visible=new Set(visibleOrderIds),byEvidence=new Map(snapshot.evidence.filter(row=>row.tenantId===snapshot.context.tenantId).map(row=>[row.id,row])),byTransition=new Map<string,Set<string>>();
 for(const row of snapshot.tables.transition_snapshot){
  const orderId=String(row.orderId);if(!allowed.has(orderId))continue;
  for(const reference of [row.id,row.sourceEventId])if(typeof reference==='string'){
   const orders=byTransition.get(reference)??new Set<string>();orders.add(orderId);byTransition.set(reference,orders);
  }
 }
 const linked=new Set<string>(),seen=new Set<string>(),pending=[evidenceId];
 while(pending.length){
  const reference=pending.pop()!;if(seen.has(reference))continue;seen.add(reference);
  for(const orderId of byTransition.get(reference)??[])linked.add(orderId);
  const evidence=byEvidence.get(reference);if(!evidence)continue;
  if(evidence.orderId&&allowed.has(evidence.orderId)){linked.add(evidence.orderId);continue;}
  pending.push(...evidence.supports,...evidence.contradicts);
 }
 return {linkedOrderCount:linked.size,orderIds:[...linked].filter(orderId=>visible.has(orderId)).sort()};
}

export function setNativeTransitionWindow(api:AgStudioApi<GlasshouseRegistry>,widgetId:string,start:string,end:string,dimension:string){
 if(!['payment','fulfillment','remediation','dispute'].includes(dimension)||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||Date.parse(start)>=Date.parse(end))throw new Error('A transition selection needs its exact dimension and increasing time window.');
 const state=api.getState();api.setState({...state,pages:state.pages.map(page=>{
  if(page.id!==state.selectedPageId||page.widgets?.[widgetId]?.format?.triggerCrossFilter===false)return page;
  const values={...page.crossFilter?.values};values[widgetId]=[...(values[widgetId]??[]).filter(item=>item.group!==1&&item.group!==2),
   {type:'range',group:1,field:{id:'transition_snapshot.transitionTime'},from:new Date(start).toISOString(),to:new Date(Date.parse(end)-1).toISOString()},
   {type:'value',group:2,field:{id:'transition_snapshot.dimension'},values:[dimension]}];
  return {...page,crossFilter:{values}};
 })});
}
