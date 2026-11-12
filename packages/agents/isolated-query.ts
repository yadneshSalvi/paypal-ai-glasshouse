'use client';
import {AgStudioAiModule,createStudio,type AgAiToolContext,type AgAiToolInvocation,type AgAiToolResult,type AgDataSourcesDefinition,type AgStudioApi} from 'ag-studio';

/** Query tools use the installed Studio resolver and executor, but own their
 * engine. Studio 3.1 can return success while also reporting a fatal query
 * validation event; neither that event nor a malformed read may poison the
 * merchant's interactive report or its save/history admission.
 */
export async function executeIsolatedQuery(data:AgDataSourcesDefinition,call:AgAiToolInvocation,context:AgAiToolContext):Promise<AgAiToolResult>{
  if(context.signal.aborted)return context.error('The query was cancelled before execution.');
  const host=document.createElement('div'),issues:string[]=[];
  let engineIssueCount=0;
  const validation=(event:unknown)=>{
    if(event&&typeof event==='object'&&'issues'in event&&Array.isArray(event.issues))engineIssueCount+=event.issues.length;
  };
  let api:AgStudioApi|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let ready!:()=>void,fail!:(reason:Error)=>void;
  const initialized=new Promise<void>((resolve,reject)=>{ready=resolve;fail=reject;});
  const abort=()=>fail(new Error('The query was cancelled before execution.'));
  context.signal.addEventListener('abort',abort,{once:true});
  try{
    api=createStudio(host,{
      studioId:`isolated-agent-query-${crypto.randomUUID()}`,data,loadThemeGoogleFonts:false,mode:'view',
      initialState:{pages:[{id:'query',layout:{type:'widget'},widgets:{},widgetLayout:{}}],selectedPageId:'query'},
      panels:{edit:{right:[]},view:{right:[]}},
      onStudioReady:()=>queueMicrotask(ready),
      onErrorRaised:event=>{if(event.fatal)issues.push(...event.errorDetails);},
    },{modules:[AgStudioAiModule]});
    timer=setTimeout(()=>fail(new Error('The isolated query engine did not become ready.')),10_000);
    await initialized;clearTimeout(timer);timer=undefined;
    api.getDataEngine()?.addEventListener?.('validation',validation,false);
    if(context.signal.aborted)return context.error('The query was cancelled before execution.');
    if(issues.length)return context.error(issues);
    const query=api.getAiTools().executeQuery();
    if(!query.execute)return context.error('The installed native query executor is unavailable.');
    const result=await query.execute(call,context);
    // Public Studio events are queued on its next event-loop turn. Keep this
    // private engine alive until those messages have arrived; synchronous engine
    // validation also guards against a successful result with delayed diagnostics.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    if(engineIssueCount&&!issues.length)issues.push('The native engine reported an invalid query. Simplify its fields and aggregations.');
    if(issues.length)return context.error([...new Set(issues)].slice(0,8).map(message=>`Query refused: ${message.slice(0,1500)} The saved workspace is unchanged. Correct this query before trying again.`));
    return result;
  }catch(error){
    return context.error(`Query not completed: ${error instanceof Error?error.message:'native validation failed'}. The saved workspace is unchanged.`);
  }finally{
    if(timer)clearTimeout(timer);
    context.signal.removeEventListener('abort',abort);
    api?.getDataEngine()?.removeEventListener?.('validation',validation,false);
    api?.destroy();host.remove();
  }
}
