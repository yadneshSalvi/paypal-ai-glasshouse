import type {Snapshot} from '../domain/types';
export interface PlaybackIntent {start:string;end:string;stepMinutes:number}
/** Playback advances only after the preceding complete native report commits.
 * There is never more than one source intent in flight. K remains pinned. */
export class TemporalPlayback {
  private active=false;
  private intent:PlaybackIntent|null=null;
  private listeners=new Set<()=>void>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  constructor(private request:(asOf:string,knownAt:string,clock:Snapshot['context']['clockDomain'])=>void,private delayMs=1200){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  getSnapshot=()=>this.active;
  private changed(){for(const listener of this.listeners)listener();}
  pause=()=>{this.active=false;if(this.timer)clearTimeout(this.timer);this.timer=null;this.changed();};
  start(snapshot:Snapshot,intent:PlaybackIntent){
    const start=Date.parse(intent.start),end=Date.parse(intent.end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||!Number.isSafeInteger(intent.stepMinutes)||intent.stepMinutes<1||intent.stepMinutes>1440)throw new Error('Replay needs an exact increasing range and a step from 1 to 1,440 minutes.');
    this.pause();this.intent=intent;this.active=true;this.changed();
    const at=Date.parse(snapshot.context.asOf)>=end?start:Math.max(start,Math.min(end,Date.parse(snapshot.context.asOf)+intent.stepMinutes*60_000));
    this.request(new Date(at).toISOString(),snapshot.context.knownAt,snapshot.context.clockDomain);
  }
  committed(snapshot:Snapshot){
    if(!this.active||!this.intent)return;
    if(this.timer)clearTimeout(this.timer);
    const end=Date.parse(this.intent.end),at=Date.parse(snapshot.context.asOf);
    if(at>=end){this.pause();return;}
    const next=new Date(Math.min(end,at+this.intent.stepMinutes*60_000)).toISOString();
    this.timer=setTimeout(()=>{this.timer=null;if(this.active)this.request(next,snapshot.context.knownAt,snapshot.context.clockDomain);},this.delayMs);
  }
  dispose(){this.pause();this.listeners.clear();}
}
