import {actor,assertRequestCurrent} from '@/lib/server/auth';
import {body,HttpError,problem,sameOrigin} from '@/lib/server/errors';
import {findingRuntime} from '@/lib/server/findings/runtime';

export const runtime='nodejs';export const dynamic='force-dynamic';
type Params={params:Promise<{path?:string[]}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
async function handle(request:Request,context:Params){try{
  if(request.method!=='GET')sameOrigin(request);
  const who=await actor(request),service=await findingRuntime(),path=(await context.params).path??[],search=new URL(request.url).searchParams;
  let result:unknown;
  if(!path.length&&request.method==='GET')result=await service.list(who,search.get('cursor')??undefined);
  else if(!path.length&&request.method==='POST')result=await service.create(who,await body(request));
  else if(path.length===1&&path[0]==='adopt'&&request.method==='POST')result=await service.adopt(who,await body(request));
  else if(path.length===1&&request.method==='GET')result=await service.detail(who,path[0],search.get('revision')??undefined);
  else if(path.length===2&&path[1]==='decisions'&&request.method==='POST')result=await service.decide(who,path[0],await body(request));
  else if(path.length===2&&path[1]==='share'&&request.method==='POST')result=await service.share(who,path[0],await body(request));
  else if(path.length===2&&path[1]==='json'&&request.method==='GET'){
    const detail=await service.detail(who,path[0],search.get('revision')??undefined);await assertRequestCurrent(request);
    return new Response(JSON.stringify(detail.revision,null,2)+'\n',{headers:{...headers,'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="glasshouse-${detail.revision.id}.json"`,'X-Glasshouse-Finding-Hash':detail.revision.hash}});
  }else throw new HttpError(404,'FINDING_ROUTE_NOT_FOUND','This finding view is not available.');
  await assertRequestCurrent(request);return Response.json(result,{headers});
}catch(error){const response=problem(error);for(const [key,value] of Object.entries(headers))response.headers.set(key,value);return response;}}
export const GET=handle;export const POST=handle;
