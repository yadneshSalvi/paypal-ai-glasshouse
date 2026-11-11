import {after} from 'next/server';
import {z} from 'zod';
import {actor,assertRequestCurrent} from '@/lib/server/auth';
import {body,HttpError,problem,sameOrigin} from '@/lib/server/errors';
import {reportingRuntime} from '@/lib/server/reporting/runtime';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=120;
const input=z.discriminatedUnion('action',[
 z.object({action:z.literal('start'),requestId:z.uuid(),start:z.iso.datetime(),end:z.iso.datetime()}).strict(),
 z.object({action:z.literal('cancel'),id:z.uuid()}).strict(),z.object({action:z.literal('continue')}).strict(),
]);
export async function GET(request:Request){try{const who=await actor(request),service=await reportingRuntime(),query=new URL(request.url).searchParams;
 const id=query.get('runId');if(id&&!z.uuid().safeParse(id).success)throw new HttpError(400,'REPORTING_RUN_INVALID','Select a saved reporting scan.');
 const result=id?await service.evidence(who,id,Number(query.get('page')??1)):await service.overview(who);await assertRequestCurrent(request);return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});}catch(e){return problem(e);}}
export async function POST(request:Request){try{sameOrigin(request);const who=await actor(request),parsed=input.safeParse(await body(request));if(!parsed.success)throw new HttpError(400,'REPORTING_REVIEW_REQUIRED','Select a valid reporting scan and UTC dates.');const service=await reportingRuntime();let result:unknown;
 if(parsed.data.action==='start')result=await service.start(who,parsed.data);else if(parsed.data.action==='cancel')result=await service.cancel(who,parsed.data.id);else{await service.overview(who);result={accepted:true,readOnly:true};}
 await assertRequestCurrent(request);
 if(parsed.data.action!=='cancel')after(async()=>{try{await service.drain({tenantId:who.tenantId,limit:8});}catch{console.error('[glasshouse] Reporting read interrupted; checkpoint retained.');}});
 return Response.json(result,{status:202,headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return problem(e);}}
