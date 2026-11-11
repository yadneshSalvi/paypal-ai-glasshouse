import {actor,assertRequestCurrent} from '@/lib/server/auth';
import {body,HttpError,problem,sameOrigin} from '@/lib/server/errors';
import {reportRuntime} from '@/lib/server/reports/runtime';
import type {ReportPaper} from '@/packages/reports/types';

export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=120;
type Params={params:Promise<{path?:string[]}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
async function handle(request:Request,context:Params){try{
  if(request.method!=='GET')sameOrigin(request);
  const who=await actor(request),service=await reportRuntime(),path=(await context.params).path??[],search=new URL(request.url).searchParams;
  if(!path.length&&request.method==='POST'){const result=await service.create(who,await body(request));await assertRequestCurrent(request);return Response.json(result,{headers});}
  if(request.method!=='GET')throw new HttpError(405,'REPORT_READ_ONLY','Saved report editions are immutable. Create a new edition to record a change.');
  if(!path.length){const result=await service.list(who,search.get('cursor')??undefined);await assertRequestCurrent(request);return Response.json(result,{headers});}
  if(path.length===1){const result=await service.read(who,path[0]);await assertRequestCurrent(request);return Response.json(result,{headers});}
  if(path.length===2&&path[1]==='json'){
    const result=await service.read(who,path[0]);await assertRequestCurrent(request);
    return new Response(JSON.stringify(result,null,2)+'\n',{headers:{...headers,'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="glasshouse-${result.document.id}.json"`,'X-Glasshouse-Document-Hash':result.summary.documentHash}});
  }
  if(path.length===2&&path[1]==='pdf'){
    const result=await service.pdf(who,path[0],(search.get('paper')??'A4') as ReportPaper);await assertRequestCurrent(request);
    return new Response(new Uint8Array(result.bytes),{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="glasshouse-${path[0].replace(/[^A-Za-z0-9_-]/g,'')}-${result.paper}.pdf"`,'X-Glasshouse-Pdf-Hash':result.hash,'X-Glasshouse-Pdf-Pages':String(result.pages),'X-Glasshouse-Renderer':result.rendererVersion}});
  }
  throw new HttpError(404,'REPORT_ROUTE_NOT_FOUND','This report view is not available.');
}catch(error){const response=problem(error);for(const [key,value] of Object.entries(headers))response.headers.set(key,value);return response;}}
export const GET=handle;export const POST=handle;
