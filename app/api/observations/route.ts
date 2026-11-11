import { after } from 'next/server';
import { actor } from '@/lib/server/auth';
import { body, HttpError, problem, sameOrigin } from '@/lib/server/errors';
import { recoveryMember } from '@/lib/server/recovery/authority';
import { observationRuntime } from '@/lib/server/observations/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function GET(request: Request) {
  try { return Response.json(await (await observationRuntime()).service.overview(await actor(request)),{headers:{'Cache-Control':'no-store'}}); }
  catch (error) { return problem(error); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const who = await actor(request), runtime = await observationRuntime();
    await recoveryMember(runtime.service.db,who);
    const worker = runtime.worker;
    if (!worker) throw new HttpError(503,'INDEPENDENT_READS_UNAVAILABLE','Connect the isolated sandbox before requesting current provider reads.');
    const input = await body<{action?:string;planId?:string;operationId?:string}>(request);
    let result: unknown;
    if (input.action === 'continue') result = {accepted:true,readOnly:true};
    else if (input.action === 'retry') result = await runtime.service.retryHeld(who);
    else {
      if (typeof input.planId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.planId) ||
        input.operationId !== undefined && (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId))) throw new HttpError(400,'SAVED_RECOVERY_REQUIRED','Select an existing saved recovery to check.');
      result = await runtime.service.enqueueStatus(who,input.planId,input.operationId);
    }
    after(async () => { try {await worker.drain({tenantId:who.tenantId,limit:40});} catch {console.error('[glasshouse] Independent read worker interrupted; saved jobs remain recoverable.');} });
    return Response.json(result,{status:202,headers:{'Cache-Control':'no-store'}});
  } catch (error) { return problem(error); }
}
