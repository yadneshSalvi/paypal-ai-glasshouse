import { timingSafeEqual } from 'node:crypto';
import { paymentsRuntime } from '@/lib/server/payments/runtime';
import { problem } from '@/lib/server/errors';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;

export async function GET(request:Request) {
  const expected=process.env.CRON_SECRET;
  const provided=request.headers.get('authorization')?.replace(/^Bearer /,'') ?? '';
  if(!expected || Buffer.byteLength(provided)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided),Buffer.from(expected))) return Response.json({error:'Scheduler authorization required.'},{status:401});
  try {
    const {executor}=await paymentsRuntime();
    if(!executor)return Response.json({processed:0,reason:'sandbox_not_configured'});
    return Response.json(await executor.drain({limit:60,concurrency:4,signal:request.signal}));
  } catch(error){return problem(error);}
}
