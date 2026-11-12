import {createWidgets} from 'ag-studio';
import type {WidgetKind} from './types';

export type NativeCrossFilterMode='none'|'filter'|'highlight';
export interface WidgetCrossFilterConfig {supportsHighlight:boolean;defaultMode:NativeCrossFilterMode}

/** One contract feeds both the registered React instruments and static queries.
 * Built-in capabilities come from the installed registry, never a chart-name list.
 * This module has no React or browser dependency, so saved editions can use it. */
export const instrumentCrossFilter:Record<WidgetKind,WidgetCrossFilterConfig>={
  'commerce-river':{supportsHighlight:true,defaultMode:'highlight'},
  'time-dial':{supportsHighlight:false,defaultMode:'none'},
  'evidence-lens':{supportsHighlight:false,defaultMode:'filter'},
  'recovery-branches':{supportsHighlight:false,defaultMode:'filter'},
  'impact-map':{supportsHighlight:true,defaultMode:'highlight'},
  'deadline-strip':{supportsHighlight:false,defaultMode:'filter'},
};
const builtInDefinitions=createWidgets({}).widgets;
const builtIns=new Map<string,(typeof builtInDefinitions)[number]>(builtInDefinitions.map(definition=>[definition.id,definition]));
export function getWidgetCrossFilterConfig(type:string):WidgetCrossFilterConfig|undefined{
  if(Object.hasOwn(instrumentCrossFilter,type))return instrumentCrossFilter[type as WidgetKind];
  const definition=builtIns.get(type);
  if(!definition)return undefined;
  const configured=definition.defaultState?.format?.crossFilter;
  return {supportsHighlight:definition.featureConfig?.crossFilter?.supportsHighlight===true,
    defaultMode:configured==='none'||configured==='highlight'?configured:'filter'};
}
