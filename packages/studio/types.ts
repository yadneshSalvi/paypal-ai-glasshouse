import type { AgBaseRegistry,AgDefaultWidgetDefinition,AgWidgetData,AgWidgetDataFormat,AgWidgetFieldReference,AgStudioApi,AgReportHistory } from 'ag-studio';
import type { AgWidgetDefinition } from 'ag-studio-react';
import type { Snapshot,AgentRunEvent } from '../domain/types';
export type WidgetKind='commerce-river'|'time-dial'|'evidence-lens'|'recovery-branches'|'impact-map'|'deadline-strip';
export interface InstrumentFormat extends AgWidgetDataFormat<unknown> {
  displayMode?:string; showLabels?:boolean; showTable?:boolean; budgetMinor?:number; showContradictions?:boolean;
}
export interface InstrumentData extends AgWidgetData<{orderId:AgWidgetFieldReference[];category?:AgWidgetFieldReference[];value?:AgWidgetFieldReference[];time?:AgWidgetFieldReference[];snapshot?:AgWidgetFieldReference[]},InstrumentFormat>{type:WidgetKind}
export type InstrumentDefinition=AgWidgetDefinition<WidgetKind,InstrumentData>;
export interface GlasshouseRegistry extends AgBaseRegistry { widgets:readonly (AgDefaultWidgetDefinition|InstrumentDefinition)[] }
export interface StudioBridge {
  getSnapshot():Snapshot;
  onTime(asOf:string):void;
  onOrder(orderId:string):void;
  onBranch(branchId:string):void;
  onRevision():void;
  onWidgetReady(widgetId:string,hash:string,count:number,highlightCount:number):void;
  onEvent(event:AgentRunEvent):void;
  onApi(api:AgStudioApi<GlasshouseRegistry>):void;
  onHistory(history:AgReportHistory<GlasshouseRegistry>):void;
  onError(message:string):void;
}
