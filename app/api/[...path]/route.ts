import type { AgLlmRequest } from 'ag-studio';
import type { AgentRunEvent } from '@/packages/domain/types';
import { database } from '@/packages/db/client';
import { actor, startSession } from '@/lib/server/auth';
import { body, problem, HttpError, sameOrigin } from '@/lib/server/errors';
import { snapshotFor } from '@/lib/server/snapshots';
import { audit, auditFor, hash, operationsFor, plansFor } from '@/lib/server/repository';
import { approvePlan, createPlan, enqueuePlan, reviseEvidence } from '@/lib/server/plans';
import { capabilities } from '@/lib/server/capabilities';
import { modelTurn } from '@/lib/server/model';
import { paymentsRuntime } from '@/lib/server/payments/runtime';
import { currentMember } from '@/lib/server/payments/records';
import { recoveryRuntime } from '@/lib/server/recovery/runtime';
import { orderDetailFor } from '@/lib/server/order-detail';
import {readLayout,saveLayout} from '@/lib/server/layouts';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
type Params={params:Promise<{path:string[]}>};

async function dispatch(request:Request, context:Params):Promise<Response> {
  const {path}=await context.params;
  const key=path.join('/');
  const method=request.method;
  const url=new URL(request.url);
  if(method!=='GET') sameOrigin(request);
  if(key==='health') {
    const db=await database(); await db.query('SELECT 1');
    return Response.json({status:'ok',product:'Glasshouse',storage:'durable-postgres',version:'0.1.0'});
  }
  if(key==='session' && method==='POST') {
    const session=await startSession(request);
    const snapshot=await snapshotFor(session.actor);
    return Response.json({actor:session.actor,snapshot,capabilities:await capabilities(session.actor),studioLicense:process.env.AG_STUDIO_LICENSE_KEY || ''},{headers:session.cookie?{'Set-Cookie':session.cookie}:{}});
  }
  const who=await actor(request);
  const db=await database();
  if(path[0]==='sandbox') {
    const {service,executor}=await paymentsRuntime();
    if(key==='sandbox' && method==='GET') return Response.json(await service.status(who));
    if(key==='sandbox/runs' && method==='POST') {
      const input=await body<{manifestHash:string}>(request);
      return Response.json(await service.createRun(who,input.manifestHash));
    }
    if(path[1]==='runs' && path[2] && method==='POST') {
      const runId=path[2];
      const input=await body<{manifestHash?:string;state?:string}>(request);
      if(path[3]==='connect') return Response.json(await service.connect(who,runId,input.manifestHash??'',url.origin,request.signal));
      if(path[3]==='complete-consent') return Response.json(await service.completeConsent(who,runId,input.state,request.signal));
      if(path[3]==='approve') return Response.json(await service.approve(who,runId,input.manifestHash??''));
      if(path[3]==='revoke') return Response.json(await service.revoke(who,runId));
      if(path[3]==='process') {
        await currentMember(db,who.tenantId,who.id,who.membershipVersion);
        if(!executor) throw new HttpError(503,'SANDBOX_NOT_CONFIGURED','Connect the isolated sandbox to process the approved batch.');
        await executor.drain({tenantId:who.tenantId,runId,limit:40,signal:request.signal});
        return Response.json(await service.viewRun(who,runId));
      }
    }
  }
  if(key==='snapshots' && method==='GET') return Response.json(await snapshotFor(who,url.searchParams));
  if(key==='capabilities' && method==='GET') return Response.json(await capabilities(who));
  if(key==='evidence/revise' && method==='POST') return Response.json(await reviseEvidence(who));
  if(key==='plans' && method==='GET') return Response.json(await plansFor(who));
  if(key==='plans' && method==='POST') {
    const input=await body<{branchId:string;budgetMinor:number;snapshotHash?:string}>(request);
    return Response.json(await createPlan(who,input.branchId,input.budgetMinor,input.snapshotHash));
  }
  if(path[0]==='plans' && path[2]==='approve' && method==='POST') {
    const input=await body<{hash:string;fixtureAcknowledged?:boolean}>(request);
    return Response.json(await approvePlan(who,path[1],input.hash,input.fixtureAcknowledged===true));
  }
  if(path[0]==='plans' && path[2]==='execute' && method==='POST') {
    const input=await body<{hash:string}>(request);
    return Response.json(await enqueuePlan(who,path[1],input.hash));
  }
  if(key==='operations' && method==='GET') return Response.json(await operationsFor(who,url.searchParams.get('planId') ?? undefined));
  if(key==='history' && method==='GET') return Response.json(await auditFor(who,Math.max(0,Number(url.searchParams.get('after'))||0)));
  if(key==='events' && method==='GET') {
    const events=await auditFor(who,Math.max(0,Number(url.searchParams.get('after'))||0));
    return new Response(events.map(e=>`id: ${e.sequence}\nevent: domain\ndata: ${JSON.stringify(e)}\n\n`).join('')+'event: checkpoint\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'}});
  }
  if(path[0]==='orders' && path[1] && path[2]==='disputes' && ['GET','POST'].includes(method)) {
    const {disputeService}=await recoveryRuntime();
    const value=method==='POST'?await disputeService.syncOrder(who,path[1],request.signal):await disputeService.stored(who,path[1]);
    return Response.json({...value,disputes:value.disputes.map(({buyerTransactionId,...safe})=>safe)});
  }
  if(path[0]==='orders' && path[1] && path.length===2 && method==='GET') return Response.json(await orderDetailFor(who,path[1],url.searchParams.get('snapshotHash')??''));
  if(key==='layout') {
    if(method==='GET'){const saved=await readLayout(db,who);return Response.json(url.searchParams.get('envelope')==='1'?saved:saved.history);}
    if(method==='POST') {
      const input=await body<{history:unknown;expectedVersion:number;label?:string}>(request);
      return Response.json(await saveLayout(db,who,input));
    }
  }
  if(path[0]==='threads') {
    if(method==='GET' && !path[1]) return Response.json((await db.query<{body:{summary:unknown}}>('SELECT body FROM gh_threads WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 100',[who.tenantId])).map(r=>r.body.summary));
    if(method==='GET') return Response.json((await db.query<{body:unknown}>('SELECT body FROM gh_threads WHERE tenant_id=$1 AND id=$2',[who.tenantId,path[1]]))[0]?.body ?? null);
    if(method==='POST') {
      const input=await body<{summary:{id?:string;threadId?:string};messages:unknown[]}>(request);
      const id=input.summary?.id || input.summary?.threadId || path[1];
      if(!id || !Array.isArray(input.messages)) throw new HttpError(400,'INVALID_THREAD','The conversation could not be saved.');
      await db.query('INSERT INTO gh_threads(tenant_id,id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id,id) DO UPDATE SET body=excluded.body,updated_at=now()',[who.tenantId,id,JSON.stringify(input)]);
      return Response.json({saved:true});
    }
    if(method==='DELETE') {await db.query('DELETE FROM gh_threads WHERE tenant_id=$1 AND id=$2',[who.tenantId,path[1]]);return Response.json({deleted:true});}
  }
  if(key==='ai/turn' && method==='POST') return Response.json(await modelTurn(who,await body<AgLlmRequest>(request),request.signal));
  if(key==='agent/events' && method==='GET') return Response.json((await db.query<{body:AgentRunEvent}>('SELECT body FROM gh_agent_events WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 100',[who.tenantId])).map(r=>r.body));
  if(key==='agent/events' && method==='POST') {
    const input=await body<AgentRunEvent>(request);
    if(!['Studio','application'].includes(input.transportKind) || !input.runId || !input.eventId) throw new HttpError(400,'INVALID_EVENT','Client telemetry cannot assert a provider result.');
    await db.query('INSERT INTO gh_agent_events(tenant_id,event_id,run_id,source_context_hash,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',[who.tenantId,input.eventId,input.runId,input.sourceContextHash,JSON.stringify(input)]);
    return Response.json({recorded:true});
  }
  if(key==='agent/tool' && method==='POST') {
    const input=await body<{name:string;args?:Record<string,unknown>;context?:{asOf?:string;knownAt?:string;snapshotHash?:string}}>(request);
    if(input.name==='execute_refund' || input.name==='execute_plan') {
      await audit(db,{...who,role:'investigator'},'authority.denied','Investigator execution request denied',null,{tool:input.name});
      throw new HttpError(403,'INVESTIGATOR_READ_ONLY','The Investigator can inspect evidence and propose a plan. Exact human approval is required before the Operator can execute.');
    }
    const query=new URLSearchParams();
    if(input.context?.asOf)query.set('asOf',input.context.asOf);
    if(input.context?.knownAt)query.set('knownAt',input.context.knownAt);
    const snapshot=await snapshotFor(who,query);
    if(input.context?.snapshotHash&&snapshot.hash!==input.context.snapshotHash)throw new HttpError(409,'AGENT_CONTEXT_CHANGED','The investigation context changed. Read the current snapshot and start this tool again.');
    if(input.name==='read_incident') return Response.json({incidentId:'carrier-delay-pnw',snapshotHash:snapshot.hash,context:snapshot.context,totals:snapshot.totals,sourceCoverage:snapshot.sourceCoverage,detectors:snapshot.detectors,affectedOrderIds:snapshot.affectedOrderIds,removedOrderIds:snapshot.removedOrderIds});
    if(input.name==='read_evidence') return Response.json({snapshotHash:snapshot.hash,evidence:snapshot.evidence.slice(0,40)});
    if(input.name==='evaluate_recovery') return Response.json({snapshotHash:snapshot.hash,branches:snapshot.branches.map(b=>({id:b.id,policyId:b.policyId,eligibleCount:b.eligibleCount,refundTotalMinor:b.refundTotalMinor,trackingCount:b.trackingCount,disputeCount:b.disputeCount,exclusionCounts:b.exclusionCounts,budgetMinor:b.budgetMinor})),approvalRequired:true});
    if(input.name==='prepare_recovery') return Response.json(await createPlan(who,String(input.args?.branchId||'targeted'),Number(input.args?.budgetMinor)||30_000,input.context?.snapshotHash));
    if(input.name==='boundary_check') {
      await audit(db,{...who,role:'investigator'},'authority.denied','Investigator role boundary verified',null,{action:'financial_execution',result:'denied'});
      return Response.json({allowed:false,role:'investigator',reason:'Read-only evidence access. Route a proposal to Planner. Execution needs an exact human-approved manifest.'});
    }
    throw new HttpError(404,'TOOL_UNAVAILABLE','This tool is not in the allowed investigation scope.');
  }
  if(key==='manifest' && method==='GET') {
    const plans=await plansFor(who);const plan=plans.find(p=>p.id===url.searchParams.get('planId'));
    if(!plan) throw new HttpError(404,'PLAN_NOT_FOUND','Choose a saved recovery manifest.');
    const csv=(v:unknown)=>'"'+String(v ?? '').replace(/^[=+@-]/,"'").replaceAll('"','""')+'"';
    const lines=[['Action','Order','Amount cents','Currency','Source','Resource','Eligibility','Reason'],...plan.branch.actions.map(a=>[a.kind,a.reference,a.amountMinor,a.currency,a.sourceClass,a.resourceId,a.eligibility,a.blockedReason])];
    return new Response(lines.map(row=>row.map(csv).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="glasshouse-${plan.id}.csv"`}});
  }
  throw new HttpError(404,'NOT_FOUND','This Glasshouse route is not available.');
}
export async function GET(request:Request,context:Params){try{return await dispatch(request,context);}catch(error){return problem(error);}}
export async function POST(request:Request,context:Params){try{return await dispatch(request,context);}catch(error){return problem(error);}}
export async function DELETE(request:Request,context:Params){try{return await dispatch(request,context);}catch(error){return problem(error);}}
