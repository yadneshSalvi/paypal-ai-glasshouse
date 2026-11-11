import {createWidgets} from 'ag-studio-react';
import {studioTheme,type AgStudioApi,type AgReportState,type AgDataSourcesDefinition,type AgFieldDefinition} from 'ag-studio';
import type {Snapshot} from '../domain/types';
import type {GlasshouseRegistry,InstrumentDefinition,WidgetKind} from './types';
import {CommerceRiver,TimeDial,EvidenceLens,RecoveryBranches,ImpactMap,DeadlineStrip} from './widgets';
import {instrumentMinimumHeight} from './layout';

const def=(id:WidgetKind,label:string,comp:InstrumentDefinition['comp'],category:string,highlight=false):InstrumentDefinition=>({
  id,label,comp,
  dataMapping:{
    orderId:{type:'field',supportedRoles:['category'],required:true,requires:{cardinality:'many'},aiDescription:'Stable order identity. One row per order; never aggregate monetary values across a fanout.'},
    category:{type:'field',supportedRoles:['category'],required:false,aiDescription:category},
    value:{type:'field',supportedRoles:['numeric'],required:false,aiDescription:'Exact integer minor-unit amount, or an order-level measured value.'},
    time:{type:'field',supportedRoles:['temporal'],required:false,aiDescription:'Explicit narrative timestamp for Story clock. Provider timestamps remain separate.'},
    snapshot:{type:'field',supportedRoles:['category'],required:false,aiDescription:'Snapshot hash for the atomic render barrier. Keep mapped to order_snapshot.snapshotHash.'},
  },
  formatShape:({api})=>(api as AgStudioApi).defineAiCommand(s=>({
    input:s.object({
      title:s.object({enabled:s.boolean().optional(),text:s.string().optional()}).optional(),
      subtitle:s.object({enabled:s.boolean().optional(),text:s.string().optional()}).optional(),
      caption:s.object({enabled:s.boolean().optional(),text:s.string().optional()}).optional(),
      crossFilter:s.enum(['filter','highlight','none']).optional(),triggerCrossFilter:s.boolean().optional(),
      displayMode:s.enum(['map','small-multiples','inventory','transitions']).optional(),
      showLabels:s.boolean().optional(),showTable:s.boolean().optional(),budgetMinor:s.number().optional(),showContradictions:s.boolean().optional(),
    }),execute:args=>({success:true as const,value:args}),
  })).shape,
  form:p=>{
    const f=p.createDefaults({supportsCrossHighlight:highlight,supportsTriggerCrossFilter:id!=='time-dial',dataMappingItems:[{key:'orderId',label:'Order identity'},{key:'category',label:'Grouping / selection'},{key:'value',label:'Measured value'},{key:'time',label:'Event time'}]});
    f.items[1].items.push({type:'checkbox',id:'format.showLabels',label:'Show precise labels',defaultValue:true},{type:'checkbox',id:'format.showTable',label:'Show accessible data table',defaultValue:false});
    if(id==='impact-map') f.items[1].items.push({type:'select',id:'format.displayMode',label:'Regional view',defaultValue:'map',items:[{label:'Schematic map',value:'map'},{label:'Regional small multiples',value:'small-multiples'}]});
    if(id==='evidence-lens') f.items[1].items.push({type:'checkbox',id:'format.showContradictions',label:'Include contradicting evidence',defaultValue:true});
    if(id==='recovery-branches') f.items[1].items.push({type:'number',id:'format.budgetMinor',label:'Refund cap (USD cents)',defaultValue:30000,min:0,max:100000,step:500});
    return f;
  },
  defaultState:{format:{title:{enabled:false},crossFilter:id==='time-dial'?'none':highlight?'highlight':'filter',triggerCrossFilter:id!=='time-dial',showLabels:true,showTable:false}},
  defaultSize:{width:560,height:instrumentMinimumHeight[id]},minSize:{width:280,height:instrumentMinimumHeight[id]},
  featureConfig:{crossFilter:{supportsHighlight:highlight}},
  ai:{description:label,usage:({
    'commerce-river':'Show the whole business and selected cohort as dye while preserving its denominator. Inventory-at-T counts unique orders; transition count is separate.',
    'time-dial':'Reconstruct every view at a single exact time and knowledge cutoff. Changing this control invokes a complete server snapshot.',
    'evidence-lens':'Inspect cited source excerpts, contradictions, ingestion times and finding revisions for the shared cohort.',
    'recovery-branches':'Compare deterministic goodwill-delay-v1 eligibility and exact costs, with explicit policy exclusions and a human approval path.',
    'impact-map':'Locate the shared cohort using coarse region denominators, or compare regional small multiples on a common scale.',
    'deadline-strip':'Inspect current dispute state and genuine provider deadlines; unknown deadlines remain unknown.',
  })[id],configuration:'Map orderId to order_snapshot.id. Use shared order_snapshot fields so all widgets share cohort selection. Preserve source labels and snapshot scope.'},
});
export const definitions:InstrumentDefinition[]=[
  def('commerce-river','Commerce River',CommerceRiver,'Fulfillment state',true),
  def('time-dial','Time Dial',TimeDial,'Clock domain'),
  def('evidence-lens','Evidence Lens',EvidenceLens,'Source provenance'),
  def('recovery-branches','Recovery Branches',RecoveryBranches,'Eligibility group'),
  def('impact-map','Impact Map',ImpactMap,'Coarse region code',true),
  def('deadline-strip','Deadline Strip',DeadlineStrip,'Dispute state'),
];
export const widgets=createWidgets<GlasshouseRegistry>({additionalTypes:definitions,menu:[{label:'Glasshouse instruments',widgetIds:definitions.map(d=>d.id)},{label:'Inspect and compare',widgetIds:['grid','line-chart','column-chart-grouped','value','text']}]});
const mapping=(category:string,value='amountMinor')=>({orderId:[{id:'order_snapshot.id'}],snapshot:[{id:'order_snapshot.snapshotHash'}],category:[{id:'order_snapshot.'+category}],value:[{id:'order_snapshot.'+value,aggregation:'sum' as const}]});
export const initialState:AgReportState<GlasshouseRegistry>={
  pages:[{id:'incident-room',layout:{type:'widget',minWidth:320,columns:24,rowHeight:16,pagePadding:0,widgetPadding:0,widgetBackgroundColor:'#111c23',widgetBorderEnabled:true,widgetBorderColor:'#2b3941',widgetBorderWidth:1,widgetBorderRadius:12,backgroundColor:'#0b151b'},
    widgets:{
      river:{type:'commerce-river',dataMapping:mapping('fulfillmentState'),format:{crossFilter:'highlight',title:{enabled:false}}},
      dial:{type:'time-dial',dataMapping:{orderId:[{id:'order_snapshot.id'}],snapshot:[{id:'order_snapshot.snapshotHash'}],time:[{id:'order_snapshot.narrativeCreatedAt'}]},format:{title:{enabled:false},crossFilter:'none'}},
      evidence:{type:'evidence-lens',dataMapping:mapping('paymentSource','supportContacts'),format:{title:{enabled:false},showContradictions:true}},
      branches:{type:'recovery-branches',dataMapping:mapping('seedGroup','refundableMinor'),format:{title:{enabled:false},budgetMinor:30000}},
      map:{type:'impact-map',dataMapping:mapping('regionCode'),format:{title:{enabled:false},crossFilter:'highlight',displayMode:'map'}},
      deadlines:{type:'deadline-strip',dataMapping:mapping('disputeState'),format:{title:{enabled:false}}},
      records:{type:'grid',dataMapping:{cols:[{id:'order_snapshot.reference'},{id:'order_snapshot.region'},{id:'order_snapshot.fulfillmentState'},{id:'order_snapshot.amountMinor',aggregation:'sum'},{id:'order_snapshot.paymentSource'}]},format:{title:{enabled:true,text:'The records behind the river'},crossFilter:'filter'}},
    },
    widgetLayout:{river:{xTrack:0,yTrack:0,xSpan:17,ySpan:26},dial:{xTrack:17,yTrack:0,xSpan:7,ySpan:26},evidence:{xTrack:0,yTrack:26,xSpan:8,ySpan:31},branches:{xTrack:8,yTrack:26,xSpan:9,ySpan:31},map:{xTrack:17,yTrack:26,xSpan:7,ySpan:31},deadlines:{xTrack:0,yTrack:57,xSpan:24,ySpan:15},records:{xTrack:0,yTrack:72,xSpan:24,ySpan:24}},
  }],selectedPageId:'incident-room',panels:{data:{collapsed:true},edit:{collapsed:true},filters:{collapsed:true},ai:{collapsed:true}},
};

export function studioData(snapshot:Snapshot):AgDataSourcesDefinition<GlasshouseRegistry>{
  return {
    description:'Fernwood commerce history. Every table belongs to one immutable T/K snapshot. Monetary amounts are integer minor units. Sample payment rows have no provider capture ID. Fixture shipping is independent from provider payment state. One order_snapshot row per unique order; other tables have their own grain.',
    sources:Object.entries(snapshot.tables).map(([id,data])=>({id,name:id.replace('_snapshot','').replace(/^./,s=>s.toUpperCase()),transactions:'all' as const,primaryKeyField:'id',data,
      fields:fieldsFor(id,data),
    })),
    relationships:['transition_snapshot','finding_snapshot','action_snapshot','deadline_snapshot'].filter(id=>snapshot.tables[id as keyof Snapshot['tables']].some(r=>r.orderId)).map(id=>({id:'orders-'+id,type:'one-to-many' as const,source:'order_snapshot.id',target:id+'.orderId'})),
    options:{fanout:{warning:true,execute:'prevent'}},
  };
}
function fieldsFor(id:string,rows:Snapshot['tables']['order_snapshot']):AgFieldDefinition<GlasshouseRegistry>[]|undefined{
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  if(id==='order_snapshot') for(const k of ['id','reference','region','regionCode','fulfillmentState','paymentState','remediationState','amountMinor','refundableMinor','paymentSource','seedGroup','supportContacts','narrativeCreatedAt','disputeState','snapshotHash'])if(!keys.includes(k))keys.push(k);
  if(!keys.length)keys.push('id','orderId','snapshotHash');
  return keys.map(key=>{
    const value=rows.find(r=>r[key]!==null&&r[key]!==undefined)?.[key];
    const numeric=typeof value==='number'||/Minor$|Count$|Hours$|Contacts$/.test(key);
    const temporal=/At$|Time$|From$|To$/.test(key)&&key!=='state';
    return {id:key,name:key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,s=>s.toUpperCase()),format:temporal?'dateTimeFormat':numeric?'integerFormat':typeof value==='boolean'?'booleanFormat':'textFormat',hide:['snapshotHash','contextHash','tenantId'].includes(key),
      ...(key==='amountMinor'?{name:'Order amount (cents)',description:'Integer cents. Divide by 100 for USD display.'}:{}),
    } as AgFieldDefinition<GlasshouseRegistry>;
  });
}
export const instrumentTheme=studioTheme.withParams({
  fontFamily:'var(--font-inter), Inter, Arial, sans-serif',fontSize:13,textColor:'#dce5e8',backgroundColor:'#111c23',borderColor:'#2c3b43',accentColor:'#b6d4be',
  studioMinWidth:0,studioMinHeight:300,studioCanvasMinWidth:320,studioCanvasPadding:0,studioCanvasBackgroundColor:'#0b151b',
  studioWrapperBorder:{width:0},studioWrapperBackgroundColor:'#0b151b',studioWrapperSpacing:0,studioPanelContainerBackgroundColor:'#111c23',studioPanelHeaderFontSize:14,
  studioWidgetBackgroundColor:'#111c23',studioWidgetBorder:{width:1,color:'#2b3941'},studioWidgetBorderRadius:12,studioWidgetPadding:0,
  studioWidgetTitleFontFamily:'var(--font-inter), Inter, Arial, sans-serif',studioWidgetTitleFontSize:20,studioWidgetTitleTextColor:'#e7ece9',
  gridRowHeight:46,gridHeaderBackgroundColor:'#17252d',gridDataBackgroundColor:'#111c23',gridOddRowBackgroundColor:'#14212a',
  chartTextColor:'#dce5e8',chartSubtleTextColor:'#8da5ad',chartGridLineColor:'#2c3b43',chartPaletteFills1Color:'#87b9ac',chartPaletteFills2Color:'#ee897c',chartPaletteFills3Color:'#e5b77d',
});
