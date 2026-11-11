import type {Database} from '@/packages/db/client';
import type {Actor,QueryContext,SeedDataset,Snapshot} from '@/packages/domain/types';
import {buildSnapshot} from '@/packages/domain';
import {PaymentSecrets,canonicalJson} from '@/packages/payments/security';
import {HttpError} from '../errors';
import {ownedPayment,recoveryMember} from '../recovery/authority';
import type {DisputeObservation} from '../recovery/disputes';
import {actor,authenticatedSessionHash} from '../auth';
import type {ToolkitDisputeBinding,ToolkitOwnedPayment} from './toolkit';

export type AgentActor=Actor&{agentSessionHash:string};
export async function agentActor(request:Request):Promise<AgentActor>{return {...await actor(request),agentSessionHash:authenticatedSessionHash(request)};}
export function agentSessionHash(actor:Actor){return (actor as Partial<AgentActor>).agentSessionHash;}

export class AgentSecrets {
  private readonly cipher:PaymentSecrets;
  constructor(key:string){this.cipher=new PaymentSecrets(key);}
  identity(tenantId:string,kind:string,id:string){return canonicalJson({domain:'glasshouse-agents-v1',tenantId,kind,id});}
  seal(tenantId:string,kind:string,id:string,value:unknown){return this.cipher.seal(value,this.identity(tenantId,kind,id));}
  open<T>(tenantId:string,kind:string,id:string,ciphertext:string):T {
    try{return this.cipher.open<T>(ciphertext,this.identity(tenantId,kind,id));}
    catch{throw new HttpError(409,'AGENT_DOCUMENT_UNVERIFIED','This saved investigation could not be verified. Its encrypted original is preserved.');}
  }
}
export async function agentMember(tx:Database,actor:Actor,expected=actor.membershipVersion){
  await tx.query('SELECT actor_id FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE',[actor.tenantId,actor.id]);
  const member=await recoveryMember(tx,actor,false,expected),session=agentSessionHash(actor);
  if(!session||!/^[a-f0-9]{64}$/.test(session)||!(await tx.query("SELECT token_hash FROM gh_sessions WHERE token_hash=$1 AND actor->>'tenantId'=$2 AND actor->>'id'=$3 AND expires_at>now() FOR SHARE",[session,actor.tenantId,actor.id]))[0])throw new HttpError(401,'AGENT_SESSION_EXPIRED','The exact session that authorized this agent work is no longer active. Its recorded evidence remains saved.');
  return member;
}
/** Rebuild only an already admitted snapshot. Never seed or widen a missing scope. */
export async function agentSnapshot(tx:Database,actor:Actor,snapshotHash:string){
  const member=await agentMember(tx,actor);
  const saved=(await tx.query<{context:QueryContext}>('SELECT context FROM gh_snapshots WHERE tenant_id=$1 AND hash=$2',[actor.tenantId,snapshotHash]))[0];
  if(!saved||saved.context.roleScope!==member.role||saved.context.rolePolicyVersion!==`roles-v1:${member.membershipVersion}`)throw new HttpError(409,'AGENT_SCOPE_CHANGED','The saved investigation scope is no longer current. Return to the current workspace before starting another turn.');
  const dataset=(await tx.query<{body:SeedDataset}>('SELECT body FROM gh_datasets WHERE tenant_id=$1 FOR SHARE',[actor.tenantId]))[0]?.body;
  if(!dataset)throw new HttpError(409,'AGENT_SCOPE_MISSING','Open an investigation snapshot before using an agent.');
  const snapshot=buildSnapshot(dataset,saved.context);
  if(snapshot.hash!==snapshotHash)throw new HttpError(409,'AGENT_SNAPSHOT_CHANGED','Evidence changed while this investigation was running. Its previous results are saved; start from the current snapshot.');
  return snapshot;
}
export async function ownedToolkitResource(tx:Database,actor:Actor,snapshot:Snapshot,orderId:string,disputeId?:string,includeBoundCases=false):Promise<ToolkitOwnedPayment&{disputeGrantVersion?:number;disputeHash?:string}>{
  const order=snapshot.orders.find(row=>row.id===orderId);
  if(!order||order.paymentSource!=='sandbox'||!order.captureId)throw new HttpError(403,'TOOLKIT_OWNED_SNAPSHOT_REQUIRED','This order has no admitted sandbox capture in the current snapshot.');
  const owned=await ownedPayment(tx,actor,orderId);
  if(owned.captureId!==order.captureId||owned.providerOrderId!==order.paypalOrderId)throw new HttpError(403,'TOOLKIT_SNAPSHOT_BINDING','This snapshot does not match the current provider resource grant.');
  if(disputeId){
    const row=(await tx.query<{body:DisputeObservation;version:number}>("SELECT body,version FROM gh_provider_resources WHERE tenant_id=$1 AND kind='dispute' AND provider_id=$2 AND order_id=$3 AND active=true FOR SHARE",[actor.tenantId,disputeId,orderId]))[0];
    if(!row||row.body.id!==disputeId||row.body.captureId!==owned.captureId)throw new HttpError(403,'TOOLKIT_CASE_BINDING','This case is not already bound to this owned capture.');
    return {...owned,disputeGrantVersion:row.version,disputeHash:row.body.bodyHash};
  }
  if(includeBoundCases){
    const rows=await tx.query<{provider_id:string;body:DisputeObservation;version:number}>("SELECT provider_id,body,version FROM gh_provider_resources WHERE tenant_id=$1 AND kind='dispute' AND order_id=$2 AND active=true ORDER BY provider_id LIMIT 51 FOR SHARE",[actor.tenantId,orderId]);
    if(rows.length>50)throw new HttpError(409,'TOOLKIT_CASE_BINDING_LIMIT','This owned capture has more case bindings than the bounded Toolkit read can verify.');
    const disputeBindings:ToolkitDisputeBinding[]=rows.map(row=>{
      if(row.body.id!==row.provider_id||row.body.captureId!==owned.captureId||typeof row.body.buyerTransactionId!=='string'||!/^[A-Za-z0-9_-]{1,150}$/.test(row.body.buyerTransactionId)||typeof row.body.bodyHash!=='string'||!/^[a-f0-9]{64}$/.test(row.body.bodyHash)||typeof row.body.observedAt!=='string'||!Number.isFinite(Date.parse(row.body.observedAt)))throw new HttpError(403,'TOOLKIT_CASE_BINDING','A case summary requires its independently verified owned-capture detail binding.');
      return {id:row.provider_id,captureId:owned.captureId,buyerTransactionId:row.body.buyerTransactionId,version:row.version,bodyHash:row.body.bodyHash,observedAt:row.body.observedAt};
    });
    return {...owned,disputeBindings};
  }
  return owned;
}
export function safeId(value:unknown,field:string){
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,239}$/.test(value))throw new HttpError(400,'INVALID_AGENT_ID',`A valid ${field} identity is required.`);
  return value;
}
export function bounded(value:unknown,max:number,message:string){if(Buffer.byteLength(JSON.stringify(value),'utf8')>max)throw new HttpError(413,'AGENT_DOCUMENT_LIMIT',message);}
