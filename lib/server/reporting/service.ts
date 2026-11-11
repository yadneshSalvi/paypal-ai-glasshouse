import {randomUUID} from 'node:crypto';
import type {Database} from '@/packages/db/client';
import type {Actor} from '@/packages/domain/types';
import type {ReportingOverview,ReportingPage,ReportingRunView} from '@/packages/reporting/types';
import {digest} from '@/packages/payments/security';
import {HttpError} from '../errors';
import {audit} from '../repository';
import {recoveryMember} from '../recovery/authority';
import {assertWorkspaceRequestWrite} from '../workspaces/authority';
import {requireConnector,type ObservationConnector} from '../observations/connector';
import type {ReportingGrant,ReportingReader} from './gateway';
export type ReportingInput={requestId:string;start:string;end:string};
type Run=Record<string,unknown>&{tenant_id:string;id:string;request_id:string;payload_hash:string;connector_id:string;config_hash:string;actor:Actor;grants:ReportingGrant[];grant_hash:string;state:ReportingRunView['state'];start_at:Date|string;end_at:Date|string;created_at:Date|string;completed_at:Date|string|null;reason:string|null};
type Window=Record<string,unknown>&{tenant_id:string;run_id:string;ordinal:number;start_at:Date|string;end_at:Date|string;state:string;next_page:number;metadata:{totalPages:number;totalItems:number;refreshedAt:string|null}|null;attempts:number;lease_id:string|null;lease_until:Date|string|null;reason:string|null};
const iso=(value:Date|string)=>new Date(value).toISOString();
const limits=['Reporting is read-only evidence; original capture and refund receipts remain authoritative.','An absent reporting row is unobserved, never a decline or a lost payment.','PayPal documents reporting lag of up to three hours. Pagination is not an atomic snapshot guarantee.','Only currently owned capture and refund identities are imported; unrelated account transactions are excluded.','The owned-resource denominator is the whole workspace; resources outside the chosen dates need not appear in this scan.'];
const terminal=new Set(['CURRENT_AUTHORITY_REQUIRED','CONNECTOR_BINDING_CHANGED','REPORTING_GRANTS_CHANGED','REPORTING_METADATA_CHANGED','REPORTING_WINDOW_TOO_LARGE','REPORTING_REQUEST_REFUSED','REPORTING_SHAPE_UNCERTAIN','REPORTING_COUNT_MISMATCH']);
export class ReportingService {
 constructor(readonly db:Database,readonly connector:ObservationConnector|null,readonly reader:ReportingReader|null){}
 private async grants(db:Database,tenantId:string):Promise<ReportingGrant[]>{
  const rows=await db.query<{provider_id:string;kind:'capture'|'refund';order_id:string;version:number}>(`SELECT provider_id,kind,order_id,version FROM gh_provider_resources
   WHERE tenant_id=$1 AND kind IN ('capture','refund') AND active=true ORDER BY provider_id,kind FOR SHARE`,[tenantId]);
  if(!rows.length||rows.length>3000||new Set(rows.map(r=>r.provider_id)).size!==rows.length)throw new HttpError(409,'REPORTING_GRANTS_CHANGED','The current owned reporting resource set is unavailable or ambiguous.');
  return rows.map(r=>({id:r.provider_id,kind:r.kind,orderId:r.order_id,version:r.version}));
 }
 private async authority(db:Database,run:Run){
  const c=this.connector;if(!c||c.tenantId!==run.tenant_id||c.id!==run.connector_id||c.configHash!==run.config_hash)throw new HttpError(409,'CONNECTOR_BINDING_CHANGED','Restore this run’s original merchant binding before another read.');
  await db.query('SELECT id FROM gh_paypal_connectors WHERE id=$1 FOR SHARE',[c.id]);await requireConnector(db,c);
  await db.query('SELECT actor_id FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE',[run.tenant_id,run.actor.id]);await recoveryMember(db,run.actor);
  if(digest(await this.grants(db,run.tenant_id))!==run.grant_hash||digest(run.grants)!==run.grant_hash)throw new HttpError(409,'REPORTING_GRANTS_CHANGED','The owned resource set changed. Retain this scan and start a new one with the current scope.');
 }
 async start(actor:Actor,input:ReportingInput){
  const start=Date.parse(input.start),end=Date.parse(input.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000||end>Date.now()+60000||start<Date.now()-3*366*86400000||!/^[-a-f0-9]{36}$/.test(input.requestId))throw new HttpError(400,'REPORTING_WINDOW_INVALID','Choose past UTC dates spanning at most 31 days.');
  const c=this.connector;if(!c||c.tenantId!==actor.tenantId||!this.reader)throw new HttpError(503,'REPORTING_UNAVAILABLE','Connect this workspace’s isolated merchant reporting source.');
  return this.db.transaction(async tx=>{
   await assertWorkspaceRequestWrite(tx,actor);
   await recoveryMember(tx,actor);await requireConnector(tx,c);await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`reporting:${actor.tenantId}`]);
   const payloadHash=digest({actorId:actor.id,start:iso(input.start),end:iso(input.end)});
   const old=(await tx.query<Run>('SELECT * FROM gh_reporting_runs WHERE tenant_id=$1 AND request_id=$2',[actor.tenantId,input.requestId]))[0];
   if(old){if(old.payload_hash!==payloadHash)throw new HttpError(409,'REPORTING_REQUEST_CHANGED','This request identity already has different dates.');return {id:old.id,replayed:true,readOnly:true};}
   if((await tx.query("SELECT id FROM gh_reporting_runs WHERE tenant_id=$1 AND state='active'",[actor.tenantId])).length)throw new HttpError(409,'REPORTING_ALREADY_ACTIVE','Continue or stop the current reporting scan before starting another.');
   const count=(await tx.query<{count:string}>("SELECT count(*)::text AS count FROM gh_reporting_runs WHERE tenant_id=$1 AND created_at>now()-interval '1 hour'",[actor.tenantId]))[0];
   if(Number(count?.count??0)>=6)throw new HttpError(429,'REPORTING_RUN_LIMIT','Six reporting scans have already been requested in this hour. Saved work remains available.');
   const grants=await this.grants(tx,actor.tenantId),id=randomUUID();
   await tx.query(`INSERT INTO gh_reporting_runs(tenant_id,id,request_id,payload_hash,connector_id,config_hash,actor,grants,grant_hash,start_at,end_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,[actor.tenantId,id,input.requestId,payloadHash,c.id,c.configHash,JSON.stringify(actor),JSON.stringify(grants),digest(grants),iso(input.start),iso(input.end)]);
   let cursor=start,ordinal=0;while(cursor<end){const next=Math.min(cursor+86400000,end);await tx.query('INSERT INTO gh_reporting_windows(tenant_id,run_id,ordinal,start_at,end_at) VALUES($1,$2,$3,$4,$5)',[actor.tenantId,id,ordinal++,new Date(cursor).toISOString(),new Date(next).toISOString()]);cursor=next;}
   await audit(tx,actor,'reporting.requested','Requested an owned-resource reporting scan',id,{readOnly:true,windows:ordinal,resources:grants.length,start:iso(input.start),end:iso(input.end)});
   return {id,replayed:false,readOnly:true};
  });
 }
 async cancel(actor:Actor,id:string){return this.db.transaction(async tx=>{
  await assertWorkspaceRequestWrite(tx,actor);
  await recoveryMember(tx,actor);const r=(await tx.query<Run>('SELECT * FROM gh_reporting_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,id]))[0];
  if(!r)throw new HttpError(404,'REPORTING_RUN_NOT_FOUND','This workspace has no such scan.');
  if(r.state==='active'||r.state==='attention'){await tx.query("UPDATE gh_reporting_runs SET state='cancelled',completed_at=now(),reason='Stopped by the current workspace operator; earlier observations retained.' WHERE tenant_id=$1 AND id=$2",[actor.tenantId,id]);
   await audit(tx,actor,'reporting.cancelled','Stopped future reporting reads; retained collected evidence',id,{readOnly:true});}
  return {readOnly:true,id};
 });}
 private async claim(tenantId?:string){return this.db.transaction(async tx=>{
  const w=(await tx.query<Window>(`SELECT w.* FROM gh_reporting_windows w JOIN gh_reporting_runs r ON r.tenant_id=w.tenant_id AND r.id=w.run_id
   WHERE r.state='active' AND ($1::text IS NULL OR w.tenant_id=$1) AND w.state IN ('queued','reading','retry') AND w.next_attempt_at<=now()
   AND (w.lease_until IS NULL OR w.lease_until<now()) ORDER BY r.created_at,w.ordinal FOR UPDATE OF w SKIP LOCKED LIMIT 1`,[tenantId??null]))[0];
  if(!w)return null;
  if(w.lease_id)await tx.query("UPDATE gh_reporting_pages SET state='interrupted',finished_at=now(),reason='Prior page worker ended before a checkpoint.' WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='reading'",[w.tenant_id,w.run_id,w.lease_id]);
  const id=randomUUID();await tx.query("UPDATE gh_reporting_windows SET state='reading',attempts=attempts+1,lease_id=$4,lease_until=now()+interval '70 seconds' WHERE tenant_id=$1 AND run_id=$2 AND ordinal=$3",[w.tenant_id,w.run_id,w.ordinal,id]);
  await tx.query('INSERT INTO gh_reporting_pages(tenant_id,run_id,ordinal,page,attempt_id) VALUES($1,$2,$3,$4,$5)',[w.tenant_id,w.run_id,w.ordinal,w.next_page,id]);
  return {...w,lease_id:id,attempts:w.attempts+1};
 });}
 private async process(w:Window){
  let page:ReportingPage|null=null,error:unknown=null;
  try {
   const run=(await this.db.query<Run>('SELECT * FROM gh_reporting_runs WHERE tenant_id=$1 AND id=$2',[w.tenant_id,w.run_id]))[0];
   if(!run||run.state!=='active')throw new HttpError(409,'REPORTING_STOPPED','This scan stopped before another provider read.');
   await this.db.transaction(tx=>this.authority(tx,run));
   if(!this.reader)throw new HttpError(503,'REPORTING_UNAVAILABLE','The reporting source is unavailable.');
   page=await this.reader.read(iso(w.start_at),iso(w.end_at),w.next_page,run.grants,AbortSignal.timeout(25000));
   if(page.page!==w.next_page)throw new HttpError(502,'REPORTING_SHAPE_UNCERTAIN','The provider page did not match its durable checkpoint.');
   const metadata={totalPages:page.totalPages,totalItems:page.totalItems,refreshedAt:page.refreshedAt};
   if(w.metadata&&digest(w.metadata)!==digest(metadata))throw new HttpError(409,'REPORTING_METADATA_CHANGED','The provider refreshed or changed pagination during this scan. Earlier pages remain recorded; start a fresh scan for complete coverage.');
  }catch(failure){error=failure;}
  return this.db.transaction(async tx=>{
   const run=(await tx.query<Run>('SELECT * FROM gh_reporting_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[w.tenant_id,w.run_id]))[0];
   const current=(await tx.query<Window>('SELECT * FROM gh_reporting_windows WHERE tenant_id=$1 AND run_id=$2 AND ordinal=$3 FOR UPDATE',[w.tenant_id,w.run_id,w.ordinal]))[0];
   if(!current||current.lease_id!==w.lease_id||!current.lease_until||Date.parse(iso(current.lease_until))<=Date.now())return;
   if(!run||run.state!=='active'){await tx.query("UPDATE gh_reporting_pages SET state='discarded',finished_at=now(),reason='Run stopped before checkpoint; no new observation accepted.' WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3",[w.tenant_id,w.run_id,w.lease_id]);await tx.query("UPDATE gh_reporting_windows SET state='cancelled',lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND run_id=$2 AND ordinal=$3",[w.tenant_id,w.run_id,w.ordinal]);return;}
   if(!error)try{await this.authority(tx,run);}catch(e){error=e;}
   if(!error&&page){
    const prior=(await tx.query<{returned:string;pages:string}>("SELECT coalesce(sum((body->>'returned')::integer),0)::text AS returned,count(*)::text AS pages FROM gh_reporting_pages WHERE tenant_id=$1 AND run_id=$2 AND ordinal=$3 AND state='complete'",[w.tenant_id,w.run_id,w.ordinal]))[0];
    const total=Number(prior.returned)+page.returned,finished=page.page>=page.totalPages;
    if(Number(prior.pages)!==page.page-1||!Number.isSafeInteger(page.returned)||page.returned<0||page.returned>100||total>page.totalItems||finished&&total!==page.totalItems||!finished&&page.returned===0)
     error=new HttpError(409,'REPORTING_COUNT_MISMATCH','The collected row count does not match the provider’s pagination. Earlier pages remain recorded; complete coverage is not claimed.');
   }
   if(error||!page){const code=error instanceof HttpError?error.code:'REPORTING_UNAVAILABLE',reason=error instanceof HttpError?error.message:'The provider read could not finish. This exact page remains saved.';
    const state=terminal.has(code)||w.attempts>=8?'attention':'retry';
    await tx.query("UPDATE gh_reporting_pages SET state='failed',finished_at=now(),reason=$4 WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3",[w.tenant_id,w.run_id,w.lease_id,reason]);
    await tx.query("UPDATE gh_reporting_windows SET state=$4,reason=$5,lease_id=NULL,lease_until=NULL,next_attempt_at=now()+($6::text||' seconds')::interval WHERE tenant_id=$1 AND run_id=$2 AND ordinal=$3",[w.tenant_id,w.run_id,w.ordinal,state,reason,Math.min(300,5*2**w.attempts)]);
    if(state==='attention')await tx.query("UPDATE gh_reporting_runs SET state='attention',reason=$3,completed_at=now() WHERE tenant_id=$1 AND id=$2",[w.tenant_id,w.run_id,reason]);
    return state;
   }
   for(const entry of page.entries)await tx.query('INSERT INTO gh_reporting_evidence(tenant_id,run_id,transaction_id,body_hash,observed_at,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING',[w.tenant_id,w.run_id,entry.transactionId,digest(entry),page.observedAt,JSON.stringify(entry)]);
   await tx.query("UPDATE gh_reporting_pages SET state='complete',finished_at=now(),body=$4::jsonb WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3",[w.tenant_id,w.run_id,w.lease_id,JSON.stringify({...page,entries:undefined})]);
   const done=page.page>=page.totalPages;
   await tx.query("UPDATE gh_reporting_windows SET state=$4,next_page=$5,metadata=$6::jsonb,attempts=0,lease_id=NULL,lease_until=NULL,reason=NULL,next_attempt_at=now() WHERE tenant_id=$1 AND run_id=$2 AND ordinal=$3",[w.tenant_id,w.run_id,w.ordinal,done?'complete':'queued',done?page.page:page.page+1,JSON.stringify({totalPages:page.totalPages,totalItems:page.totalItems,refreshedAt:page.refreshedAt})]);
   if(!(await tx.query("SELECT ordinal FROM gh_reporting_windows WHERE tenant_id=$1 AND run_id=$2 AND state<>'complete'",[w.tenant_id,w.run_id])).length)await tx.query("UPDATE gh_reporting_runs SET state='complete',completed_at=now() WHERE tenant_id=$1 AND id=$2",[w.tenant_id,w.run_id]);
   return 'complete';
  });
 }
 async drain(options:{tenantId?:string;limit?:number}={}){
  let processed=0;const limit=options.limit??4;if(!Number.isInteger(limit)||limit<1||limit>8)throw new HttpError(400,'REPORTING_BOUND_REQUIRED','Select a bounded reporting batch.');
  const stopAt=Date.now()+45000;while(processed<limit&&(processed===0||stopAt-Date.now()>=30000)){const w=await this.claim(options.tenantId);if(!w)break;await this.process(w);processed++;}return {processed,readOnly:true};
 }
 async evidence(actor:Actor,id:string,pageNumber:number){
  await recoveryMember(this.db,actor);
  if(!Number.isSafeInteger(pageNumber)||pageNumber<1||pageNumber>100)throw new HttpError(400,'REPORTING_PAGE_INVALID','Choose a saved evidence page.');
  if(!(await this.db.query('SELECT id FROM gh_reporting_runs WHERE tenant_id=$1 AND id=$2',[actor.tenantId,id])).length)throw new HttpError(404,'REPORTING_RUN_NOT_FOUND','This workspace has no such scan.');
  const count=(await this.db.query<{count:string}>('SELECT count(*)::text AS count FROM gh_reporting_evidence WHERE tenant_id=$1 AND run_id=$2',[actor.tenantId,id]))[0];
  const rows=await this.db.query<{body:import('@/packages/reporting/types').ReportingEntry;observed_at:Date|string;body_hash:string}>('SELECT body,observed_at,body_hash FROM gh_reporting_evidence WHERE tenant_id=$1 AND run_id=$2 ORDER BY transaction_id,observed_at,body_hash LIMIT 50 OFFSET $3',[actor.tenantId,id,(pageNumber-1)*50]);
  return {runId:id,page:pageNumber,total:Number(count.count),pageSize:50,rows:rows.map(row=>({...row.body,observedAt:iso(row.observed_at),evidenceHash:row.body_hash}))};
 }
 async overview(actor:Actor):Promise<ReportingOverview>{
  await recoveryMember(this.db,actor);const runs=await this.db.query<Run>('SELECT * FROM gh_reporting_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 8',[actor.tenantId]);const views:ReportingRunView[]=[];
  for(const r of runs){const windows=await this.db.query<Window>('SELECT * FROM gh_reporting_windows WHERE tenant_id=$1 AND run_id=$2 ORDER BY ordinal',[actor.tenantId,r.id]);
   const stats=(await this.db.query<{pages:string;observed:string;refreshed:string|null}>(`SELECT (SELECT count(*)::text FROM gh_reporting_pages WHERE tenant_id=$1 AND run_id=$2 AND state='complete') AS pages,
    (SELECT count(DISTINCT transaction_id)::text FROM gh_reporting_evidence WHERE tenant_id=$1 AND run_id=$2) AS observed,
    (SELECT min(metadata->>'refreshedAt') FROM gh_reporting_windows WHERE tenant_id=$1 AND run_id=$2) AS refreshed`,[actor.tenantId,r.id]))[0];
   views.push({id:r.id,start:iso(r.start_at),end:iso(r.end_at),state:r.state,createdAt:iso(r.created_at),completedAt:r.completed_at?iso(r.completed_at):null,windows:windows.length,completedWindows:windows.filter(w=>w.state==='complete').length,pages:Number(stats.pages),ownedResources:r.grants.length,observedResources:Number(stats.observed),refreshedAt:stats.refreshed,reason:r.reason,
    coverage:windows.map(w=>({index:w.ordinal,start:iso(w.start_at),end:iso(w.end_at),state:w.state,nextPage:w.next_page,pages:w.metadata?.totalPages??0,reason:w.reason}))});
  }
  let configured=false;if(this.connector?.tenantId===actor.tenantId&&this.reader)try{await requireConnector(this.db,this.connector);configured=true;}catch{}
  return {configured,runs:views,limitations:limits};
 }
}
