import {randomBytes,randomUUID} from 'node:crypto';
import type {Response as ModelResponse} from 'openai/resources/responses/responses';
import type {AgAiRunInput,AgAiToolSchema,AgLlmRequest} from 'ag-studio';
import type {Database} from '../../packages/db/client';
import type {Actor,Snapshot} from '../../packages/domain/types';

// This runs before any application import or database construction. Tests cannot
// silently inherit an original or hosted provider connection.
for(const name of ['OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET'])if(process.env[name])throw new Error('Agent tests require blank inherited provider credentials.');
if(process.env.GLASSHOUSE_AGENTS_TEST_PG==='true'){
  const url=new URL(process.env.DATABASE_URL??'');
  const legacy=/^\/gh_agents_stage5_[a-f0-9]{12}$/.test(url.pathname)&&/^ghas5_[a-f0-9]{12}$/.test(url.username)&&process.env.GLASSHOUSE_AGENT_ISOLATED_QA===url.pathname.slice(1);
  const finding=/^\/gh_findings_stage9_[a-f0-9]{12}$/.test(url.pathname)&&/^ghfind9_[a-f0-9]{12}$/.test(url.username)&&process.env.GLASSHOUSE_FINDING_ISOLATED_QA===url.pathname.slice(1)&&process.env.PORT==='4541';
  if(!['localhost','127.0.0.1'].includes(url.hostname)||!legacy&&!finding)throw new Error('Agent tests refuse a database without the exact isolated qualification identity.');
}else if(process.env.DATABASE_URL)throw new Error('Agent unit tests refuse an inherited database connection.');

process.env.GLASSHOUSE_FINDING_KEY??=randomBytes(32).toString('base64');
const {schema}=await import('../../packages/db/schema');
const {ensurePaymentsSchema}=await import('../../lib/server/payments/schema');
const {ensureRecoverySchema}=await import('../../lib/server/recovery/schema');
const {ensureWorkspacesSchema}=await import('../../lib/server/workspaces/schema');
const {ensureReportsSchema}=await import('../../lib/server/reports/schema');
const {ensureFindingsSchema}=await import('../../lib/server/findings/schema');
const {ensureAgentsSchema}=await import('../../lib/server/agents/schema');
const {createSeedDataset,buildSnapshot}=await import('../../packages/domain');
const {persistDataset}=await import('../../lib/server/repository');
const {snapshotContext}=await import('../../lib/server/snapshots');
const {AgentSecrets}=await import('../../lib/server/agents/security');
const {AgentJournal}=await import('../../lib/server/agents/journal');
const {AgentModels}=await import('../../lib/server/agents/model-service');
const {OpenAIBackgroundProvider}=await import('../../lib/server/agents/provider');
const {AgentTools}=await import('../../lib/server/agents/tools');
const {AgentThreads}=await import('../../lib/server/agents/threads');
type NativeOutput=ModelResponse['output'];
export class ModelFixture {
  creates:Record<string,unknown>[]=[];gets:string[]=[];outputs:NativeOutput[]=[];
  responses=new Map<string,ModelResponse>();unknown=false;queued=false;malformed=false;reportedStore=true;
  onCreate:(()=>Promise<void>)|null=null;onRetrieve:(()=>Promise<void>)|null=null;
  fetch:typeof fetch=async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url);
    if(url.origin!=='https://api.openai.com')throw new Error('External model transport refused by fixture.');
    if(request.method==='POST'){
      if(url.pathname!=='/v1/responses')throw new Error('Unexpected fixture POST');
      const body=await request.json();this.creates.push(body);await this.onCreate?.();
      if(this.unknown)throw new Error('Synthetic response lost after dispatch');
      const id=`resp_fixture_${this.creates.length}_${randomBytes(4).toString('hex')}`;
      const value={id,object:'response',created_at:1794400000,status:this.queued?'queued':'completed',model:String(body.model),output:this.outputs.shift()??[message('Fixture grounded answer.')],usage:{input_tokens:20,output_tokens:12,total_tokens:32},background:true,store:this.reportedStore} as unknown as ModelResponse;
      this.responses.set(id,value);
      return this.json(this.malformed?{...value,output:null}:value);
    }
    if(request.method==='GET'&&url.pathname.startsWith('/v1/responses/')){
      const id=url.pathname.split('/').at(-1)!;this.gets.push(id);await this.onRetrieve?.();
      const response=this.responses.get(id);if(!response)return this.json({error:{message:'Missing exact fixture ID',type:'invalid_request_error'}},404);
      return this.json({...response,status:'completed'});
    }
    throw new Error('Unexpected model fixture method');
  };
  private json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
}
export const message=(text:string)=>({id:`msg_provider_${randomBytes(6).toString('hex')}`,type:'message' as const,role:'assistant' as const,status:'completed' as const,content:[{type:'output_text' as const,text,annotations:[],logprobs:[]}]});
export const functionCall=(name:string,args:Record<string,unknown>,id=`call_${randomBytes(8).toString('hex')}`)=>({type:'function_call' as const,id:`fc_${id}`,call_id:id,name,arguments:JSON.stringify(args),status:'completed' as const});
export const tool=(name:string,parameters:Record<string,unknown>={type:'object',properties:{},additionalProperties:false}):AgAiToolSchema=>({name,description:`Synthetic native schema for ${name}`,parameters,kind:'client'});
export const request=(tools:AgAiToolSchema[],choice?:AgLlmRequest['toolChoice']):AgLlmRequest=>({input:[],instructions:'UNTRUSTED_BROWSER_INSTRUCTIONS',tools,responseFormat:{type:'text'},toolChoice:choice});
export const nativeInput=(prompt='Investigate the source evidence.',extra:Partial<AgAiRunInput>={}):AgAiRunInput=>({threadId:`thread-${randomUUID()}`,runId:`run-${randomUUID()}`,messages:[{id:`msg-${randomUUID()}`,role:'user',content:prompt}],tools:[],state:{},context:[],forwardedProps:{},...extra});
export async function agentHarness(){
  let db:Database,dispose:()=>Promise<void>;
  if(process.env.GLASSHOUSE_AGENTS_TEST_PG==='true'){
    const {default:postgres}=await import('postgres');
    const name=`agent_test_${randomBytes(8).toString('hex')}`;
    const admin=postgres(process.env.DATABASE_URL!,{max:1,prepare:false,onnotice:()=>{}});
    await admin.unsafe(`CREATE SCHEMA ${name}`);
    const sql=postgres(process.env.DATABASE_URL!,{max:8,prepare:false,onnotice:()=>{},connection:{search_path:name}});
    const adapt=(client:typeof sql):Database=>({
      async query<T extends Record<string,unknown>>(text:string,values:unknown[]=[]){const params=values.map((value,index)=>typeof value==='string'&&new RegExp('\\$'+(index+1)+'\\s*::\\s*jsonb\\b','i').test(text)?JSON.parse(value):value);return await client.unsafe(text,params as never[]) as unknown as T[];},
      async transaction<T>(work:(tx:Database)=>Promise<T>){return await client.begin(tx=>work(adapt(tx as unknown as typeof sql))) as T;},
    });db=adapt(sql);dispose=async()=>{await sql.end();await admin.unsafe(`DROP SCHEMA ${name} CASCADE`);await admin.end();};
  }else{
    const {PGlite}=await import('@electric-sql/pglite');const pg=new PGlite();
    const adapt=(client:Pick<typeof pg,'query'>):Database=>({query:async<T extends Record<string,unknown>>(sql:string,values:unknown[]=[])=> (await client.query<T>(sql,values)).rows,transaction:work=>pg.transaction(tx=>work(adapt(tx)))});
    db=adapt(pg);dispose=()=>pg.close();
  }
  for(const sql of schema.split(';').map(value=>value.trim()).filter(Boolean))await db.query(sql);
  await ensurePaymentsSchema(db);await ensureRecoverySchema(db);await ensureAgentsSchema(db);await ensureWorkspacesSchema(db);await ensureReportsSchema(db);await ensureFindingsSchema(db);
  const who:Actor&{agentSessionHash:string}={tenantId:`agents-fixture-${randomUUID()}`,id:'fixture-reviewer',role:'judge',membershipVersion:1,agentSessionHash:randomBytes(32).toString('hex')};
  const {agentSessionHash,...sessionActor}=who;
  await db.query("INSERT INTO gh_sessions(token_hash,actor,expires_at) VALUES($1,$2::jsonb,now()+interval '1 hour')",[agentSessionHash,JSON.stringify(sessionActor)]);
  await db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,$4)',[who.tenantId,who.id,who.role,who.membershipVersion]);
  const dataset=createSeedDataset(who.tenantId);await persistDataset(db,dataset);
  const saveSnapshot=async(value:Snapshot)=>{await db.query('INSERT INTO gh_snapshots(tenant_id,id,hash,context,table_hashes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT DO NOTHING',[who.tenantId,value.id,value.hash,JSON.stringify(value.context),JSON.stringify(value.tableHashes)]);return value;};
  const snapshot=await saveSnapshot(buildSnapshot(dataset,snapshotContext(who,dataset)));
  const key=randomBytes(32).toString('base64'),secrets=new AgentSecrets(key),journal=new AgentJournal(db,secrets),fixture=new ModelFixture(),provider=new OpenAIBackgroundProvider('fixture-only-model-key','synthetic',fixture.fetch),models=new AgentModels(journal,provider),tools=new AgentTools(journal,null),threads=new AgentThreads(journal);
  const clientId=`client-${randomUUID()}`,indexes=new Map<string,number>();
  const begin=async(prompt?:string)=>{const input=nativeInput(prompt);const enrolled=await journal.enroll(who,{input,agentId:'coordinator',snapshotHash:snapshot.hash,clientId});return {...enrolled,input};};
  const issue=async(runId:string,schemas:AgAiToolSchema[],output:NativeOutput,choice?:AgLlmRequest['toolChoice'])=>{
    const index=indexes.get(runId)??0;fixture.outputs.push(output);await models.submit(who,{runId,index,request:request(schemas,choice),clientId,snapshotHash:snapshot.hash});const result=await models.step(who,runId,index,clientId);indexes.set(runId,index+1);return result;
  };
  const handoff=async(parent:Awaited<ReturnType<typeof begin>>,target:'investigator'|'planner'|'operator'|'writer'|'page'|'widget'|'planning',params:Record<string,unknown>={})=>{
    const args={type:{id:target,...params},instructions:`Run the synthetic ${target} qualification task.`};
    const call=functionCall('delegate_to',args);
    await issue(parent.run.id,[tool('delegate_to',{type:'object',properties:{type:{type:'object',properties:{id:{type:'string'},...Object.fromEntries(Object.keys(params).map(key=>[key,{type:'string'}]))},required:['id'],additionalProperties:false},instructions:{type:'string'}},required:['type','instructions'],additionalProperties:false})],[call]);
    const grant=await tools.claim(who,{runId:parent.run.id,callId:call.call_id,name:call.name,args,clientId,snapshotHash:snapshot.hash});
    const input=nativeInput(args.instructions,{threadId:`${call.call_id}-sub`,parentRunId:parent.run.id,parentToolCallId:call.call_id});
    const enrolled=await journal.enroll(who,{input,agentId:target,params,snapshotHash:snapshot.hash,clientId});return {...enrolled,input,parentCall:call,parentGrant:grant};
  };
  return {db,dispose,who,dataset,snapshot,saveSnapshot,key,secrets,journal,fixture,provider,models,tools,threads,clientId,begin,issue,handoff,indexes};
}
