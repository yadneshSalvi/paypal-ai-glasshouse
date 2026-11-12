import {useId} from 'react';
import type {InstrumentGroup,InstrumentRegionalStats} from './instrument-model';

export interface RegionalReferenceChartProps {
  group:InstrumentGroup;
  scale:number;
  ratio:boolean;
  highlighted:boolean;
  labels?:boolean;
}

const describe=(value:number|null,ratio:boolean)=>value===null?'Unknown (no denominator)':ratio?`${Math.round(value*1000)/10}%`:value.toLocaleString()+' orders';
const reference=(stats:InstrumentRegionalStats,selected:boolean,ratio:boolean)=>{
  const value=selected?stats.selectedValue:stats.originalValue,numerator=selected?stats.selectedNumerator:stats.originalNumerator,denominator=selected?stats.selectedDenominator:stats.originalDenominator,orders=selected?stats.selectedOrderCount:stats.originalOrderCount;
  return `${describe(value,ratio)}${ratio?` · ${orders} orders`:''} · ${numerator}/${denominator} late/due shipments`;
};

/** Shared live/saved geometry. The band is an earlier observed reference at the
 * same K and denomination, never a confidence interval or a daily value guess. */
export function RegionalReferenceChart({group,scale,ratio,highlighted,labels=true}:RegionalReferenceChartProps){
  const pattern='regional-selection-'+useId().replaceAll(':',''),days=group.daily??[],exact=days.every(day=>day.originalValue!==undefined&&day.selectedValue!==undefined),selected=highlighted&&exact;
  const maximum=Number.isFinite(scale)&&scale>0?scale:1,height=(value:number|null|undefined)=>value===null||value===undefined?null:Math.max(0,Math.min(1,value/maximum))*62,baseline=group.baseline;
  const originalReference=height(baseline?.originalValue),selectedReference=height(baseline?.selectedValue),width=208/Math.max(1,days.length);
  const unit=ratio?'late share':'orders',legend=exact?`Mint bars: original native scope.${selected?' Rose stipple: shared selection.':''}`:'Daily values for this saved selection.';
  return <>
    <svg viewBox="0 0 240 106" role="img" aria-label={`${group.label}: daily ${unit}, shared scale 0 to ${ratio?'100%':maximum}. ${legend} ${baseline?'Grey band: historical reference.':'Historical reference unavailable in this saved edition.'}`}>
      <defs><pattern id={pattern} width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r=".8" fill="#fff" opacity=".85"/></pattern></defs>
      <line x1="24" x2="234" y1="80" y2="80" stroke="#52666d"/>
      <line x1="24" x2="234" y1="18" y2="18" stroke="#52666d" strokeDasharray="2 4" opacity=".55"/>
      <text x="1" y="22" fill="#b3c4c2" fontSize="10">{ratio?'100%':maximum}</text><text x="12" y="83" fill="#b3c4c2" fontSize="10">0</text>
      {originalReference!==null&&<rect data-series="historical-original" data-reference-at={baseline!.at} data-value={baseline!.originalValue??'unknown'} data-denominator={baseline!.originalDenominator} x="24" width="210" y={Math.max(16,78-originalReference)} height="4" fill="#b6c1c5" fillOpacity=".35"><title>{`Historical original at ${baseline!.at}: ${reference(baseline!,false,ratio)}. Historical reference, not a confidence interval.`}</title></rect>}
      {selected&&selectedReference!==null&&<line data-series="historical-selected" data-reference-at={baseline!.at} data-value={baseline!.selectedValue??'unknown'} data-denominator={baseline!.selectedDenominator} x1="24" x2="234" y1={80-selectedReference} y2={80-selectedReference} stroke="#d0dadb" strokeWidth="1.6" strokeDasharray="4 3"><title>{`Historical selected at ${baseline!.at}: ${reference(baseline!,true,ratio)}`}</title></line>}
      {days.map((day,index)=>{
        const originalValue=day.originalValue===undefined?day.value:day.originalValue,selectedValue=day.selectedValue===undefined?day.value:day.selectedValue,originalHeight=height(originalValue),selectedHeight=height(selectedValue),x=26+index*width,barWidth=Math.max(1,width-4);
        const originalNumerator=day.originalNumerator??day.numerator,originalDenominator=day.originalDenominator??day.denominator,selectedNumerator=day.selectedNumerator??day.numerator,selectedDenominator=day.selectedDenominator??day.denominator;
        return <g key={day.day} data-history-day={day.day}>
          {originalHeight===null?<text data-series={exact?'original-unknown':'legacy-selected-unknown'} x={x+barWidth/2} y="75" fill="#e5bf79" fontSize="13" textAnchor="middle">?</text>:<rect data-series={exact?'original':'legacy-selected'} data-value={originalValue!} data-denominator={originalDenominator} x={x} width={barWidth} y={80-originalHeight} height={originalHeight} fill="#83c9b1" fillOpacity={selected?'.35':'.75'}/>}
          {selected&&(selectedHeight===null?<text data-series="selected-unknown" x={x+barWidth/2} y="61" fill="#ff8199" fontSize="13" textAnchor="middle">?</text>:<g><rect data-series="selected" data-value={selectedValue!} data-denominator={selectedDenominator} x={x+barWidth*.18} width={barWidth*.64} y={80-selectedHeight} height={selectedHeight} fill="#ff4d6d" fillOpacity=".82"/><rect x={x+barWidth*.18} width={barWidth*.64} y={80-selectedHeight} height={selectedHeight} fill={`url(#${pattern})`}/></g>)}
          {labels&&<text x={x+barWidth/2} y="99" textAnchor="middle" fill="#b3c4c2" fontSize="9">{day.day.slice(5)}</text>}
          <title>{`${day.day}: ${exact?'original':'saved selection'} ${describe(originalValue,ratio)}, ${originalNumerator}/${originalDenominator} late/due shipments${selected?`; selected ${describe(selectedValue,ratio)}, ${selectedNumerator}/${selectedDenominator} late/due shipments`:''}`}</title>
        </g>;
      })}
    </svg>
    <small>{legend}{baseline?' Grey band: historical original.':''}{baseline&&selected?' Dashed line: historical selection.':''} ? = Unknown; no denominator.</small>
    {baseline?<small>Historical reference T {baseline.at} · original {reference(baseline,false,ratio)}{selected?` · selected ${reference(baseline,true,ratio)}`:''}</small>:<small>Historical reference unavailable in this saved edition.</small>}
  </>;
}
