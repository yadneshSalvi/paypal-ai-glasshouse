import {timingSafeEqual} from 'node:crypto';
import {reportingRuntime} from '@/lib/server/reporting/runtime';
import {problem} from '@/lib/server/errors';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=120;
export async function GET(request:Request){const expected=process.env.CRON_SECRET,provided=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
 if(!expected||Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return Response.json({error:'Scheduler authorization required.'},{status:401});
 try{return Response.json(await(await reportingRuntime()).drain({limit:4}),{headers:{'Cache-Control':'no-store'}});}catch(e){return problem(e);}}
