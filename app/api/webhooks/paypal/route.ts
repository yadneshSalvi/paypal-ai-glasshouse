import { after } from 'next/server';
import { observationRuntime } from '@/lib/server/observations/runtime';
import { rawWebhook } from '@/lib/server/observations/webhook';
import { HttpError, problem } from '@/lib/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const runtime = await observationRuntime();
    if (!runtime.connector || !runtime.verifier || !runtime.worker) throw new HttpError(503,'REGISTERED_WEBHOOK_REQUIRED','The isolated merchant webhook registration is not configured.');
    const worker = runtime.worker;
    const raw = await rawWebhook(request);
    const receipt = await runtime.service.receive(runtime.connector,runtime.verifier,raw,request.headers);
    // Acceptance depends on the committed inbox/outbox, never on a serverless process surviving.
    if (receipt.outcome === 'queued') after(async () => { try {await worker.drain({tenantId:runtime.connector!.tenantId,limit:10});} catch {console.error('[glasshouse] Notification read worker interrupted; accepted events remain recoverable.');} });
    return Response.json(receipt,{status:202,headers:{'Cache-Control':'no-store'}});
  } catch (error) { return problem(error); }
}
