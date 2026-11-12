import type {Snapshot,SnapshotOrder,Evidence,RecoveryBranch,TableRow} from '../domain/types';
import {evaluateBranches,GOODWILL_CURRENCY,recoveryPolicyUnavailable} from '../domain/policy';
import {COMMERCE_SEMANTICS} from '../domain/commerce-resources';
import type {InstrumentFormat,WidgetKind} from './types';

export interface NativeInstrumentRow {orderId:string;category:string|number|boolean|null;value:number|null;time:string|null}
export interface InstrumentInput {
  snapshot:Snapshot;format:InstrumentFormat;kind:WidgetKind;
  mapping:{orderId:string;category?:string;value?:string;time?:string};
  original:NativeInstrumentRow[];subset:NativeInstrumentRow[]|null;
}
export interface InstrumentRegionalStats {
  originalValue:number|null;selectedValue:number|null;originalOrderCount:number;selectedOrderCount:number;
  originalNumerator:number;originalDenominator:number;selectedNumerator:number;selectedDenominator:number;
}
export interface InstrumentRegionalDay extends Partial<InstrumentRegionalStats> {day:string;value:number|null;numerator:number;denominator:number}
export interface InstrumentGroup {key:string;label:string;value:number;selected:number;orderIds:string[];selectedOrderIds:string[];category:NativeInstrumentRow['category'];denominator?:number;numerator?:number;geoCode?:string|null;originalDenominator?:number;originalNumerator?:number;daily?:InstrumentRegionalDay[];baseline?:InstrumentRegionalStats&{at:string}}
export interface InstrumentResult {
  kind:WidgetKind;title:string;unit:string;scope:number;selected:number;highlighted:boolean;notes:string[];
  /** Captured presentation text is optional so earlier saved editions retain their exact PDF representation. */
  scopeLabel?:string;
  columns:string[];rows:Array<Record<string,string|number|null>>;groups:InstrumentGroup[];
  branches?:RecoveryBranch[];evidence?:Evidence[];orders:SnapshotOrder[];range?:{start:string;end:string};
  error?:string;
}
export function instrumentScopeLabel(model:Pick<InstrumentResult,'kind'|'scope'|'selected'>){
  const orders=(count:number)=>`${count} ${count===1?'order':'orders'}`;
  return model.kind==='time-dial'?`${orders(model.scope)} in clock scope. Shared selections do not filter the clock.`
    :`${orders(model.scope)} in original native scope · ${orders(model.selected)} in shared selection`;
}
const titles:Record<WidgetKind,string>={'commerce-river':'A business, in motion.','time-dial':'Rewind the evidence.','evidence-lens':'Follow the facts.','recovery-branches':'A measured response.','impact-map':'The pattern has a place.','deadline-strip':'Keep every case in view.'};
const states=['paymentState','fulfillmentState','remediationState','disputeState'];
const text=(value:unknown)=>value===null||value===undefined||value===''?'Unknown':String(value).replaceAll('_',' ');
const safeTotal=(rows:NativeInstrumentRow[])=>rows.reduce((sum,row)=>{if(row.value===null||!Number.isFinite(row.value)||row.value<0)throw new Error('Flow and map widths need a non-negative numeric measure. Use a native chart for signed values.');return sum+row.value;},0);
const ids=(rows:NativeInstrumentRow[])=>new Set(rows.map(row=>row.orderId));
const date=(value:string|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function rangeDate(value:string|undefined){if(!value)return null;if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('Range boundaries need valid ISO timestamps with an explicit UTC offset.');return new Date(value).toISOString();}
function validate(input:InstrumentInput){
  if(input.mapping.orderId!=='order_snapshot.id')throw new Error('Map order identity to order_snapshot.id. This instrument uses one authorized order per row.');
  const allowed=new Set(input.snapshot.orders.map(order=>order.id));
  for(const rows of [input.original,input.subset??[]]){
    if(new Set(rows.map(row=>row.orderId)).size!==rows.length)throw new Error('This mapping multiplies order rows. Choose fields at order grain; inspect resource tables separately.');
    if(rows.some(row=>!allowed.has(row.orderId)))throw new Error('The native result does not belong to the current authorized snapshot.');
  }
  const original=ids(input.original);if(input.subset?.some(row=>!original.has(row.orderId)))throw new Error('The shared highlight is outside the native result.');
  const {kind,format,mapping}=input;
  if(kind==='commerce-river'&&mapping.time&&mapping.time!=='transition_snapshot.transitionTime')throw new Error('River time must map to transition_snapshot.transitionTime. Other time mappings have no supported transition-clock adapter; use Time Dial for the shared T/K cutoffs.');
  for(const field of Object.values(input.mapping))if(field&&!field.startsWith('order_snapshot.')&&!(input.kind==='commerce-river'&&field==='transition_snapshot.transitionTime'))throw new Error('This instrument supports order-grain mappings. Use a native chart for resource-grain fields.');
  if(format.displayMode&&!(kind==='commerce-river'?['inventory','transitions']:kind==='impact-map'?['map','small-multiples']:[]).includes(format.displayMode))throw new Error('This display mode belongs to a different instrument. Choose a supported mode in this instrument’s form.');
  if(format.measure&&!(kind==='commerce-river'?['count','value']:kind==='impact-map'?['count','value','late-share']:[]).includes(format.measure))throw new Error('This instrument does not support that measure.');
  if(format.budgetMinor!==undefined&&kind!=='recovery-branches')throw new Error('The refund cap belongs to Recovery Branches.');
  if(mapping.time&&!['commerce-river','time-dial'].includes(kind))throw new Error('This instrument uses the shared T/K cutoffs; it has no independent time mapping.');
  const legacy:Partial<Record<WidgetKind,[string,string]>>={'evidence-lens':['paymentSource','supportContacts'],'recovery-branches':['seedGroup','refundableMinor'],'deadline-strip':['disputeState','amountMinor']};
  const legacySlots=legacy[kind];if(legacySlots&&(mapping.category&&mapping.category!=='order_snapshot.'+legacySlots[0]||mapping.value&&mapping.value!=='order_snapshot.'+legacySlots[1]))throw new Error('This instrument uses exact order identity and its domain controls. Arbitrary category/value mappings need a native chart.');
}
export function instrumentResult(input:InstrumentInput,observedNow=new Date().toISOString()):InstrumentResult{
  const {snapshot,format,kind}=input,selectedRows=input.subset??input.original,selectedIds=ids(selectedRows),allIds=ids(input.original);
  const result:InstrumentResult={kind,title:titles[kind],unit:'orders',scope:input.original.length,selected:selectedRows.length,highlighted:input.subset!==null,notes:[],columns:[],rows:[],groups:[],orders:snapshot.orders.filter(order=>selectedIds.has(order.id))};
  result.scopeLabel=instrumentScopeLabel(result);
  try{
    validate(input);
    if(kind==='commerce-river'){
      result.notes.push('Payment and fulfillment states summarize each order. Pending captures and queued shipments can remain unknown at order grain; proof retains their detailed resource states.');
      if(format.direction==='reverse')result.notes.push('Flow is drawn from destination to source. The table retains each transition’s actual time direction.');
      const money=format.measure==='value';result.unit=money?input.mapping.value?.endsWith('Minor')?`${snapshot.context.currency} minor units`:'mapped value':'orders';
      if(money&&!input.mapping.value)throw new Error('Choose a numeric mapping before showing a measured-value river.');
      if(format.displayMode==='transitions'){
        const field=input.mapping.category?.split('.').at(-1),dimension=field?.replace('State','');
        if(!field||!states.includes(field))throw new Error('Transition view needs a payment, fulfillment, remediation or dispute state grouping.');
        if(money&&input.mapping.value!=='order_snapshot.amountMinor')throw new Error('Transition money uses event amounts. Map Amount minor for this view; inventory supports other numeric mappings.');
        const end=rangeDate(format.rangeEnd)??new Date(Date.parse(snapshot.context.asOf)+1).toISOString();
        const visible=snapshot.tables.transition_snapshot.filter(row=>allIds.has(String(row.orderId))&&row.dimension===dimension);
        const start=rangeDate(format.rangeStart)??visible.reduce((min,row)=>String(row.transitionTime)<min?String(row.transitionTime):min,snapshot.context.asOf);
        if(start>=end)throw new Error('Choose a transition range whose start is earlier than its exclusive end.');
        result.range={start,end};result.unit=money?`${snapshot.context.currency} minor units`:'transitions';
        result.notes.push('Transitions in [start, end); each source transition is counted once. Order inventory and transition count are different measures.');
        const rows=visible.filter(row=>String(row.transitionTime)>=start&&String(row.transitionTime)<end);
        const keys=[...new Set(rows.map(row=>`${row.fromState} → ${row.toState}`))].sort();
        result.groups=keys.map(key=>{const group=rows.filter(row=>`${row.fromState} → ${row.toState}`===key),subset=group.filter(row=>selectedIds.has(String(row.orderId)));return {key,label:text(key),category:null,value:group.reduce((n,r)=>n+(money?Number(r.amountMinor):1),0),selected:subset.reduce((n,r)=>n+(money?Number(r.amountMinor):1),0),orderIds:[...new Set(group.map(row=>String(row.orderId)))],selectedOrderIds:[...new Set(subset.map(row=>String(row.orderId)))]};});
        result.columns=['Transition','Order','From','To','Event time','Amount minor','Currency','Source'];result.rows=rows.filter(row=>selectedIds.has(String(row.orderId))).map(row=>({'Transition':String(row.id),'Order':String(row.orderId),'From':String(row.fromState),'To':String(row.toState),'Event time':String(row.transitionTime),'Amount minor':Number(row.amountMinor),'Currency':snapshot.context.currency,'Source':String(row.sourceClass)}));
      }else{
        if(!input.mapping.category)throw new Error('Choose a grouping field for the river.');
        const keys=[...new Set(input.original.map(row=>JSON.stringify(row.category)))].sort();
        result.groups=keys.map(key=>{const group=input.original.filter(row=>JSON.stringify(row.category)===key),subset=group.filter(row=>selectedIds.has(row.orderId));return {key,label:text(group[0].category),category:group[0].category,value:money?safeTotal(group):group.length,selected:money?safeTotal(subset):subset.length,orderIds:group.map(row=>row.orderId),selectedOrderIds:subset.map(row=>row.orderId)};});
        result.columns=['Order','Grouping','Mapped value','Currency'];result.rows=selectedRows.map(row=>({'Order':row.orderId,'Grouping':text(row.category),'Mapped value':row.value,'Currency':snapshot.context.currency}));
        result.notes.push('Unique-order inventory at T. The highlight preserves the original denominator.');
      }
    }else if(kind==='time-dial'){
      if(format.timezone&&!['UTC','Asia/Kolkata','America/Los_Angeles'].includes(format.timezone))throw new Error('Choose one of the supported display timezones.');
      if(input.mapping.time&&!['order_snapshot.narrativeCreatedAt','order_snapshot.createdAt','order_snapshot.promisedAt','order_snapshot.providerOccurredAt'].includes(input.mapping.time))throw new Error('Choose an explicit order time field for the dial extent.');
      const times=input.original.map(row=>date(row.time??undefined)).filter((value):value is string=>Boolean(value)).sort();
      const start=rangeDate(format.rangeStart)??times[0]??snapshot.context.asOf,end=rangeDate(format.rangeEnd)??[times.at(-1)??snapshot.context.asOf,snapshot.context.asOf].sort().at(-1)!;
      if(start>end)throw new Error('The dial start must precede its end.');result.range={start,end};
      result.columns=['Event cutoff T','Knowledge cutoff K','Clock','Display timezone','Orders'];result.rows=[{'Event cutoff T':snapshot.context.asOf,'Knowledge cutoff K':snapshot.context.knownAt,'Clock':snapshot.context.clockDomain,'Display timezone':format.timezone??'UTC','Orders':result.scope}];
      result.notes.push('Apply reconstructs all sources together. Display timezone does not change either stored cutoff.');
    }else if(kind==='evidence-lens'){
      const chosen=snapshot.evidence.filter(row=>(row.orderId?selectedIds.has(row.orderId):selectedRows.length>0)&&(format.showContradictions!==false||row.kind!=='contradiction')&&(!format.evidenceKind||format.evidenceKind==='all'||row.kind===format.evidenceKind)&&(!format.evidenceSource||format.evidenceSource==='all'||row.sourceClass===format.evidenceSource));
      const sorted=chosen.slice().sort((a,b)=>format.evidenceOrder==='oldest'?a.ingestedAt.localeCompare(b.ingestedAt):format.evidenceOrder==='kind'?a.kind.localeCompare(b.kind)||b.ingestedAt.localeCompare(a.ingestedAt):b.ingestedAt.localeCompare(a.ingestedAt)||a.id.localeCompare(b.id));
      result.evidence=sorted.map(row=>format.redactExcerpts?{...row,excerpt:'Excerpt hidden in this view.'}:row);result.unit='evidence records';
      result.columns=['Evidence','Order','Kind','Source','Event time','Known at','Excerpt','Supports','Contradicts'];result.rows=result.evidence.map(row=>({'Evidence':row.id,'Order':row.orderId??'Cohort source','Kind':row.kind,'Source':row.sourceClass,'Event time':row.occurredAt,'Known at':row.ingestedAt,'Excerpt':row.excerpt,'Supports':row.supports.join(', '),'Contradicts':row.contradicts.join(', ')}));
      result.notes.push(`Cohort v${snapshot.context.cohortVersion}; source knowledge through ${snapshot.context.knownAt}. Quoted text never grants authority.`);
    }else if(kind==='recovery-branches'){
      const budget=format.budgetMinor??30_000;if(!Number.isSafeInteger(budget)||budget<0||budget>100_000)throw new Error('Refund cap must be a whole-cent amount from $0 to $1,000 USD.');
      result.branches=evaluateBranches(result.orders,budget,snapshot.hash).filter(branch=>!format.gracePolicy||format.gracePolicy==='compare'||branch.id===format.gracePolicy);for(const branch of result.branches)branch.currency=GOODWILL_CURRENCY;
      result.unit=`${GOODWILL_CURRENCY} minor units`;result.columns=['Branch','Order','Eligible','Undelivered','Grace passed','No open dispute','No earlier remedy','Sufficient balance','Exclusions','Refund minor','Cap minor','Policy currency','Report denomination','Within cap'];
      result.rows=result.branches.flatMap(branch=>branch.rows.filter(row=>format.showBlocked!==false||row.eligible).map(row=>({'Branch':branch.name,'Order':row.orderId,'Eligible':row.eligible?'Yes':'No','Undelivered':row.conditions.find(condition=>condition.key==='undelivered')?.passed?'Yes':'No','Grace passed':row.conditions.find(condition=>condition.key==='grace')?.passed?'Yes':'No','No open dispute':row.conditions.find(condition=>condition.key==='dispute')?.passed?'Yes':'No','No earlier remedy':row.conditions.find(condition=>condition.key==='prior_remedy')?.passed?'Yes':'No','Sufficient balance':row.conditions.find(condition=>condition.key==='balance')?.passed?'Yes':'No','Exclusions':row.excludedReasons.join(', ')||'None','Refund minor':row.eligible?branch.amountMinor:0,'Cap minor':branch.budgetMinor,'Policy currency':GOODWILL_CURRENCY,'Report denomination':snapshot.context.currency,'Within cap':recoveryPolicyUnavailable(branch,snapshot.context.currency)?'Not applicable':branch.withinBudget?'Yes':'No'})));
      const first=result.branches[0];if(first)result.groups=['undelivered','grace','dispute','prior_remedy','balance'].map(key=>{const excluded=first.rows.filter(row=>row.excludedReasons.includes(key as never)).map(row=>row.orderId);return {key,label:({undelivered:'delivered or unknown shipment',grace:'inside grace or missing promise',dispute:'open or unknown dispute',prior_remedy:'prior or unknown remedy',balance:'insufficient balance or unsupported currency'} as Record<string,string>)[key],category:null,value:excluded.length,selected:excluded.length,orderIds:excluded,selectedOrderIds:excluded};});
      if(format.showBlocked===false)result.notes.push('The condition table shows eligible orders only. Costs and exclusion selections retain the complete native cohort.');
      result.notes.push(snapshot.context.currency===GOODWILL_CURRENCY?'Goodwill amounts and the cap are denominated in USD.':`USD goodwill unavailable for ${snapshot.context.currency}. The USD cap does not authorize a ${snapshot.context.currency} refund. Tracking and dispute proposals keep their own requirements; no currency conversion is applied.`);
      result.notes.push('The cap accepts or blocks the complete eligible cohort; it never silently drops eligible orders. Comprehensive has no grace window and needs its own approval.');
    }else if(kind==='impact-map'){
      if(!['order_snapshot.regionCode','order_snapshot.region'].includes(input.mapping.category??''))throw new Error('Map grouping must be order region or region code. Other categories belong in the river or a native chart.');
      const metric=format.measure??'count';result.unit=metric==='late-share'?'late / due shipments':metric==='value'?input.mapping.value?.endsWith('Minor')?`${snapshot.context.currency} minor units`:'mapped value':'orders';
      const currentSemantics=snapshot.context.semanticModelVersion===COMMERCE_SEMANTICS;
      const regionalRows=snapshot.tables.regional_order_snapshot??[],baselineRows=snapshot.tables.regional_baseline_order_snapshot;
      if(currentSemantics&&!baselineRows)throw new Error('This snapshot is missing its admitted order-grain regional baseline. Reconstruct the complete snapshot before comparing regions.');
      const baselineTimes=currentSemantics?[...new Set([...(baselineRows??[]),...snapshot.tables.regional_snapshot].map(row=>row.baselineAt).filter((at):at is string=>typeof at==='string'))]:[];
      if(currentSemantics&&(baselineTimes.length!==1||!date(baselineTimes[0]))&&input.original.length)throw new Error('This snapshot has no single admitted regional baseline time. Reconstruct the complete snapshot before comparing regions.');
      const regionalStats=(original:TableRow[]):InstrumentRegionalStats=>{
        const selected=original.filter(row=>selectedIds.has(String(row.orderId)));
        const counts=(rows:TableRow[])=>({orders:new Set(rows.map(row=>String(row.orderId))).size,n:rows.reduce((n,row)=>n+Number(row.lateCount),0),d:rows.reduce((n,row)=>n+Number(row.eligibleShipmentCount),0)});
        const originalCounts=counts(original),selectedCounts=counts(selected);
        const value=(totals:ReturnType<typeof counts>)=>metric==='late-share'?(totals.d?totals.n/totals.d:null):metric==='value'?null:totals.orders;
        return {originalValue:value(originalCounts),selectedValue:value(selectedCounts),originalOrderCount:originalCounts.orders,selectedOrderCount:selectedCounts.orders,originalNumerator:originalCounts.n,originalDenominator:originalCounts.d,selectedNumerator:selectedCounts.n,selectedDenominator:selectedCounts.d};
      };
      const keyFor=(value:NativeInstrumentRow['category'])=>value===null||value===''?'UNKNOWN':JSON.stringify(value);
      const keys=[...new Set(input.original.map(row=>keyFor(row.category)))].sort();
      const orderById=new Map(snapshot.orders.map(order=>[order.id,order]));
      result.groups=keys.map(key=>{
        const nativeRows=input.original.filter(row=>keyFor(row.category)===key),group=nativeRows.map(row=>orderById.get(row.orderId)!),selected=group.filter(order=>selectedIds.has(order.id)),groupIds=new Set(group.map(order=>order.id));
        const due=(rows:SnapshotOrder[])=>rows.reduce((n,order)=>n+(order.dueShipmentCount??Number(Number.isFinite(Date.parse(order.promisedAt))&&order.promisedAt<=snapshot.context.asOf&&order.fulfillmentState!=='unknown')),0);
        const numerator=(rows:SnapshotOrder[])=>rows.reduce((n,order)=>n+(order.lateShipmentCount??Number(Number.isFinite(Date.parse(order.promisedAt))&&order.promisedAt<=snapshot.context.asOf&&['delayed','in_transit','shipped'].includes(order.fulfillmentState))),0);
        const value=(rows:SnapshotOrder[])=>metric==='value'?safeTotal(nativeRows.filter(row=>rows.some(order=>order.id===row.orderId))):metric==='late-share'?(due(rows)?numerator(rows)/due(rows):0):rows.length;
        const dailyRows=regionalRows.filter(row=>groupIds.has(String(row.orderId)));
        const days=[...new Set((currentSemantics?regionalRows:dailyRows).map(row=>String(row.day)))].sort();
        const daily:InstrumentRegionalDay[]=days.map(day=>{
          const original=dailyRows.filter(row=>row.day===day),selected=original.filter(row=>selectedIds.has(String(row.orderId))),n=selected.reduce((n,row)=>n+Number(row.lateCount),0),d=selected.reduce((n,row)=>n+Number(row.eligibleShipmentCount),0);
          return {day,value:metric==='late-share'?(d?n/d:null):metric==='value'?null:selected.length,numerator:n,denominator:d,...currentSemantics?regionalStats(original):{}};
        });
        const baseline=currentSemantics?{at:baselineTimes[0],...regionalStats(baselineRows!.filter(row=>groupIds.has(String(row.orderId))))}:undefined;
        const codes=[...new Set(group.map(order=>order.regionCode).filter(Boolean))],geoCode=codes.length===1?codes[0]:null;
        const label=key==='UNKNOWN'?'Unknown region':input.mapping.category?.endsWith('.regionCode')?group[0].region||String(nativeRows[0].category):String(nativeRows[0].category);
        return {key:input.mapping.category?.endsWith('.regionCode')?String(nativeRows[0].category||'UNKNOWN'):key,label,category:nativeRows[0].category,geoCode,value:value(group),selected:value(selected),orderIds:group.map(o=>o.id),selectedOrderIds:selected.map(o=>o.id),numerator:numerator(selected),denominator:due(selected),originalNumerator:numerator(group),originalDenominator:due(group),daily,...baseline?{baseline}:{}};
      });
      const geographicCounts=new Map<string,number>();for(const group of result.groups)if(group.geoCode)geographicCounts.set(group.geoCode,(geographicCounts.get(group.geoCode)??0)+1);for(const group of result.groups)if(group.geoCode&&(geographicCounts.get(group.geoCode)??0)>1)group.geoCode=null;
      if(format.displayMode==='small-multiples'&&metric==='value')throw new Error('Daily mapped money is not an inventory history. Choose count or late share for regional small multiples.');
      if(format.displayMode==='small-multiples'&&!snapshot.tables.regional_order_snapshot)throw new Error('This legacy snapshot has no order-grain regional history. Reconstruct with current semantics to compare filtered days.');
      if(currentSemantics){
        result.columns=['Region','Period','Time','Original value','Selected value','Original orders','Selected orders','Original late','Original due','Selected late','Selected due'];
        const statsRow=(group:InstrumentGroup,period:string,at:string,stats:InstrumentRegionalStats)=>({'Region':group.label,'Period':period,'Time':at,'Original value':stats.originalValue,'Selected value':stats.selectedValue,'Original orders':stats.originalOrderCount,'Selected orders':stats.selectedOrderCount,'Original late':stats.originalNumerator,'Original due':stats.originalDenominator,'Selected late':stats.selectedNumerator,'Selected due':stats.selectedDenominator});
        result.rows=result.groups.flatMap(group=>{
          const current:InstrumentRegionalStats={originalValue:metric==='late-share'&&!group.originalDenominator?null:group.value,selectedValue:metric==='late-share'&&!group.denominator?null:group.selected,originalOrderCount:group.orderIds.length,selectedOrderCount:group.selectedOrderIds.length,originalNumerator:group.originalNumerator??0,originalDenominator:group.originalDenominator??0,selectedNumerator:group.numerator??0,selectedDenominator:group.denominator??0};
          const rows:Array<Record<string,string|number|null>>=format.displayMode==='small-multiples'?(group.daily??[]).map(day=>statsRow(group,'Daily',day.day,day as InstrumentRegionalDay&InstrumentRegionalStats)):[{...statsRow(group,'Current',snapshot.context.asOf,current),'Original':current.originalValue,'Selected':current.selectedValue,'Late':current.selectedNumerator,'Due':current.selectedDenominator}];
          if(group.baseline)rows.push(statsRow(group,'Historical baseline',group.baseline.at,group.baseline));return rows;
        });
        if(result.groups.length)result.notes.push(`Historical reference at ${baselineTimes[0]} uses the same native order cohorts, knowledge cutoff and denomination. The band is a reference inventory with explicit counts and denominators; it carries no statistical uncertainty estimate.`);
      }else{
        result.columns=format.displayMode==='small-multiples'?['Region','Day','Value','Late','Due']:['Region','Original','Selected','Late','Due'];
        result.rows=result.groups.flatMap<Record<string,string|number|null>>(group=>format.displayMode==='small-multiples'?(group.daily??[]).map(day=>({'Region':group.label,'Day':day.day,'Value':day.value,'Late':day.numerator,'Due':day.denominator})):[{'Region':group.label,'Original':metric==='late-share'&&!group.originalDenominator?null:group.value,'Selected':metric==='late-share'&&!group.denominator?null:group.selected,'Late':group.numerator??0,'Due':group.denominator??0}]);
      }
      result.notes.push(metric==='late-share'?'Shared scale 0–100%. Each distinct due shipment is counted once, including partial deliveries. No due shipments means unknown, never 0% late.':'All regions share one scale. Unknown destinations are included explicitly.');
    }else{
      const now=Date.parse(observedNow);result.unit='cases';result.columns=['Order','State','Owner','Deadline','Clock','Remaining seconds','Source'];
      const admittedDeadlines=new Map(snapshot.tables.deadline_snapshot.map(row=>[String(row.orderId),row]));
      result.rows=result.orders.filter(order=>order.disputeState&&!['none','unknown'].includes(order.disputeState)).map(order=>{
        const admitted=admittedDeadlines.get(order.id),state=typeof admitted?.state==='string'?admitted.state:order.disputeState??'Unknown',closed=['resolved','closed','cancelled'].includes(state);
        const dueAt=admitted?(typeof admitted.dueAt==='string'?admitted.dueAt:null):order.disputeDueAt,source=typeof admitted?.sourceClass==='string'?admitted.sourceClass:order.disputeSource;
        const verified=source==='sandbox'&&dueAt!==null&&Number.isFinite(Date.parse(dueAt))&&(!admitted||admitted.dueDateVerified===true);
        // V2/v3 materialize ownership independently from the presentation clock.
        // Older v1 rows have no owner column and retain their original inference.
        const owner=typeof admitted?.owner==='string'?admitted.owner:closed?'none':state==='waiting_for_buyer_response'?'buyer':state==='under_review'?'provider':verified?'merchant':'unknown';
        return {'Order':order.id,'State':state,'Owner':owner,'Deadline':verified?dueAt:null,'Clock':verified?'observed UTC':'unknown','Remaining seconds':verified&&!closed&&owner==='merchant'?Math.floor((Date.parse(dueAt!)-now)/1000):null,'Source':source};
      })
        .filter(row=>(!format.deadlineState||format.deadlineState==='all'||row.State===format.deadlineState)&&(!format.deadlineOwner||format.deadlineOwner==='all'||row.Owner===format.deadlineOwner)&&(format.showUnknown!==false||row.Deadline!==null));
      const references=new Map(result.orders.map(order=>[order.id,order.reference]));
      result.rows.sort((a,b)=>format.deadlineSort==='reference'?(references.get(String(a.Order))??String(a.Order)).localeCompare(references.get(String(b.Order))??String(b.Order)):a.Deadline===null?b.Deadline===null?String(a.Order).localeCompare(String(b.Order)):1:b.Deadline===null?-1:String(a.Deadline).localeCompare(String(b.Deadline))*(format.deadlineSort==='latest'?-1:1));
      result.notes.push(`Countdowns use the observed clock at ${observedNow}; T/K controls source visibility. Refund, submitted evidence and resolution remain separate facts.`);
    }
  }catch(error){result.error=error instanceof Error?error.message:'The current mapping cannot be represented.';result.rows=[];result.groups=[];}
  return result;
}

export function normalizeInstrumentRows(rows:Record<string,unknown>[],keys:{orderId:string;category?:string;value?:string;time?:string}):NativeInstrumentRow[]{return rows.map(row=>({orderId:String(row[keys.orderId]),category:keys.category?(row[keys.category]??null) as NativeInstrumentRow['category']:null,value:keys.value&&typeof row[keys.value]==='number'?row[keys.value] as number:null,time:keys.time&&row[keys.time]!=null?String(row[keys.time]):null}));}
