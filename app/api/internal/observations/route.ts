import { timingSafeEqual } from 'node:crypto';
import { observationRuntime } from '@/lib/server/observations/runtime';
import { HttpError, problem } from '@/lib/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 240;
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET, provided = request.headers.get('authorization')?.replace(/^Bearer /,'') ?? '';
  if (!expected || Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided),Buffer.from(expected))) return Response.json({error:'Scheduler authorization required.'},{status:401});
  try {
    const worker = (await observationRuntime()).worker;
    if (!worker) throw new HttpError(503,'INDEPENDENT_READS_UNAVAILABLE','The isolated sandbox read connector is unavailable.');
    return Response.json(await worker.drain({limit:40,signal:request.signal}),{headers:{'Cache-Control':'no-store'}});
  }
  catch (error) { return problem(error); }
}
