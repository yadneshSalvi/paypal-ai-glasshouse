import type {Response,ResponseInputItem,ResponseCreateParamsNonStreaming} from 'openai/resources/responses/responses';
import {toResponseInputItems} from 'openai/lib/responses/ResponseInputItems';
import type {Actor} from '@/packages/domain/types';
import type {SubmitTurn,TurnView} from '@/packages/agents/contracts';
import type {Database} from '@/packages/db/client';
import {HttpError} from '../errors';
import {hash} from '../repository';
import {AgentJournal,type RunRow,type TurnDocument,type TurnRow,type ToolRow} from './journal';
import {authorizedTools,instructionsFor,modelFor} from './registry';
import {agentMember,agentSnapshot,bounded} from './security';
import {BeforeModelDispatch,ModelRejected,ModelUnavailable,publicModelResponse,type AgentModelProvider} from './provider';
import {modelOutcome,modelOutcomeMessage} from './model-outcome';

export class AgentModels {
  constructor(readonly journal:AgentJournal,readonly provider:AgentModelProvider|null){}
  private async row(tx:Database,tenant:string,run:string,index:number,lock=false){return (await tx.query<TurnRow>(`SELECT * FROM gh_agent_model_turns WHERE tenant_id=$1 AND run_id=$2 AND turn_index=$3${lock?' FOR UPDATE':''}`,[tenant,run,index]))[0];}
  private view(row:TurnRow):TurnView {
    const doc=this.journal.turnDocument(row),outcome=modelOutcome(doc);
    return {runId:row.run_id,index:row.turn_index,state:row.state,hasProviderId:row.has_provider_id,providerStored:row.provider_stored,response:row.state==='completed'?doc.response:undefined,reason:outcome?modelOutcomeMessage(outcome):row.reason,outcome,retryAfterMs:row.state==='pending'?2000:row.state==='dispatching'?2500:undefined};
  }
  async submit(actor:Actor,input:SubmitTurn):Promise<TurnView>{
    if(!Number.isSafeInteger(input.index)||input.index<0||input.index>=100)throw new HttpError(400,'AGENT_TURN_INDEX','A native turn index between 0 and 99 is required.');
    bounded(input.request,2000000,'This native context exceeds the saved turn limit.');
    return this.journal.db.transaction(async tx=>{
      const run=await this.journal.ownRun(tx,actor,input.runId,input.clientId,true);
      if(input.snapshotHash!==run.snapshot_hash)throw new HttpError(409,'AGENT_SCOPE_CHANGED','The native workspace changed scope during this saved run. No new model turn was admitted.');
      const snapshot=await agentSnapshot(tx,actor,run.snapshot_hash);await this.journal.checkReadGrants(tx,actor,run.id,snapshot);
      const tools=authorizedTools(run.agent_id,input.request);
      const existing=await this.row(tx,actor.tenantId,run.id,input.index,true);
      // Replay uses the immutable admitted request; current native enums/history may
      // have changed after the original tool already completed.
      if(existing)return this.view(existing);
      if(run.state==='completed')throw new HttpError(409,'AGENT_RUN_COMPLETED','A completed delegate can only replay its already recorded model turns.');
      const runDoc=this.journal.runDocument(run);const modelInput:ResponseInputItem[]=[];
      if(input.index===0){
        if(!run.parent_run_id){
          const earlier=await tx.query<RunRow>("SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND thread_id=$2 AND actor_id=$3 AND state='completed' AND id<>$4 ORDER BY created_at DESC LIMIT 8",[actor.tenantId,run.thread_id,actor.id,run.id]);
          for(const prior of earlier.reverse()){
            const priorDoc=this.journal.runDocument(prior);
            const tail=(await tx.query<TurnRow>("SELECT * FROM gh_agent_model_turns WHERE tenant_id=$1 AND run_id=$2 AND state='completed' ORDER BY turn_index DESC LIMIT 1",[actor.tenantId,prior.id]))[0];
            const answer=tail?this.journal.turnDocument(tail).response?.output.filter(item=>item.type==='message').flatMap(item=>item.type==='message'?item.content.map(part=>'text'in part?part.text:part.refusal):[]).join('\n'):'';
            modelInput.push({role:'user',content:priorDoc.prompt});
            if(answer)modelInput.push({role:'assistant',content:answer});
          }
        }
        modelInput.push({role:'user',content:runDoc.prompt});
      }else{
        const previous=await this.row(tx,actor.tenantId,run.id,input.index-1,true);
        if(!previous||previous.state!=='completed')throw new HttpError(409,'AGENT_PREVIOUS_TURN_PENDING','The preceding model response must be observed before another turn is admitted.');
        const doc=this.journal.turnDocument(previous),calls=doc.provider?.output.filter(item=>item.type==='function_call')??[];
        const completingChild=run.parent_tool_call_id&&typeof input.request.toolChoice==='object'&&input.request.toolChoice.name==='complete_task';
        if(calls.length===0&&!completingChild)throw new HttpError(409,'AGENT_NO_PENDING_TOOLS','This model run already returned its answer.');
        modelInput.push(...toResponseInputItems([...(doc.request.input as ResponseInputItem[]),...doc.provider!.output]));
        for(const call of calls){
          const tool=(await tx.query<ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE tenant_id=$1 AND id=$2',[actor.tenantId,call.call_id]))[0];
          const toolDoc=tool?this.journal.toolDocument(tool):undefined;
          if(!tool||!['completed','denied'].includes(tool.state)||!toolDoc?.result)throw new HttpError(409,'AGENT_TOOL_PENDING','An original tool outcome is unresolved. A later model turn cannot invent its result.');
          modelInput.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(toolDoc.result)});
        }
      }
      bounded(modelInput,3000000,'This investigation has reached its context limit. Its recorded results remain available.');
      const forced=typeof input.request.toolChoice==='object'?input.request.toolChoice.name:undefined;
      const request:ResponseCreateParamsNonStreaming={model:modelFor(run.agent_id),input:modelInput,background:true,store:true,stream:false,
        include:['reasoning.encrypted_content'],
        instructions:instructionsFor(run.agent_id,run.snapshot_hash,runDoc.params,input.request.instructions),
        tools:tools.map(tool=>({type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:false})),
        reasoning:{effort:'max'},max_output_tokens:32768,tool_choice:forced&&tools.some(tool=>tool.name===forced)?{type:'function',name:forced}:'auto',parallel_tool_calls:false,
        metadata:{glasshouse_turn:hash({tenant:actor.tenantId,run:run.id,index:input.index}),transport:this.provider?.mode??'unconfigured'}};
      const doc:TurnDocument={request,tools},requestHash=hash(request);
      await tx.query('INSERT INTO gh_agent_model_turns(tenant_id,run_id,turn_index,request_hash,private_document) VALUES($1,$2,$3,$4,$5)',[actor.tenantId,run.id,input.index,requestHash,this.journal.secrets.seal(actor.tenantId,'turn',`${run.id}:${input.index}`,doc)]);
      await this.journal.event(tx,run,'model_prepared',String(input.index),'Saved the exact model request before dispatch.','running','application',null,requestHash);
      return this.view((await this.row(tx,actor.tenantId,run.id,input.index))!);
    });
  }
  async read(actor:Actor,runId:string,index:number){return this.journal.db.transaction(async tx=>{const run=await this.journal.run(tx,actor,runId);const snapshot=await agentSnapshot(tx,actor,run.snapshot_hash);await this.journal.checkReadGrants(tx,actor,run.id,snapshot);const row=await this.row(tx,actor.tenantId,runId,index);if(!row)throw new HttpError(404,'AGENT_TURN_NOT_FOUND','This model turn has not been admitted.');return this.view(row);});}
  async step(actor:Actor,runId:string,index:number,clientId?:string):Promise<TurnView>{
    if(!this.provider)throw new HttpError(503,'AI_UNAVAILABLE','Live AI is not connected. Saved investigations and manual tools remain available.');
    const claim=await this.journal.db.transaction(async tx=>{
      await agentMember(tx,actor,actor.membershipVersion,true);
      const run=clientId?await this.journal.ownRun(tx,actor,runId,clientId):await this.journal.run(tx,actor,runId,true);
      const snapshot=await agentSnapshot(tx,actor,run.snapshot_hash);await this.journal.checkReadGrants(tx,actor,run.id,snapshot);
      const row=await this.row(tx,actor.tenantId,runId,index,true);
      if(!row)throw new HttpError(404,'AGENT_TURN_NOT_FOUND','This model turn has not been admitted.');
      if(['completed','failed','unknown','unavailable'].includes(row.state))return {row,run,token:null};
      if(row.lease_until&&Date.parse(row.lease_until)>Date.now())return {row,run,token:null};
      if(row.state==='dispatching'&&!row.has_provider_id){
        await tx.query("UPDATE gh_agent_model_turns SET state='unknown',reason=$4,updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND turn_index=$3",[actor.tenantId,runId,index,'The dispatch lease expired before a provider response identity was saved. The create request will not be repeated.']);
        await this.journal.event(tx,run,'model_unknown',String(index),'The provider outcome is unknown; another create is prohibited.','error','OpenAI');
        return {row:(await this.row(tx,actor.tenantId,runId,index))!,run,token:null};
      }
      if(run.state!=='running')return {row,run,token:null};
      const token=this.journal.lease(),create=row.state==='prepared';
      if(create&&row.dispatch_count!==0)throw new HttpError(409,'MODEL_DUPLICATE_DISPATCH','This saved turn already dispatched its only create request.');
      await tx.query(`UPDATE gh_agent_model_turns SET state=$4,dispatch_count=dispatch_count+$5,lease_owner=$6,lease_until=now()+interval '40 seconds',updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND turn_index=$3`,[actor.tenantId,runId,index,create?'dispatching':'pending',create?1:0,token]);
      await this.journal.event(tx,run,create?'model_dispatched':'model_retrieving',`${index}:${create?'create':token}`,create?'Dispatched the one admitted model create request.':'Retrieving the exact known model response.','running',this.provider!.mode==='live'?'OpenAI':'application',null,row.request_hash);
      return {row:(await this.row(tx,actor.tenantId,runId,index))!,run,token,create};
    });
    if(!claim.token)return this.read(actor,runId,index);
    const doc=this.journal.turnDocument(claim.row);
    const guard=async()=>this.journal.db.transaction(async tx=>{
      await agentMember(tx,actor,actor.membershipVersion,true);
      const run=await this.journal.run(tx,actor,runId);
      if(run.state!=='running')throw new BeforeModelDispatch('This run was stopped.');
      const snapshot=await agentSnapshot(tx,actor,run.snapshot_hash);await this.journal.checkReadGrants(tx,actor,run.id,snapshot);
      const row=await this.row(tx,actor.tenantId,runId,index,true);
      if(!row||row.lease_owner!==claim.token||!row.lease_until||Date.parse(row.lease_until)<=Date.now())throw new BeforeModelDispatch('The exact dispatch lease was lost.');
    });
    try{
      const rememberId=async(id:string,stored:boolean|null)=>this.journal.db.transaction(async tx=>{
        const row=await this.row(tx,actor.tenantId,runId,index,true);
        if(!row||row.lease_owner!==claim.token)throw new Error('The response identity arrived after its exact dispatch lease was replaced.');
        const current=this.journal.turnDocument(row);
        if(current.providerId&&current.providerId!==id)throw new ModelRejected(409);
        current.providerId=id;
        await tx.query('UPDATE gh_agent_model_turns SET has_provider_id=true,private_document=$4,provider_stored=$5 WHERE tenant_id=$1 AND run_id=$2 AND turn_index=$3',[actor.tenantId,runId,index,this.journal.secrets.seal(actor.tenantId,'turn',`${runId}:${index}`,current),stored??row.provider_stored]);
      });
      const response=claim.create?await this.provider.create(doc.request,guard,rememberId):await this.provider.retrieve(doc.providerId??'',guard);
      await this.accept(actor,claim.run,claim.row,claim.token,response);
    }catch(error){
      await this.journal.db.transaction(async tx=>{
        const row=await this.row(tx,actor.tenantId,runId,index,true);
        if(!row||row.lease_owner!==claim.token)return;
        // Evidence persistence intentionally does not depend on still-active membership.
        // Disclosure below does. Revocation must not discard an in-flight receipt.
        const unknown=claim.create&&!row.has_provider_id&&!(error instanceof BeforeModelDispatch)&&!(error instanceof ModelRejected);
        const failed=error instanceof BeforeModelDispatch||error instanceof ModelRejected;
        const unavailable=error instanceof ModelUnavailable,state=unavailable?'unavailable':unknown?'unknown':failed?'failed':'pending';
        const reason=unavailable?`The exact saved response is unavailable from the provider (HTTP ${error.status}). Its original identity is retained. No replacement create was sent.`:unknown?'The provider may have accepted this create, but no exact response ID was saved. It will not be sent again.':failed?'The exact request was refused or stopped. No replacement create was sent.':'The known response could not be read yet. Recovery can only retrieve the same saved provider ID.';
        const retained=this.journal.turnDocument(row);if(unavailable)retained.retrievalUnavailable={status:error.status,observedAt:new Date().toISOString()};
        await tx.query("UPDATE gh_agent_model_turns SET state=$4,reason=$5,private_document=$6,lease_owner=null,lease_until=now()+interval '4 seconds',updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND turn_index=$3",[actor.tenantId,runId,index,state,reason,unavailable?this.journal.secrets.seal(actor.tenantId,'turn',`${runId}:${index}`,retained):row.private_document]);
        await this.journal.event(tx,claim.run,`model_${state}`,String(index),reason,state==='pending'?'running':'error',this.provider!.mode==='live'?'OpenAI':'application');
      });
    }
    return this.read(actor,runId,index);
  }
  private async accept(actor:Actor,run:RunRow,claim:TurnRow,token:string,response:Response){
    if(!/^resp_[A-Za-z0-9_-]{1,240}$/.test(response.id))throw new Error('Provider response identity missing.');
    // The installed SDK's response type omits this observed wire field.
    const returnedStorage='store'in response&&typeof response.store==='boolean'?response.store:null;
    // Save the known ID independently of parsing the output or admitting tools.
    // A malformed/oversized response must never erase a recoverable provider ID.
    await this.journal.db.transaction(async tx=>{
      const row=await this.row(tx,actor.tenantId,run.id,claim.turn_index,true);
      if(!row||row.lease_owner!==token)return;
      const doc=this.journal.turnDocument(row);
      if(doc.providerId&&doc.providerId!==response.id)throw new ModelRejected(409);
      doc.providerId=response.id;
      await tx.query("UPDATE gh_agent_model_turns SET has_provider_id=true,private_document=$4,provider_stored=$5 WHERE tenant_id=$1 AND run_id=$2 AND turn_index=$3",[actor.tenantId,run.id,claim.turn_index,this.journal.secrets.seal(actor.tenantId,'turn',`${run.id}:${claim.turn_index}`,doc),returnedStorage??row.provider_stored]);
    });
    if(!Array.isArray(response.output))throw new Error('Provider output is not yet readable.');
    bounded(response,6000000,'The provider response exceeds the durable evidence limit.');
    await this.journal.db.transaction(async tx=>{
      const row=await this.row(tx,actor.tenantId,run.id,claim.turn_index,true);
      if(!row||row.lease_owner!==token)return;
      const doc=this.journal.turnDocument(row);
      if(doc.providerId&&doc.providerId!==response.id)throw new Error('A known provider response changed identity.');
      doc.providerId=response.id;doc.provider=response;doc.response=publicModelResponse(response);
      const state=response.status==='completed'?'completed':['queued','in_progress'].includes(response.status??'')?'pending':'failed';
      if(state==='completed')for(const call of response.output)if(call.type==='function_call')await this.journal.insertCall(tx,run,row,call.name,call.call_id,call.arguments,doc.tools);
      const outcome=modelOutcome(doc);
      await tx.query("UPDATE gh_agent_model_turns SET state=$4,private_document=$5,has_provider_id=true,provider_stored=$7,lease_owner=null,lease_until=now()+interval '2 seconds',reason=$6,updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND turn_index=$3",[actor.tenantId,run.id,claim.turn_index,state,this.journal.secrets.seal(actor.tenantId,'turn',`${run.id}:${claim.turn_index}`,doc),state==='failed'?(outcome?modelOutcomeMessage(outcome):'The provider ended this exact response without a complete answer.'):null,returnedStorage??row.provider_stored]);
      await this.journal.event(tx,run,state==='completed'?'model_completed':'model_identity_saved',String(claim.turn_index),state==='completed'?'Observed and saved the exact model response.':`Saved the exact response identity; provider state is ${response.status}.`,state==='completed'?'success':state==='failed'?'error':'running',this.provider!.mode==='live'?'OpenAI':'application',null,row.request_hash);
    });
  }
  async drain(limit=4){
    const rows=await this.journal.db.query<TurnRow&{run_document:string}>("SELECT t.*,r.private_document AS run_document FROM gh_agent_model_turns t JOIN gh_agent_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id WHERE r.state='running' AND t.state IN ('prepared','pending','dispatching') AND (t.lease_until IS NULL OR t.lease_until<now()) ORDER BY t.updated_at LIMIT $1",[Math.max(1,Math.min(8,limit))]);
    const results:Record<string,unknown>[]=[];
    for(const row of rows){
      const doc=this.journal.secrets.open<{actor:Actor}>(row.tenant_id,'run',row.run_id,row.run_document);
      try{const value=await this.step(doc.actor,row.run_id,row.turn_index);results.push({runId:row.run_id,index:row.turn_index,state:value.state});}catch(error){results.push({runId:row.run_id,index:row.turn_index,state:'held',code:error instanceof HttpError?error.code:'WORKER_UNAVAILABLE'});}
    }
    return {checked:rows.length,results};
  }
}
