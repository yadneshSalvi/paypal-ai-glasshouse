import type {AgReportHistory,AgStudioApi} from 'ag-studio';
import type {GlasshouseRegistry} from './types';

export interface HistoryRestoreStatus {
  state:'checking'|'restored'|'unavailable';
  savedUndo:number;
  savedRedo:number;
  undo:number;
  redo:number;
  issues:{snapshot:string;key:string;path:unknown}[];
}

function canonical(value:unknown,path:(string|number)[]=[]):string{
  if(Array.isArray(value))return '['+value.map((child,index)=>canonical(child,[...path,index])).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([key,child])=>{
    if(child===undefined)return false;
    // AG Studio 3.1 admits an unconfigured widget's absent dataMapping as {},
    // and on later admission fills required mapping slots with empty arrays.
    // Each represents no mapped fields. Accept only these admission changes;
    // every field reference, aggregation, format, layout and other value remains
    // part of the comparison. Saved history and mutation receipts are untouched.
    const widget=path[0]==='pages'&&typeof path[1]==='number'&&path[2]==='widgets'&&typeof path[3]==='string';
    if(widget&&path.length===5&&path[4]==='dataMapping'&&Array.isArray(child)&&child.length===0)return false;
    return !(widget&&path.length===4&&key==='dataMapping'&&child!==null&&typeof child==='object'&&!Array.isArray(child)&&Object.values(child).every(mapping=>mapping===undefined||Array.isArray(mapping)&&mapping.length===0));
  }).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>JSON.stringify(key)+':'+canonical(child,[...path,key])).join(',')+'}';
  return JSON.stringify(value)??'null';
}

/** Only counts and schema paths leave this check; report contents remain private. */
export function inspectHistoryRestore(api:AgStudioApi<GlasshouseRegistry>,saved:AgReportHistory<GlasshouseRegistry>|null):HistoryRestoreStatus {
  const native=api.getHistory();
  const command=api.defineAiCommand((_s,lenses)=>({
    input:lenses.state.simple().shape,
    execute:()=>({success:true as const,value:true}),
  }));
  const snapshots=[{name:'current',state:native.current},...(saved?[{name:'saved.current',state:saved.current}]:[]),...(saved?.undo??[]).map((entry,index)=>({name:`undo.${index}`,state:entry.state})),...(saved?.redo??[]).map((entry,index)=>({name:`redo.${index}`,state:entry.state}))];
  const issues:HistoryRestoreStatus['issues']=snapshots.flatMap(snapshot=>{
    const result=command.parse(snapshot.state);
    return result.success?[]:result.issues.filter(issue=>{
      // This command's selection enum comes from the current report. A redo
      // may legitimately select a widget created in that historical state.
      // Resolve only that exact reference against its own immutable page;
      // every other native-schema issue remains a restoration failure.
      const path=issue.path;
      if(issue.key!=='validationExpectedOneOf'||!Array.isArray(path)||path.length!==4||path[0]!=='pages'||typeof path[1]!=='number'||path[2]!=='selection'||path[3]!=='id')return true;
      const page=snapshot.state.pages[path[1]],selection=page?.selection;
      return !(selection?.type==='widget'&&typeof selection.id==='string'&&!!page.widgets?.[selection.id]);
    }).map(issue=>({snapshot:snapshot.name,key:issue.key,path:issue.path??[]}));
  });
  // The display label is translated by the native engine in the current locale;
  // its key and source metadata must still retain their saved identities.
  const identity=(entry:AgReportHistory<GlasshouseRegistry>['undo'][number])=>({id:entry.id,at:entry.at,labelKey:entry.labelKey,labelVariableValues:entry.labelVariableValues,focus:entry.focus,source:entry.source});
  const sameEntries=(kind:'undo'|'redo')=>!saved||native[kind].length===saved[kind].length&&native[kind].every((entry,index)=>canonical(identity(entry))===canonical(identity(saved[kind][index]))&&canonical(entry.state)===canonical(saved[kind][index].state));
  if(saved&&canonical(native.current)!==canonical(saved.current))issues.push({snapshot:'current',key:'restored_state_differs',path:[]});
  for(const kind of ['undo','redo'] as const)if(!sameEntries(kind))issues.push({snapshot:kind,key:'restored_history_differs',path:[]});
  return {state:issues.length===0?'restored':'unavailable',savedUndo:saved?.undo.length??0,savedRedo:saved?.redo.length??0,undo:native.undo.length,redo:native.redo.length,issues};
}
