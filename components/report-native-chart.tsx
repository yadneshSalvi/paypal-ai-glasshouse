import type {NativePrintWidget} from '@/packages/studio/native-print';
import {RegionalReferenceChart} from '@/packages/studio/regional-chart';
import {instrumentScopeLabel} from '@/packages/studio/instrument-model';

/** Full saved query scope, distinct from a group's denominator or a table page. */
export function ReportNativeScope({widget}:{widget:NativePrintWidget}){
  if(!widget.instrument)return null;
  return <p className="edition-note edition-native-scope">{widget.instrument.scopeLabel??instrumentScopeLabel(widget.instrument)}</p>;
}

/** Present the exact saved native result, including its admitted denominator. */
export function ReportNativeChart({widget}:{widget:NativePrintWidget}){
  const instrument=widget.instrument;
  if(!instrument?.groups.length)return null;
  const ratio=instrument.kind==='impact-map'&&instrument.unit==='late / due shipments';
  if(instrument.kind==='impact-map'&&widget.rows.some(row=>row.Period==='Daily')){
    const scale=ratio?1:Math.max(1,...instrument.groups.flatMap(group=>[
      group.baseline?.originalValue??0,group.baseline?.selectedValue??0,
      ...(group.daily??[]).flatMap(day=>[day.originalValue??day.value??0,day.selectedValue??day.value??0]),
    ]));
    return <div className="edition-regional-references">{instrument.groups.map(group=><figure key={group.key}>
      <figcaption>{group.label}</figcaption>
      <RegionalReferenceChart group={group} scale={scale} ratio={ratio} highlighted={instrument.highlighted}/>
    </figure>)}</div>;
  }
  const maximum=ratio?1:Math.max(1,...instrument.groups.map(group=>group.value));
  const display=(amount:number,known:boolean)=>!known?'Unknown':ratio?(amount*100).toFixed(1)+'%':amount.toLocaleString();
  return <div className="edition-native-bars">{instrument.groups.map(group=>{
    const known=!ratio||Boolean(group.denominator),originalKnown=!ratio||Boolean(group.originalDenominator);
    return <div key={group.key}>
      <span>{group.label}</span>
      {known?<meter min="0" max={maximum} value={group.selected} aria-label={group.label+' selected'}/>:<span className="edition-unknown-measure">No denominator</span>}
      <strong>{display(group.selected,known)}</strong><small> / {display(group.value,originalKnown)} original in this group</small>
    </div>;
  })}</div>;
}
