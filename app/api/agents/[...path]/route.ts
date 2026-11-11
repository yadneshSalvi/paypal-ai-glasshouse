import type {AgAiThread} from 'ag-studio';
import type {EnrollRun,NativeAcknowledgement,SubmitTurn,ToolClaim} from '@/packages/agents/contracts';
import {agentActor} from '@/lib/server/agents/security';
import {body,HttpError,problem,sameOrigin} from '@/lib/server/errors';
import {agentRuntime} from '@/lib/server/agents/runtime';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
type Params={params:Promise<{path:string[]}>};
async function dispatch(request:Request,context:Params){
  if(request.method!=='GET')sameOrigin(request);
  const who=await agentActor(request),{path}=await context.params,key=path.join('/'),app=await agentRuntime(),method=request.method,url=new URL(request.url);
  if(key==='status'&&method==='GET')return Response.json({runs:await app.journal.status(who,url.searchParams.get('threadId')??undefined),events:await app.journal.events(who),documents:await app.journal.db.transaction(tx=>app.tools.documents(tx,who)),modelMode:app.models.provider?.mode??'unavailable',toolkit:{installed:'1.11.0',enabled:!!app.tools.toolkit,mode:app.tools.toolkit?.mode??'unqualified'},encrypted:true});
  if(key==='runs'&&method==='POST')return Response.json(await app.journal.enroll(who,await body<EnrollRun>(request)));
  if(path[0]==='runs'&&path[1]&&method==='POST'){
    const input=await body<{clientId:string;action?:'complete'|'hold'|'cancel'}>(request);
    if(path[2]==='heartbeat')return Response.json(await app.journal.heartbeat(who,path[1],input.clientId));
    if(path[2]==='finish'&&input.action&&['complete','hold','cancel'].includes(input.action))return Response.json(await app.journal.finish(who,path[1],input.clientId,input.action));
  }
  if(key==='turns'&&method==='POST')return Response.json(await app.models.submit(who,await body<SubmitTurn>(request)));
  if(path[0]==='turns'&&path[1]&&path[2]&&/^\d+$/.test(path[2])){
    if(method==='GET')return Response.json(await app.models.read(who,path[1],Number(path[2])));
    if(method==='POST'&&path[3]==='step'){const input=await body<{clientId:string}>(request);return Response.json(await app.models.step(who,path[1],Number(path[2]),input.clientId));}
  }
  if(key==='tools/claim'&&method==='POST')return Response.json(await app.tools.claim(who,await body<ToolClaim>(request)));
  if(key==='tools/acknowledge'&&method==='POST')return Response.json(await app.tools.acknowledge(who,await body<NativeAcknowledgement>(request)));
  if(path[0]==='threads'){
    if(method==='GET'&&!path[1])return Response.json(await app.threads.list(who));
    if(method==='GET')return Response.json(await app.threads.load(who,path[1]));
    if(method==='POST'&&path[1])return Response.json(await app.threads.save(who,path[1],await body<{thread:AgAiThread;expectedVersion:number}>(request)));
    if(method==='DELETE'&&path[1])return Response.json(await app.threads.remove(who,path[1]));
  }
  throw new HttpError(404,'AGENT_ROUTE_NOT_FOUND','This agent operation is not available.');
}
export async function GET(request:Request,context:Params){try{return await dispatch(request,context);}catch(error){return problem(error);}}
export async function POST(request:Request,context:Params){try{return await dispatch(request,context);}catch(error){return problem(error);}}
export async function DELETE(request:Request,context:Params){try{return await dispatch(request,context);}catch(error){return problem(error);}}
