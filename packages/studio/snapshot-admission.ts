import type {Snapshot} from '../domain/types';

/** T/K intents are ordered independently of their timestamp values. A deliberate
 * rewind is allowed; an older response and a reconnect regression cannot win. */
export class SnapshotAdmission {
  private generation=0;
  private newestProjection=new Map<string,number>();
  begin(){return ++this.generation;}
  token(){return this.generation;}
  cancel(){this.generation++;}
  current(generation:number){return generation===this.generation;}
  acceptResponse(generation:number,snapshot:Snapshot,authority:Snapshot['context'],reconnect=false){
    const next=snapshot.context;
    if(!this.current(generation)||snapshot.generationId!==generation||next.tenantId!==authority.tenantId||next.roleScope!==authority.roleScope||next.rolePolicyVersion!==authority.rolePolicyVersion)return false;
    if(reconnect&&(next.clockDomain!==authority.clockDomain||next.asOf!==authority.asOf||next.currency!==authority.currency||Date.parse(next.knownAt)<Date.parse(authority.knownAt)||next.projectionVersion<authority.projectionVersion))return false;
    const key=[next.tenantId,next.rolePolicyVersion,next.clockDomain,next.asOf,next.knownAt,next.currency].join('|');
    const previous=this.newestProjection.get(key)??-1;
    if(next.projectionVersion<previous)return false;
    this.newestProjection.set(key,Math.max(previous,next.projectionVersion));return true;
  }
}
