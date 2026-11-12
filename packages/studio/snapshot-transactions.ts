import type {AgDataTransaction} from 'ag-studio';
import type {Snapshot} from '../domain/types';

export function snapshotTransactions(before:Snapshot,next:Snapshot):AgDataTransaction[]{
  return Object.entries(next.tables).map(([tableId,rows])=>{
    const previous=before.tables[tableId as keyof Snapshot['tables']]??[];
    const oldKeys=new Set(previous.map(row=>row.id)),nextKeys=new Set(rows.map(row=>row.id));
    return {tableId,remove:previous.filter(row=>!nextKeys.has(row.id)).map(row=>row.id),
      update:rows.filter(row=>oldKeys.has(row.id)),add:rows.filter(row=>!oldKeys.has(row.id))};
  });
}

interface Handlers {
  prepare(snapshot:Snapshot):void;
  apply(transactions:readonly AgDataTransaction[]):Promise<unknown>;
  applied(snapshot:Snapshot):void;
  settled(snapshot:Snapshot):void;
  failed(error:unknown):void;
}

/** Serializes engine writes; a newer request always supersedes an older target,
 * including a return to the snapshot that was current before an in-flight write. */
export class SnapshotTransactions {
  private generation=0;
  private chain:Promise<unknown>=Promise.resolve();
  private held=false;
  constructor(private current:Snapshot,private readonly handlers:Handlers){}

  request(snapshot:Snapshot):Promise<'settled'|'superseded'|'held'>{
    const generation=++this.generation;
    const task=this.chain.then(async()=>{
      if(this.held)return 'held' as const;
      if(generation!==this.generation)return 'superseded' as const;
      try{
        this.handlers.prepare(snapshot);
        if(this.current.hash!==snapshot.hash){
          await this.handlers.apply(snapshotTransactions(this.current,snapshot));
          this.current=snapshot;
          this.handlers.applied(snapshot);
        }
        if(generation!==this.generation)return 'superseded' as const;
        this.handlers.settled(snapshot);
        return 'settled' as const;
      }catch(error){
        // A rejected engine batch may have started changing sources. Do not infer
        // its final state or apply another delta until a clean reload establishes it.
        this.held=true;this.handlers.failed(error);
        return 'held' as const;
      }
    });
    this.chain=task;
    return task;
  }
}

export function widgetsAtSnapshot(required:readonly string[],acknowledgements:ReadonlyMap<string,string>,hash:string):boolean{
  return required.every(id=>acknowledgements.get(id)===hash);
}
