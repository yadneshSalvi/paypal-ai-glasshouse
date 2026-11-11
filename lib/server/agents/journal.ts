import {randomUUID} from 'node:crypto';
import type {AgAiRunInput,AgAiToolResult,AgAiToolSchema,AgLlmResponse} from 'ag-studio';
import type {Response,ResponseCreateParamsNonStreaming} from 'openai/resources/responses/responses';
import type {Database} from '@/packages/db/client';
import type {Actor,AgentRunEvent,Snapshot} from '@/packages/domain/types';
import type {AgentId,EnrollRun,EnrolledRun,RunState,RunView,ToolState,TurnState} from '@/packages/agents/contracts';
import {hash} from '../repository';
import {HttpError} from '../errors';
import {agentId,validateCall} from './registry';
import {AgentSecrets,agentMember,agentSnapshot,bounded,safeId,ownedToolkitResource,agentSessionHash} from './security';
import {modelOutcome} from './model-outcome';

export interface RunDocument {input:AgAiRunInput;params?:unknown;prompt:string;promptId:string;actor:Actor;parentTask?:unknown}
export interface RunRow extends Record<string,unknown> {tenant_id:string;id:string;thread_id:string;user_message_id:string;actor_id:string;membership_version:number;agent_id:AgentId;parent_run_id:string|null;parent_tool_call_id:string|null;snapshot_hash:string;state:RunState;reason:string|null;private_document:string;lease_owner:string|null;lease_until:string|null;updated_at:string}
export interface TurnDocument {request:ResponseCreateParamsNonStreaming;tools:AgAiToolSchema[];providerId?:string;provider?:Response;response?:AgLlmResponse;retrievalUnavailable?:{status:number;observedAt:string}}
export interface TurnRow extends Record<string,unknown>{tenant_id:string;run_id:string;turn_index:number;state:TurnState;request_hash:string;private_document:string;has_provider_id:boolean;provider_stored:boolean|null;dispatch_count:number;lease_owner:string|null;lease_until:string|null;reason:string|null}
export interface ToolDocument {args:Record<string,unknown>;result?:AgAiToolResult;executionOwner?:string;beforeLayoutHash?:string;beforeLayoutVersion?:number;historyEntryIds?:string[];resourceHash?:string}
export interface ToolRow extends Record<string,unknown>{tenant_id:string;id:string;run_id:string;turn_index:number;name:string;input_hash:string;transport:string;state:ToolState;private_document:string;dispatch_count:number;lease_token:string|null;mutation_id:string|null;layout_version:number|null;layout_hash:string|null;reason:string|null}

export class AgentJournal {
  constructor(readonly db:Database,readonly secrets:AgentSecrets){}
  runDocument(row:RunRow){return this.secrets.open<RunDocument>(row.tenant_id,'run',row.id,row.private_document);}
  turnDocument(row:TurnRow){return this.secrets.open<TurnDocument>(row.tenant_id,'turn',`${row.run_id}:${row.turn_index}`,row.private_document);}
  toolDocument(row:ToolRow){return this.secrets.open<ToolDocument>(row.tenant_id,'tool',row.id,row.private_document);}
  async checkReadGrants(tx:Database,actor:Actor,runId:string,snapshot:Snapshot){
    const reads=await tx.query<ToolRow>(`WITH RECURSIVE family(id) AS (
      SELECT id FROM gh_agent_runs WHERE tenant_id=$1 AND id=$2
      UNION ALL SELECT r.id FROM gh_agent_runs r JOIN family f ON r.parent_run_id=f.id WHERE r.tenant_id=$1
    ) SELECT c.* FROM gh_agent_tool_calls c JOIN family f ON f.id=c.run_id
    WHERE c.tenant_id=$1 AND c.name LIKE 'paypal_%' AND c.state='completed'`,[actor.tenantId,runId]);
    for(const read of reads){
      const doc=this.toolDocument(read);
      if(doc.result?.success&&doc.resourceHash&&hash(await ownedToolkitResource(tx,actor,snapshot,String(doc.args.orderId),doc.args.disputeId as string|undefined,read.name==='paypal_list_disputes'))!==doc.resourceHash)throw new HttpError(409,'TOOLKIT_GRANT_CHANGED','A resource grant used by this saved investigation changed. Its private result cannot be reused by a model.');
    }
  }
  async run(tx:Database,actor:Actor,id:string,lock=false){
    const row=(await tx.query<RunRow>(`SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[actor.tenantId,safeId(id,'run')]))[0];
    if(!row||row.actor_id!==actor.id)throw new HttpError(404,'AGENT_RUN_NOT_FOUND','This investigation does not belong to the current session.');
    await agentMember(tx,actor,row.membership_version);
    if(agentSessionHash(this.runDocument(row).actor)!==agentSessionHash(actor))throw new HttpError(403,'AGENT_SESSION_IDENTITY','This run belongs to its original authorizing session. Its private dispatch identity cannot be replaced.');
    return row;
  }
  async ownRun(tx:Database,actor:Actor,id:string,clientId:string,allowCompleted=false){
    const row=await this.run(tx,actor,id,true);
    if(row.lease_owner!==safeId(clientId,'client')||!row.lease_until||Date.parse(row.lease_until)<=Date.now())throw new HttpError(409,'AGENT_RUN_LEASE','This run is being held by another tab or needs to be resumed.');
    if(row.state!=='running'&&!(allowCompleted&&row.state==='completed'))throw new HttpError(409,'AGENT_RUN_HELD',row.reason||'This saved run is no longer active.');
    await tx.query("UPDATE gh_agent_runs SET lease_until=now()+interval '35 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2",[actor.tenantId,id]);
    return row;
  }
  async event(tx:Database,run:RunRow,kind:string,key:string,summary:string,status:AgentRunEvent['resultStatus'],transport:AgentRunEvent['transportKind']='application',toolName:string|null=null,inputHash=''){
    const id=hash({run:run.id,kind,key});
    const event:AgentRunEvent={eventId:id,runId:run.id,parentRunId:run.parent_run_id,agentId:run.agent_id,eventType:kind,toolName,transportKind:transport,inputHash,redactedResultRef:key,resultStatus:status,sourceContextHash:run.snapshot_hash,timestamp:new Date().toISOString(),summary};
    await tx.query('INSERT INTO gh_agent_durable_events(tenant_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[run.tenant_id,id,run.id,JSON.stringify(event)]);
  }
  async view(tx:Database,run:RunRow):Promise<RunView>{
    const turns=await tx.query<Pick<TurnRow,'turn_index'|'state'|'has_provider_id'|'provider_stored'|'dispatch_count'>&{failure_document:string|null}>("SELECT turn_index,state,has_provider_id,provider_stored,dispatch_count,CASE WHEN state='failed' THEN private_document ELSE NULL END AS failure_document FROM gh_agent_model_turns WHERE tenant_id=$1 AND run_id=$2 ORDER BY turn_index",[run.tenant_id,run.id]);
    const tools=await tx.query<Pick<ToolRow,'id'|'name'|'state'|'transport'|'layout_version'>>('SELECT id,name,state,transport,layout_version FROM gh_agent_tool_calls WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,id',[run.tenant_id,run.id]);
    const terminal=await this.hasTerminalModel(tx,run);
    return {id:run.id,threadId:run.thread_id,agentId:run.agent_id,parentRunId:run.parent_run_id,parentToolCallId:run.parent_tool_call_id,snapshotHash:run.snapshot_hash,state:run.state,reason:run.reason,updatedAt:new Date(run.updated_at).toISOString(),canResume:!terminal&&run.state!=='completed'&&run.state!=='cancelled'&&(!run.lease_until||Date.parse(run.lease_until)<=Date.now()),modelTurns:turns.map(t=>({index:t.turn_index,state:t.state,hasProviderId:t.has_provider_id,dispatchCount:t.dispatch_count,providerStored:t.provider_stored,...(t.failure_document?{outcome:modelOutcome(this.secrets.open<TurnDocument>(run.tenant_id,'turn',`${run.id}:${t.turn_index}`,t.failure_document))}:{})})),tools:tools.map(t=>({id:t.id,name:t.name,state:t.state,transport:t.transport,layoutVersion:t.layout_version}))};
  }
  private async hasTerminalModel(tx:Database,run:RunRow){
    const rows=await tx.query(`WITH RECURSIVE family(id) AS (
      SELECT id FROM gh_agent_runs WHERE tenant_id=$1 AND id=$2
      UNION ALL SELECT r.id FROM gh_agent_runs r JOIN family f ON r.parent_run_id=f.id WHERE r.tenant_id=$1
    ) SELECT 1 FROM gh_agent_model_turns t JOIN family f ON f.id=t.run_id
    WHERE t.tenant_id=$1 AND t.state IN ('failed','unknown','unavailable') LIMIT 1`,[run.tenant_id,run.id]);
    return rows.length>0;
  }
  async enroll(actor:Actor,input:EnrollRun):Promise<EnrolledRun>{
    bounded(input,2000000,'The native conversation is too large to admit.');
    const role=agentId(input.agentId),native=input.input;
    if(!native||!Array.isArray(native.messages)||native.messages.length>2000)throw new HttpError(400,'INVALID_AGENT_RUN','A native user message is required.');
    safeId(native.threadId,'thread');safeId(native.runId,'run');safeId(input.clientId,'client');
    const last=[...native.messages].reverse().find(message=>message.role==='user');
    if(!last||typeof last.content!=='string'||!last.content.trim()||last.content.length>20000)throw new HttpError(400,'INVALID_AGENT_PROMPT','Use a message between 1 and 20,000 characters.');
    safeId(last.id,'user message');
    return this.db.transaction(async tx=>{
      await agentMember(tx,actor);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`agent-thread:${actor.tenantId}:${native.threadId}`]);
      let existing:RunRow|undefined;
      if(input.resumeRunId)existing=await this.run(tx,actor,input.resumeRunId,true);
      else if(native.parentToolCallId)existing=(await tx.query<RunRow>('SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND parent_tool_call_id=$2 FOR UPDATE',[actor.tenantId,native.parentToolCallId]))[0];
      else existing=(await tx.query<RunRow>('SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND thread_id=$2 AND user_message_id=$3 FOR UPDATE',[actor.tenantId,native.threadId,last.id]))[0];
      if(existing){
        await this.run(tx,actor,existing.id);
        if(existing.thread_id!==native.threadId||existing.agent_id!==role)throw new HttpError(409,'AGENT_RUN_IDENTITY','This saved run has a different native identity.');
        if(input.snapshotHash!==existing.snapshot_hash)throw new HttpError(409,'AGENT_SCOPE_CHANGED','This native run is bound to a different saved snapshot. Start from its original scope or create a new investigation.');
        const doc=this.runDocument(existing);
        if(!input.resumeRunId&&!native.parentToolCallId&&doc.prompt!==last.content)throw new HttpError(409,'AGENT_PROMPT_CHANGED','This user turn was already admitted with different content.');
        if(existing.lease_owner!==input.clientId&&existing.lease_until&&Date.parse(existing.lease_until)>Date.now())throw new HttpError(409,'AGENT_RUN_LEASE','The original tab still owns this run. Resume becomes available when its lease expires.');
        await agentSnapshot(tx,actor,existing.snapshot_hash);
        if(existing.state==='cancelled')throw new HttpError(409,'AGENT_RUN_CANCELLED','This run was stopped. Start a new investigation.');
        if(existing.parent_run_id&&(await this.run(tx,actor,existing.parent_run_id)).state==='cancelled')throw new HttpError(409,'AGENT_PARENT_CANCELLED','The parent investigation was stopped. Its delegated run cannot resume.');
        if(existing.state!=='completed'){
          if(await this.hasTerminalModel(tx,existing))throw new HttpError(409,'AGENT_TERMINAL_MODEL','An original model response in this investigation is terminal or unresolved. Its request, identity and completed evidence are preserved. Start a separate investigation; this saved attempt cannot resume.');
          await tx.query("UPDATE gh_agent_runs SET state='running',reason=null,lease_owner=$3,lease_until=now()+interval '35 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2",[actor.tenantId,existing.id,input.clientId]);
          existing={...existing,state:'running',reason:null,lease_owner:input.clientId};
        }else{await tx.query("UPDATE gh_agent_runs SET lease_owner=$3,lease_until=now()+interval '35 seconds' WHERE tenant_id=$1 AND id=$2",[actor.tenantId,existing.id,input.clientId]);existing={...existing,lease_owner:input.clientId};}
        await this.event(tx,existing,'run_resumed',input.clientId,'Resumed the same saved native run; recorded model turns and tool results are reused.','running');
        return {run:await this.view(tx,existing),input:doc.input,params:doc.params,replaying:true};
      }
      let prompt=last.content,params=input.params,parentTask:unknown;
      if(native.parentRunId||native.parentToolCallId){
        if(!native.parentRunId||!native.parentToolCallId)throw new HttpError(403,'AGENT_PARENT_REQUIRED','A delegated run needs both native parent identities.');
        const parent=await this.ownRun(tx,actor,native.parentRunId,input.clientId);
        const call=(await tx.query<ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,native.parentToolCallId]))[0];
        if(!call||call.run_id!==parent.id||call.name!=='delegate_to'||call.state!=='running')throw new HttpError(403,'AGENT_HANDOFF_REQUIRED','This child must come from the parent’s exact server-issued handoff.');
        const args=this.toolDocument(call).args as {type:{id:AgentId};instructions:string};
        if(args.type.id!==role||args.instructions!==prompt||input.snapshotHash!==parent.snapshot_hash)throw new HttpError(403,'AGENT_HANDOFF_MISMATCH','This child differs from the admitted handoff.');
        const {id:target,...rest}=args.type;void target;params=Object.keys(rest).length?rest:undefined;parentTask=args;
      }else{
        if(role!=='coordinator')throw new HttpError(403,'AGENT_DELEGATE_ONLY','Only the Coordinator can begin a user turn. Other agents require a recorded native handoff.');
        const active=(await tx.query<RunRow>("SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND thread_id=$2 AND parent_run_id IS NULL AND state IN ('running','held') ORDER BY created_at DESC LIMIT 1",[actor.tenantId,native.threadId]))[0];
        if(active)throw new HttpError(409,'AGENT_RESUME_REQUIRED','Resume or stop the saved turn before sending another message in this investigation.');
      }
      await agentSnapshot(tx,actor,input.snapshotHash);
      const original:AgAiRunInput={...native,messages:[{id:last.id,role:'user',content:prompt}],state:{},forwardedProps:{},context:[],tools:[]};
      const doc:RunDocument={input:original,params,prompt,promptId:last.id,actor,parentTask};
      await tx.query(`INSERT INTO gh_agent_runs(tenant_id,id,thread_id,user_message_id,actor_id,membership_version,agent_id,parent_run_id,parent_tool_call_id,snapshot_hash,private_document,lease_owner,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '35 seconds')`,[actor.tenantId,native.runId,native.threadId,last.id,actor.id,actor.membershipVersion,role,native.parentRunId??null,native.parentToolCallId??null,input.snapshotHash,this.secrets.seal(actor.tenantId,'run',native.runId,doc),input.clientId]);
      const run=await this.run(tx,actor,native.runId);
      await this.event(tx,run,native.parentRunId?'handoff_started':'run_started',native.parentToolCallId??last.id,`${role} ${native.parentRunId?'accepted the native handoff':'started the saved investigation'}.`,'running','application',null,hash({prompt,params}));
      return {run:await this.view(tx,run),input:original,params,replaying:false};
    });
  }
  async heartbeat(actor:Actor,runId:string,clientId:string){return this.db.transaction(async tx=>{const run=await this.ownRun(tx,actor,runId,clientId,true);return this.view(tx,run);});}
  async status(actor:Actor,threadId?:string){
    return this.db.transaction(async tx=>{
      await agentMember(tx,actor);
      const rows=await tx.query<RunRow>(`SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND actor_id=$2${threadId?' AND thread_id=$3':''} ORDER BY created_at DESC LIMIT 100`,threadId?[actor.tenantId,actor.id,threadId]:[actor.tenantId,actor.id]);
      return Promise.all(rows.map(row=>this.view(tx,row)));
    });
  }
  async events(actor:Actor){return this.db.transaction(async tx=>{await agentMember(tx,actor);return (await tx.query<{body:AgentRunEvent}>('SELECT e.body FROM gh_agent_durable_events e JOIN gh_agent_runs r ON r.tenant_id=e.tenant_id AND r.id=e.run_id WHERE e.tenant_id=$1 AND r.actor_id=$2 ORDER BY e.sequence DESC LIMIT 200',[actor.tenantId,actor.id])).map(row=>row.body);});}
  async finish(actor:Actor,runId:string,clientId:string,action:'complete'|'hold'|'cancel'){
    return this.db.transaction(async tx=>{
      const run=await this.run(tx,actor,runId,true);
      if(run.lease_owner!==clientId)throw new HttpError(409,'AGENT_RUN_LEASE','The saved run belongs to another active tab.');
      if(run.state==='completed'||run.state==='cancelled')return this.view(tx,run);
      const outstanding=await tx.query("SELECT 1 FROM gh_agent_model_turns WHERE tenant_id=$1 AND run_id=$2 AND state<>'completed' UNION ALL SELECT 1 FROM gh_agent_tool_calls WHERE tenant_id=$1 AND run_id=$2 AND state NOT IN ('completed','denied')",[actor.tenantId,runId]);
      const last=(await tx.query<TurnRow>('SELECT * FROM gh_agent_model_turns WHERE tenant_id=$1 AND run_id=$2 ORDER BY turn_index DESC LIMIT 1',[actor.tenantId,runId]))[0];
      const lastDoc=last?this.turnDocument(last):undefined;
      const terminator=lastDoc?.response?.output.find(item=>item.type==='function_call'&&item.name==='complete_task');
      const receipt=terminator?.type==='function_call'?(await tx.query<ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE tenant_id=$1 AND id=$2',[actor.tenantId,terminator.callId]))[0]:undefined;
      const hasFinish=run.parent_tool_call_id?receipt?.state==='completed'&&this.toolDocument(receipt).result?.success:lastDoc?.response?.output.some(item=>item.type==='message'&&item.content.length>0);
      const complete=action==='complete'&&outstanding.length===0&&!!hasFinish;
      const state:RunState=action==='cancel'?'cancelled':complete?'completed':'held';
      const terminal=await this.hasTerminalModel(tx,run);
      const reason=complete?null:action==='cancel'?'Stopped by the reviewer. Dispatched model requests retain their recorded identities.':terminal?'An original model response in this saved investigation is terminal or unresolved. Its identity and completed evidence are preserved. This attempt cannot resume.':'The native run is saved with an unresolved step. Resume reuses its original identities; unknown outcomes are never repeated.';
      await tx.query('UPDATE gh_agent_runs SET state=$3,reason=$4,lease_until=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2',[actor.tenantId,runId,state,reason]);
      if(action==='cancel'){
        const children=await tx.query<RunRow>(`WITH RECURSIVE family(id) AS (
          SELECT id FROM gh_agent_runs WHERE tenant_id=$1 AND parent_run_id=$2
          UNION ALL SELECT r.id FROM gh_agent_runs r JOIN family f ON r.parent_run_id=f.id WHERE r.tenant_id=$1
        ) UPDATE gh_agent_runs SET state='cancelled',reason=$3,lease_until=now(),updated_at=now()
        WHERE tenant_id=$1 AND id IN (SELECT id FROM family) AND state NOT IN ('completed','cancelled') RETURNING *`,[actor.tenantId,runId,'Stopped with the parent investigation. Original provider identities and encrypted receipts are retained.']);
        for(const child of children){
          await tx.query("UPDATE gh_agent_tool_calls SET state='unknown',reason='The parent investigation stopped before this original result was confirmed.',updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND state='running'",[actor.tenantId,child.id]);
          await this.event(tx,child,'run_cancelled','parent-stopped',`${child.agent_id} stopped with its parent investigation.`,'error');
        }
      }
      if(!complete)await tx.query("UPDATE gh_agent_tool_calls SET state='unknown',reason='The original native tool has no confirmed acknowledgement.',updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND state='running' AND name<>'delegate_to'",[actor.tenantId,runId]);
      await this.event(tx,run,complete?'run_completed':action==='cancel'?'run_cancelled':'run_held',`${state}:${last?.turn_index??0}`,`${run.agent_id} ${complete?'completed its recorded task':'saved an interrupted task'}.`,complete?'success':'error');
      return this.view(tx,{...run,state,reason,lease_until:new Date().toISOString()});
    });
  }
  async insertCall(tx:Database,run:RunRow,turn:TurnRow,name:string,id:string,argumentsText:string,tools:AgAiToolSchema[]){
    let args:Record<string,unknown>={},result:AgAiToolResult|undefined,state:ToolState='issued';
    try{const parsed=JSON.parse(argumentsText);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))args=parsed;args=validateCall(run.agent_id,name,parsed,tools);}catch{state='denied';result={success:false,issues:[{message:'The server refused this tool or its arguments under the current agent capability boundary.'}]};}
    const {transportFor}=await import('./registry');
    const inputHash=hash({name,args});const doc:ToolDocument={args,result};
    const old=(await tx.query<ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE tenant_id=$1 AND id=$2',[run.tenant_id,id]))[0];
    if(old){if(old.run_id!==run.id||old.turn_index!==turn.turn_index||old.input_hash!==inputHash)throw new HttpError(409,'AGENT_CALL_ID_COLLISION','A provider tool identity was reused with different content. The response is held.');return;}
    await tx.query('INSERT INTO gh_agent_tool_calls(tenant_id,id,run_id,turn_index,name,input_hash,transport,state,private_document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[run.tenant_id,id,run.id,turn.turn_index,name,inputHash,transportFor(name),state,this.secrets.seal(run.tenant_id,'tool',id,doc)]);
    if(state==='denied')await this.event(tx,run,'tool_denied',id,'The server denied a tool outside the admitted capability boundary.','denied','application',name,inputHash);
  }
  lease(){return randomUUID();}
}
