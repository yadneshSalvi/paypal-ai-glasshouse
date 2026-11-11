import { timingSafeEqual } from 'node:crypto';
import { recoveryRuntime } from '@/lib/server/recovery/runtime';
import { problem } from '@/lib/server/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=240;
export async function GET(request:Request){
  const expected=process.env.CRON_SECRET,provided=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
  if(!expected||Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return Response.json({error:'Scheduler authorization required.'},{status:401});
  try{return Response.json(await(await recoveryRuntime()).recoveryExecutor.drain({limit:20,concurrency:2,signal:request.signal}));}catch(error){return problem(error);}
}
