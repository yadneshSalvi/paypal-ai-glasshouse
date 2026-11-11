import { database } from '@/packages/db/client';
import { actor, startSession } from '@/lib/server/auth';
import { body, problem, HttpError, sameOrigin } from '@/lib/server/errors';
import { snapshotFor } from '@/lib/server/snapshots';
import { audit, auditFor, hash, operationsFor, plansFor } from '@/lib/server/repository';
import { approvePlan, createPlan, enqueuePlan, reviseEvidence } from '@/lib/server/plans';
import { capabilities } from '@/lib/server/capabilities';
import {agentRuntime} from '@/lib/server/agents/runtime';
import {agentActor} from '@/lib/server/agents/security';
import type {AgentLayoutReceipt} from '@/packages/agents/contracts';
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
      const input=await body<{history:unknown;expectedVersion:number;label?:string;agentMutation?:AgentLayoutReceipt}>(request);
      const agents=input.agentMutation?await agentRuntime():null;
      return Response.json(await saveLayout(db,agents?await agentActor(request):who,input,agents?(...args)=>agents.tools.commitLayout(...args):undefined));
    }
  }
  if(path[0]==='threads'||key==='ai/turn'||key==='agent/tool'||key==='agent/events'&&method==='POST')throw new HttpError(410,'DURABLE_AGENT_ROUTE_REQUIRED','Reload Glasshouse to use the server-authorized durable investigation runtime.');
  if(key==='agent/events'&&method==='GET')return Response.json(process.env.GLASSHOUSE_AGENT_KEY||process.env.GLASSHOUSE_PAYMENT_KEY?await (await agentRuntime()).journal.events(await agentActor(request)):[]);
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
