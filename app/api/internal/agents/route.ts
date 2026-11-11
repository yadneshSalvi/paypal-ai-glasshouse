import {timingSafeEqual} from 'node:crypto';
import {agentRuntime} from '@/lib/server/agents/runtime';
import {HttpError,problem} from '@/lib/server/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function GET(request:Request){
  try{
    const expected=process.env.CRON_SECRET,actual=request.headers.get('authorization');
    if(process.env.GLASSHOUSE_AGENT_WORKER_ENABLED!=='true'||!expected||!actual||Buffer.byteLength(actual)!==Buffer.byteLength(`Bearer ${expected}`)||!timingSafeEqual(Buffer.from(actual),Buffer.from(`Bearer ${expected}`)))throw new HttpError(403,'AGENT_WORKER_DENIED','This model-only worker requires its configured scheduler authority.');
    return Response.json(await (await agentRuntime()).models.drain(4));
  }catch(error){return problem(error);}
}
