import type {AgReportState,AgResponsiveLayoutCandidate,AgWidgetLayoutState} from 'ag-studio';
import type {GlasshouseRegistry} from './types';

export const instrumentMinimumHeight:Record<string,number>={
  'commerce-river':520,
  'time-dial':760,
  'evidence-lens':640,
  'recovery-branches':860,
  'impact-map':600,
  'deadline-strip':600,
};

/** Reflow the same Studio widgets, retaining their authored reading order. */
export function readableLayout(items:AgResponsiveLayoutCandidate[],columns:number,mode:'single'|'paired'|'authored'):AgWidgetLayoutState[] {
  const ordered=items.map((item,index)=>({item,index})).sort((a,b)=>a.item.layout.yTrack-b.item.layout.yTrack||a.item.layout.xTrack-b.item.layout.xTrack);
  const result:AgWidgetLayoutState[]=Array(items.length);
  let y=0;
  let x=0;
  let rowHeight=0;
  let authoredRow:number|undefined;
  for(const {item,index} of ordered){
    const h=Math.max(item.layout.ySpan,item.minSize.ySpan,mode==='single'?36:0);
    if(mode==='authored'){
      if(authoredRow!==undefined&&authoredRow!==item.layout.yTrack){y+=rowHeight;rowHeight=0;}
      authoredRow=item.layout.yTrack;
      result[index]={...item.layout,yTrack:y,ySpan:h};
      rowHeight=Math.max(rowHeight,h);
      continue;
    }
    const span=mode==='single'||item.layout.xSpan>=columns*0.6?columns:Math.ceil(columns/2);
    if(x+span>columns){y+=rowHeight;x=0;rowHeight=0;}
    result[index]={xTrack:x,yTrack:y,xSpan:span,ySpan:h};
    x+=span;
    rowHeight=Math.max(rowHeight,h);
    if(x===columns){y+=rowHeight;x=0;rowHeight=0;}
  }
  return result;
}

export function workspaceHeight(state:AgReportState<GlasshouseRegistry>,width:number):number {
  const page=state.pages.find(page=>page.id===state.selectedPageId)??state.pages[0];
  if(!page)return 640;
  const rowHeight=page.layout?.rowHeight??16;
  const columns=page.layout?.columns??24;
  const candidates=Object.entries(page.widgetLayout??{}).filter(([,layout])=>layout!=null).map(([id,layout])=>({
    layout:layout!,
    minSize:{xSpan:1,ySpan:Math.ceil((instrumentMinimumHeight[page.widgets?.[id]?.type??'']??384)/rowHeight)},
  }));
  const layout=readableLayout(candidates,columns,width<=760?'single':width<=1180?'paired':'authored');
  return Math.max(640,...layout.map(item=>(item.yTrack+item.ySpan)*rowHeight+24));
}
