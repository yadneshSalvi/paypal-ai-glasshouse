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

/** Only counts and schema paths leave this check; report contents remain private. */
export function inspectHistoryRestore(api:AgStudioApi<GlasshouseRegistry>,saved:AgReportHistory<GlasshouseRegistry>|null):HistoryRestoreStatus {
  const native=api.getHistory();
  const command=api.defineAiCommand((_s,lenses)=>({
    input:lenses.state.simple().shape,
    execute:()=>({success:true as const,value:true}),
  }));
  const snapshots=[{name:'current',state:native.current},...(saved?.undo??[]).map((entry,index)=>({name:`undo.${index}`,state:entry.state})),...(saved?.redo??[]).map((entry,index)=>({name:`redo.${index}`,state:entry.state}))];
  const issues=snapshots.flatMap(snapshot=>{
    const result=command.parse(snapshot.state);
    return result.success?[]:result.issues.map(issue=>({snapshot:snapshot.name,key:issue.key,path:issue.path??[]}));
  });
  const sameEntries=(kind:'undo'|'redo')=>!saved||native[kind].length===saved[kind].length&&native[kind].every((entry,index)=>entry.id===saved[kind][index].id);
  return {state:issues.length===0&&sameEntries('undo')&&sameEntries('redo')?'restored':'unavailable',savedUndo:saved?.undo.length??0,savedRedo:saved?.redo.length??0,undo:native.undo.length,redo:native.redo.length,issues};
}
