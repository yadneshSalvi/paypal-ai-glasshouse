import type {AgReportHistory} from 'ag-studio';
import type {GlasshouseRegistry} from './types';

export type ReportHistory=AgReportHistory<GlasshouseRegistry>;
export interface SavedHistory {history:ReportHistory|null;version:number}
interface SaveRequest {history:ReportHistory;expectedVersion:number;label:string}

/** One ordered writer for manual, native and agent changes. An uncertain write
 * holds later changes until the owner explicitly retries the same document. */
export class HistorySaves {
  private admitted=false;
  private version:number;
  private chain:Promise<void>=Promise.resolve();
  private uncertain:SaveRequest|null=null;
  private stopped=false;
  constructor(version:number,private readonly write:(request:SaveRequest)=>Promise<{version:number}>,private readonly saved:(history:ReportHistory,version:number)=>void){this.version=version;}
  admit(value:boolean){this.admitted=value;}
  dispose(){this.stopped=true;this.admitted=false;}
  save(history:ReportHistory,label:string):Promise<void>{
    // Native history objects may subsequently change; bind this save to its own value.
    const copy=structuredClone(history);
    const task=this.chain.then(async()=>{
      if(this.stopped||!this.admitted)throw new Error('Your saved workspace is preserved. Saving waits for its complete history to be restored.');
      if(this.uncertain)throw new Error('The previous workspace save is unresolved. Retry that save before recording another change.');
      const request={history:copy,expectedVersion:this.version,label};
      this.uncertain=request;
      const result=await this.write(request);
      this.version=result.version;this.uncertain=null;this.saved(copy,result.version);
    });
    this.chain=task.catch(()=>{});return task;
  }
  retry():Promise<void>{
    const task=this.chain.then(async()=>{
      if(this.stopped||!this.admitted)throw new Error('Restore the saved workspace before retrying.');
      if(!this.uncertain)return;
      const request=this.uncertain,result=await this.write(request);
      this.version=result.version;this.uncertain=null;this.saved(request.history,result.version);
    });
    this.chain=task.catch(()=>{});return task;
  }
}
