import type { AgBaseRegistry,AgDefaultWidgetDefinition,AgWidgetData,AgWidgetDataFormat,AgWidgetFieldReference,AgStudioApi,AgReportHistory } from 'ag-studio';
import type { AgWidgetDefinition } from 'ag-studio-react';
import type { Snapshot,AgentRunEvent } from '../domain/types';
import type {TemporalPlayback} from './playback';
export type WidgetKind='commerce-river'|'time-dial'|'evidence-lens'|'recovery-branches'|'impact-map'|'deadline-strip';
export interface InstrumentFormat extends AgWidgetDataFormat<unknown> {
  displayMode?:string; showLabels?:boolean; showTable?:boolean; budgetMinor?:number; showContradictions?:boolean;
  measure?:'count'|'value'|'late-share'; rangeStart?:string; rangeEnd?:string;
  timezone?:'UTC'|'Asia/Kolkata'|'America/Los_Angeles';
  playbackStepMinutes?:number;direction?:'forward'|'reverse';showMotion?:boolean;showBlocked?:boolean;
  evidenceKind?:string; evidenceSource?:string; redactExcerpts?:boolean; evidenceOrder?:'freshest'|'oldest'|'kind';
  gracePolicy?:'compare'|'targeted'|'comprehensive';
  deadlineState?:string; deadlineOwner?:'all'|'merchant'|'buyer'|'provider'|'none'|'unknown'; deadlineSort?:'soonest'|'latest'|'reference'; showUnknown?:boolean;
}
export interface InstrumentData extends AgWidgetData<{orderId:AgWidgetFieldReference[];category?:AgWidgetFieldReference[];value?:AgWidgetFieldReference[];time?:AgWidgetFieldReference[];snapshot?:AgWidgetFieldReference[]},InstrumentFormat>{type:WidgetKind}
export type InstrumentDefinition=AgWidgetDefinition<WidgetKind,InstrumentData>;
export interface GlasshouseRegistry extends AgBaseRegistry { widgets:readonly (AgDefaultWidgetDefinition|InstrumentDefinition)[] }
export interface StudioBridge {
  playback?:TemporalPlayback;
  canCommitSnapshot?(hash:string):boolean;
  getSnapshot():Snapshot;
  onTime(asOf:string,knownAt?:string,clock?:'narrative_replay'|'observed',currency?:import('../domain/types').Currency):void;
  onOrder(orderId:string):void;
  onBranch(branchId:string,scope?:{orderIds:string[];budgetMinor:number;snapshotHash:string}):void;
  onRevision():void;
  onFindings?():void;
  onWidgetReady(widgetId:string,hash:string,count:number,highlightCount:number):void;
  onEvent(event:AgentRunEvent):void;
  onApi(api:AgStudioApi<GlasshouseRegistry>):void;
  onHistory(history:AgReportHistory<GlasshouseRegistry>):void;
  onError(message:string):void;
}
