import {createWidgets} from 'ag-studio-react';
import {studioTheme,type AgStudioApi,type AgReportState,type AgDataSourcesDefinition,type AgFieldDefinition} from 'ag-studio';
import type {Snapshot} from '../domain/types';
import type {GlasshouseRegistry,InstrumentDefinition,WidgetKind} from './types';
import {CommerceRiver,TimeDial,EvidenceLens,RecoveryBranches,ImpactMap,DeadlineStrip} from './widgets';
import {instrumentMinimumHeight} from './layout';
import {instrumentCrossFilter} from './widget-metadata';

const def=(id:WidgetKind,label:string,comp:InstrumentDefinition['comp'],category:string):InstrumentDefinition=>({
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
      measure:s.enum(['count','value','late-share']).optional(),rangeStart:s.string().optional(),rangeEnd:s.string().optional(),
      playbackStepMinutes:s.number().optional(),direction:s.enum(['forward','reverse']).optional(),showMotion:s.boolean().optional(),showBlocked:s.boolean().optional(),
      timezone:s.enum(['UTC','Asia/Kolkata','America/Los_Angeles']).optional(),
      evidenceKind:s.string().optional(),evidenceSource:s.string().optional(),redactExcerpts:s.boolean().optional(),evidenceOrder:s.enum(['freshest','oldest','kind']).optional(),
      gracePolicy:s.enum(['compare','targeted','comprehensive']).optional(),deadlineState:s.string().optional(),deadlineOwner:s.enum(['all','merchant','buyer','provider','none','unknown']).optional(),deadlineSort:s.enum(['soonest','latest','reference']).optional(),showUnknown:s.boolean().optional(),
    }),execute:args=>({success:true as const,value:args}),
  })).shape,
  form:p=>{
    const dataMappingItems:{key:'orderId'|'category'|'value'|'time';label:string}[]=[{key:'orderId',label:'Order identity'}];
    if(id==='commerce-river'||id==='impact-map')dataMappingItems.push({key:'category',label:'Grouping / selection'},{key:'value',label:'Measured order value'});
    if(id==='commerce-river')dataMappingItems.push({key:'time',label:'Transition time for shared range selection'});
    if(id==='time-dial')dataMappingItems.push({key:'time',label:'Time field for dial extent'});
    const f=p.createDefaults({supportsCrossHighlight:instrumentCrossFilter[id].supportsHighlight,supportsTriggerCrossFilter:id!=='time-dial',dataMappingItems});
    if(id==='time-dial')f.items[0].items=f.items[0].items.filter(item=>item.type!=='section'||item.key!=='crossFilter');
    f.items[1].items.push({type:'checkbox',id:'format.showLabels',label:'Show precise labels',defaultValue:true},{type:'checkbox',id:'format.showTable',label:'Show accessible data table',defaultValue:false});
    if(id==='commerce-river')f.items[1].items.push({type:'select',id:'format.displayMode',label:'River grain',defaultValue:'inventory',items:[{label:'Unique-order inventory at T',value:'inventory'},{label:'Transitions in a time range',value:'transitions'}]},{type:'select',id:'format.measure',label:'River width',defaultValue:'count',items:[{label:'Count at the selected grain',value:'count'},{label:'Mapped value / event amount',value:'value'}]},{type:'textfield',id:'format.rangeStart',label:'Transition range start (ISO UTC)'},{type:'textfield',id:'format.rangeEnd',label:'Transition range end, exclusive (ISO UTC)'},{type:'select',id:'format.direction',label:'Flow direction',defaultValue:'forward',items:[{label:'Source to destination',value:'forward'},{label:'Destination to source',value:'reverse'}]},{type:'checkbox',id:'format.showMotion',label:'Show bounded transition samples',defaultValue:true});
    if(id==='time-dial')f.items[1].items.push({type:'select',id:'format.timezone',label:'Timestamp display',defaultValue:'UTC',items:['UTC','Asia/Kolkata','America/Los_Angeles'].map(value=>({label:value,value}))},{type:'textfield',id:'format.rangeStart',label:'Dial extent start (ISO UTC)'},{type:'textfield',id:'format.rangeEnd',label:'Dial extent end (ISO UTC)'},{type:'number',id:'format.playbackStepMinutes',label:'Replay step (minutes)',defaultValue:60,min:1,max:1440,step:1});
    if(id==='impact-map') f.items[1].items.push({type:'select',id:'format.displayMode',label:'Regional view',defaultValue:'map',items:[{label:'Schematic map',value:'map'},{label:'Regional small multiples',value:'small-multiples'}]});
    if(id==='impact-map')f.items[1].items.push({type:'select',id:'format.measure',label:'Regional measure',defaultValue:'count',items:[{label:'Order count',value:'count'},{label:'Late share among due shipments',value:'late-share'},{label:'Mapped order value (map only)',value:'value'}]});
    if(id==='evidence-lens') f.items[1].items.push({type:'checkbox',id:'format.showContradictions',label:'Include contradicting evidence',defaultValue:true});
    if(id==='evidence-lens')f.items[1].items.push({type:'select',id:'format.evidenceKind',label:'Evidence type',defaultValue:'all',items:['all','shipment','payment','support','finding','contradiction','policy','dispute'].map(value=>({label:value,value}))},{type:'select',id:'format.evidenceSource',label:'Source class',defaultValue:'all',items:['all','sample','fixture_shipping','fixture_support','sandbox','replay','modelled'].map(value=>({label:value.replaceAll('_',' '),value}))},{type:'checkbox',id:'format.redactExcerpts',label:'Hide excerpts in presentation; JSON retains sources',defaultValue:false},{type:'select',id:'format.evidenceOrder',label:'Source ordering',defaultValue:'freshest',items:[{label:'Freshest knowledge first',value:'freshest'},{label:'Oldest knowledge first',value:'oldest'},{label:'By evidence type',value:'kind'}]});
    if(id==='recovery-branches') f.items[1].items.push({type:'number',id:'format.budgetMinor',label:'Refund cap (USD cents)',defaultValue:30000,min:0,max:100000,step:500});
    if(id==='recovery-branches')f.items[1].items.push({type:'select',id:'format.gracePolicy',label:'Grace policy comparison',defaultValue:'compare',items:[{label:'Compare both policies',value:'compare'},{label:'48-hour grace',value:'targeted'},{label:'No grace window',value:'comprehensive'}]},{type:'checkbox',id:'format.showBlocked',label:'Include excluded orders in the table',defaultValue:true});
    if(id==='deadline-strip')f.items[1].items.push({type:'select',id:'format.deadlineState',label:'Case state',defaultValue:'all',items:['all','open','under_review','waiting_for_buyer_response','waiting_for_seller_response','resolved','closed'].map(value=>({label:value.replaceAll('_',' '),value}))},{type:'select',id:'format.deadlineOwner',label:'Next response owner',defaultValue:'all',items:['all','merchant','buyer','provider','none','unknown'].map(value=>({label:value,value}))},{type:'select',id:'format.deadlineSort',label:'Case ordering',defaultValue:'soonest',items:[{label:'Soonest deadline',value:'soonest'},{label:'Latest deadline',value:'latest'},{label:'Order reference',value:'reference'}]},{type:'checkbox',id:'format.showUnknown',label:'Include unknown deadlines',defaultValue:true});
    return f;
  },
  defaultState:{format:{title:{enabled:false},crossFilter:instrumentCrossFilter[id].defaultMode,triggerCrossFilter:id!=='time-dial',showLabels:true,showTable:false}},
  defaultSize:{width:560,height:instrumentMinimumHeight[id]},minSize:{width:280,height:instrumentMinimumHeight[id]},
  featureConfig:{crossFilter:{supportsHighlight:instrumentCrossFilter[id].supportsHighlight}},
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
  def('commerce-river','Commerce River',CommerceRiver,'Fulfillment state'),
  def('time-dial','Time Dial',TimeDial,'Clock domain'),
  def('evidence-lens','Evidence Lens',EvidenceLens,'Source provenance'),
  def('recovery-branches','Recovery Branches',RecoveryBranches,'Eligibility group'),
  def('impact-map','Impact Map',ImpactMap,'Coarse region code'),
  def('deadline-strip','Deadline Strip',DeadlineStrip,'Dispute state'),
];
export const widgets=createWidgets<GlasshouseRegistry>({additionalTypes:definitions,menu:[{label:'Glasshouse instruments',widgetIds:definitions.map(d=>d.id)},{label:'Inspect and compare',widgetIds:['grid','line-chart','column-chart-grouped','value','text']}]});
const mapping=(category:string,value='amountMinor')=>({orderId:[{id:'order_snapshot.id'}],snapshot:[{id:'order_snapshot.snapshotHash'}],category:[{id:'order_snapshot.'+category}],value:[{id:'order_snapshot.'+value,aggregation:'sum' as const}]});
export const initialState:AgReportState<GlasshouseRegistry>={
  pages:[{id:'incident-room',layout:{type:'widget',minWidth:320,columns:24,rowHeight:16,pagePadding:0,widgetPadding:0,widgetBackgroundColor:'#111c23',widgetBorderEnabled:true,widgetBorderColor:'#2b3941',widgetBorderWidth:1,widgetBorderRadius:12,backgroundColor:'#0b151b'},
    widgets:{
      river:{type:'commerce-river',dataMapping:{...mapping('fulfillmentState'),time:[{id:'transition_snapshot.transitionTime'}]},format:{crossFilter:'highlight',title:{enabled:false}}},
      dial:{type:'time-dial',dataMapping:{orderId:[{id:'order_snapshot.id'}],snapshot:[{id:'order_snapshot.snapshotHash'}],time:[{id:'order_snapshot.narrativeCreatedAt'}]},format:{title:{enabled:false},crossFilter:'none',rangeStart:'2026-11-02T00:00:00.000Z',rangeEnd:'2026-11-06T10:00:00.000Z',playbackStepMinutes:60}},
      evidence:{type:'evidence-lens',dataMapping:mapping('paymentSource','supportContacts'),format:{title:{enabled:false},showContradictions:true}},
      branches:{type:'recovery-branches',dataMapping:mapping('seedGroup','refundableMinor'),format:{title:{enabled:false},budgetMinor:30000}},
      map:{type:'impact-map',dataMapping:mapping('regionCode'),format:{title:{enabled:false},crossFilter:'highlight',displayMode:'map'}},
      deadlines:{type:'deadline-strip',dataMapping:mapping('disputeState'),format:{title:{enabled:false}}},
      records:{type:'grid',dataMapping:{cols:[{id:'order_snapshot.reference'},{id:'order_snapshot.region'},{id:'order_snapshot.fulfillmentState'},{id:'order_snapshot.amountMinor',aggregation:'sum'},{id:'order_snapshot.paymentSource'}]},format:{title:{enabled:true,text:'The records behind the river'},crossFilter:'filter'}},
    },
    widgetLayout:{river:{xTrack:0,yTrack:0,xSpan:17,ySpan:26},dial:{xTrack:17,yTrack:0,xSpan:7,ySpan:26},evidence:{xTrack:0,yTrack:26,xSpan:8,ySpan:31},branches:{xTrack:8,yTrack:26,xSpan:9,ySpan:31},map:{xTrack:17,yTrack:26,xSpan:7,ySpan:31},deadlines:{xTrack:0,yTrack:57,xSpan:24,ySpan:15},records:{xTrack:0,yTrack:72,xSpan:24,ySpan:24}},
  }],selectedPageId:'incident-room',panels:{data:{collapsed:true},edit:{collapsed:true},filters:{collapsed:true},ai:{collapsed:true}},
};

export {studioData} from './data';
export const instrumentTheme=studioTheme.withParams({
  fontFamily:'var(--font-inter), Inter, Arial, sans-serif',fontSize:13,textColor:'#dce5e8',backgroundColor:'#111c23',borderColor:'#2c3b43',accentColor:'#b6d4be',
  studioMinWidth:0,studioMinHeight:300,studioCanvasMinWidth:320,studioCanvasPadding:0,studioCanvasBackgroundColor:'#0b151b',
  studioWrapperBorder:{width:0},studioWrapperBackgroundColor:'#0b151b',studioWrapperSpacing:0,studioPanelContainerBackgroundColor:'#111c23',studioPanelHeaderFontSize:14,
  studioWidgetBackgroundColor:'#111c23',studioWidgetBorder:{width:1,color:'#2b3941'},studioWidgetBorderRadius:12,studioWidgetPadding:0,
  studioWidgetTitleFontFamily:'var(--font-inter), Inter, Arial, sans-serif',studioWidgetTitleFontSize:20,studioWidgetTitleTextColor:'#e7ece9',
  gridRowHeight:46,gridHeaderBackgroundColor:'#17252d',gridDataBackgroundColor:'#111c23',gridOddRowBackgroundColor:'#14212a',
  chartTextColor:'#dce5e8',chartSubtleTextColor:'#8da5ad',chartGridLineColor:'#2c3b43',chartPaletteFills1Color:'#87b9ac',chartPaletteFills2Color:'#ee897c',chartPaletteFills3Color:'#e5b77d',
});
