import type {AgAiToolResult} from 'ag-studio';
import type {Actor,Operation,RecoveryPlan,SeedDataset,Snapshot} from '@/packages/domain/types';
import type {Database} from '@/packages/db/client';
import type {AgentFinding,AgentLayoutReceipt,NativeAcknowledgement,ToolClaim,ToolGrant} from '@/packages/agents/contracts';
import {isDomainTool} from '@/packages/agents/contracts';
import {buildSnapshot} from '@/packages/domain';
import {HttpError} from '../errors';
import {audit,hash,storePlan} from '../repository';
import {snapshotContext} from '../snapshots';
import {freezeAction,exactPlanHash} from '../recovery/contracts';
import type {DisputeObservation} from '../recovery/disputes';
import {AgentJournal,type RunRow,type ToolDocument,type ToolRow} from './journal';
import {agentMember,agentSnapshot,bounded,ownedToolkitResource} from './security';
import {layoutTools,requireTool} from './registry';
import type {ScopedPayPalToolkit} from './toolkit';

const success=(response:string,data?:unknown):AgAiToolResult=>({success:true,response,data});
const failure=(message:string):AgAiToolResult=>({success:false,issues:[{message}]});
function validateResult(value:AgAiToolResult){
  bounded(value,750000,'This native tool result is too large.');
  if(!value||typeof value.success!=='boolean'||value.success&&(typeof value.response!=='string'||value.response.length>200000)||!value.success&&(!Array.isArray(value.issues)||value.issues.some(issue=>typeof issue.message!=='string')))throw new HttpError(400,'AGENT_RESULT_INVALID','A complete native tool result is required.');
  return value;
}
export class AgentTools {
  constructor(readonly journal:AgentJournal,readonly toolkit:ScopedPayPalToolkit|null){}
  private async row(tx:Database,actor:Actor,callId:string){const row=(await tx.query<ToolRow>('SELECT * FROM gh_agent_tool_calls WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,callId]))[0];if(!row)throw new HttpError(403,'AGENT_TOOL_NOT_ISSUED','This tool call was not issued by an admitted model response.');return row;}
  private async complete(tx:Database,run:RunRow,call:ToolRow,doc:ToolDocument,result:AgAiToolResult){
    validateResult(result);doc.result=result;
    await tx.query("UPDATE gh_agent_tool_calls SET state='completed',private_document=$3,reason=null,updated_at=now() WHERE tenant_id=$1 AND id=$2",[run.tenant_id,call.id,this.journal.secrets.seal(run.tenant_id,'tool',call.id,doc)]);
    const transport=call.transport==='Toolkit'&&!result.success?'application':call.transport as 'Studio'|'Toolkit'|'application';
    await this.journal.event(tx,run,'tool_completed',call.id,`${call.name} ${result.success?'returned a recorded result':'returned an explicit refusal'}.`,result.success?'success':'denied',transport,call.name,call.input_hash);
  }
  async claim(actor:Actor,input:ToolClaim):Promise<ToolGrant>{
    bounded(input,300000,'This tool call exceeds the argument limit.');
    const claimed=await this.journal.db.transaction(async tx=>{
      const run=await this.journal.ownRun(tx,actor,input.runId,input.clientId,true),snapshot=await agentSnapshot(tx,actor,run.snapshot_hash);
      if(input.snapshotHash!==run.snapshot_hash)throw new HttpError(409,'AGENT_SCOPE_CHANGED','The native workspace changed scope before this tool.');
      const call=await this.row(tx,actor,input.callId),doc=this.journal.toolDocument(call);
      if(call.run_id!==run.id||call.name!==input.name||hash({name:input.name,args:input.args})!==call.input_hash)throw new HttpError(403,'AGENT_TOOL_IDENTITY','This request differs from its exact model-issued tool call.');
      // Replayed private reads require the current grant too. A saved result from
      // a response racing revocation is evidence, not renewed disclosure authority.
      if(call.name.startsWith('paypal_')&&doc.resourceHash&&hash(await this.owned(tx,actor,snapshot,String(doc.args.orderId),doc.args.disputeId as string|undefined))!==doc.resourceHash)throw new HttpError(409,'TOOLKIT_GRANT_CHANGED','The resource grant changed before this saved Toolkit result could be disclosed.');
      if(['completed','denied'].includes(call.state)&&doc.result)return {grant:{state:'completed',result:doc.result} as ToolGrant};
      if(run.state==='completed')throw new HttpError(409,'AGENT_RUN_COMPLETED','A completed delegate can only return its recorded tool results.');
      requireTool(run.agent_id,call.name);
      if(actor.role==='viewer'&&layoutTools.has(call.name))throw new HttpError(403,'LAYOUT_READ_ONLY','This workspace role cannot authorize native report changes.');
      if(call.state==='unknown'||call.state==='running'&&(call.name!=='delegate_to'||doc.executionOwner===input.clientId))return {grant:{state:'held',reason:'The original tool began without a confirmed result. Its mutation will not be repeated. A saved exact acknowledgement may still reconcile it.'} as ToolGrant};
      if(call.state!=='issued'&&call.name!=='delegate_to')return {grant:{state:'held',reason:'This original tool outcome is unresolved.'} as ToolGrant};
      const token=this.journal.lease();doc.executionOwner=input.clientId;
      let mutationId:string|null=null;
      if(layoutTools.has(call.name)){
        const current=(await tx.query<{body:unknown;version:number}>('SELECT body,version FROM gh_layouts WHERE tenant_id=$1 AND id=$2 FOR SHARE',[actor.tenantId,'incident-room']))[0];
        if(!current?.body)throw new HttpError(409,'AGENT_LAYOUT_BASE_REQUIRED','Save the complete native workspace before an agent changes it.');
        doc.beforeLayoutHash=hash(current.body);doc.beforeLayoutVersion=current.version;
        mutationId=`native-${hash({tenant:actor.tenantId,run:run.id,call:call.id}).slice(0,40)}`;
      }
      if(call.name.startsWith('paypal_')){
        const owned=await this.owned(tx,actor,snapshot,String(doc.args.orderId),doc.args.disputeId as string|undefined);
        doc.resourceHash=hash(owned);
      }
      await tx.query("UPDATE gh_agent_tool_calls SET state='running',dispatch_count=1,lease_token=$3,mutation_id=$4,private_document=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2",[actor.tenantId,call.id,token,mutationId,this.journal.secrets.seal(actor.tenantId,'tool',call.id,doc)]);
      await this.journal.event(tx,run,'tool_started',`${call.id}:${token}`,`${call.name} admitted by the ${run.agent_id} capability boundary.`,'running',call.transport as 'Studio'|'Toolkit'|'application',call.name,call.input_hash);
      if(isDomainTool(call.name)&&!call.name.startsWith('paypal_')){
        let result:AgAiToolResult;
        try{result=await this.domain(tx,actor,run,call,doc,snapshot);}catch(error){if(!(error instanceof HttpError))throw error;result=failure(error.message);}
        await this.complete(tx,run,call,doc,result);return {grant:{state:'completed',result} as ToolGrant};
      }
      return {grant:{state:'execute',leaseToken:token,mutationId:mutationId??undefined} as ToolGrant,run,call:{...call,lease_token:token,mutation_id:mutationId},doc,snapshot};
    });
    if(!claimed.call||!claimed.run||!claimed.doc||!claimed.snapshot||!claimed.call.name.startsWith('paypal_'))return claimed.grant;
    const {run,call,doc,snapshot}=claimed;let result:AgAiToolResult;
    if(!this.toolkit)result=failure('The installed Toolkit is available, but scoped live reads have not been enabled and qualified for this workspace.');
    else{
      const guard=async()=>this.journal.db.transaction(async tx=>{
        await this.journal.run(tx,actor,run.id);await agentSnapshot(tx,actor,run.snapshot_hash);
        const current=await this.owned(tx,actor,snapshot,String(doc.args.orderId),doc.args.disputeId as string|undefined);
        if(hash(current)!==doc.resourceHash)throw new HttpError(409,'TOOLKIT_GRANT_CHANGED','The owned resource grant changed during this Toolkit read.');
      });
      try{
        const owned=await this.journal.db.transaction(tx=>this.owned(tx,actor,snapshot,String(doc.args.orderId),doc.args.disputeId as string|undefined));
        const receipt=await this.toolkit.read(call.name,owned,doc.args.disputeId as string|undefined,guard);
        result=success('Observed through the installed PayPal Agent Toolkit.',receipt);
      }catch(error){result=failure(error instanceof HttpError?error.message:'This scoped Toolkit read is unresolved. No absent payment or successful action was inferred.');}
    }
    // A response racing revocation is retained encrypted; it is not disclosed below.
    await this.journal.db.transaction(async tx=>{const current=await this.row(tx,actor,call.id);if(current.lease_token===call.lease_token&&current.state!=='completed')await this.complete(tx,run,current,doc,result);});
    return this.journal.db.transaction(async tx=>{await this.journal.run(tx,actor,run.id);await agentSnapshot(tx,actor,run.snapshot_hash);if(doc.resourceHash&&hash(await this.owned(tx,actor,snapshot,String(doc.args.orderId),doc.args.disputeId as string|undefined))!==doc.resourceHash)throw new HttpError(409,'TOOLKIT_GRANT_CHANGED','The resource grant changed before this Toolkit result could be disclosed.');return {state:'completed',result} as ToolGrant;});
  }
  private owned=ownedToolkitResource;
  async acknowledge(actor:Actor,input:NativeAcknowledgement){
    return this.journal.db.transaction(async tx=>{
      const run=await this.journal.ownRun(tx,actor,input.runId,input.clientId);await agentSnapshot(tx,actor,run.snapshot_hash);
      if(input.snapshotHash!==run.snapshot_hash)throw new HttpError(409,'AGENT_SCOPE_CHANGED','The native tool acknowledgement belongs to another snapshot.');
      const call=await this.row(tx,actor,input.callId),doc=this.journal.toolDocument(call);
      if(call.run_id!==run.id||call.lease_token!==input.leaseToken||isDomainTool(call.name)||layoutTools.has(call.name))throw new HttpError(403,'AGENT_ACKNOWLEDGEMENT_DENIED','This result needs its exact native receipt or atomic workspace save.');
      if(call.state==='completed'){if(hash(doc.result)!==hash(input.result))throw new HttpError(409,'AGENT_RESULT_CHANGED','The original tool result is already recorded.');return {saved:true};}
      if(call.name==='delegate_to'){
        const child=(await tx.query<RunRow>('SELECT * FROM gh_agent_runs WHERE tenant_id=$1 AND parent_tool_call_id=$2',[actor.tenantId,call.id]))[0];
        if(!child||child.state!=='completed')throw new HttpError(409,'AGENT_CHILD_UNRESOLVED','The native delegate has not completed its recorded run.');
        const completed=(await tx.query<ToolRow>("SELECT * FROM gh_agent_tool_calls WHERE tenant_id=$1 AND run_id=$2 AND name='complete_task' AND state='completed' ORDER BY turn_index DESC LIMIT 1",[actor.tenantId,child.id]))[0];
        const summary=completed?this.journal.toolDocument(completed).args.summary:undefined;
        if(typeof summary!=='string'||hash(input.result)!==hash(success(summary)))throw new HttpError(409,'AGENT_CHILD_RESULT_CHANGED','The handoff result must match this exact child’s recorded completion.');
      }
      if(call.name==='complete_task'&&hash(input.result)!==hash(success(String(doc.args.summary),{summary:doc.args.summary,artifacts:doc.args.artifacts})))throw new HttpError(409,'AGENT_COMPLETION_CHANGED','The native completion result differs from its model-issued summary and artifacts.');
      await this.complete(tx,run,call,doc,validateResult(input.result));return {saved:true};
    });
  }
  /** Called inside the existing history CAS transaction, never as a second writer. */
  async commitLayout(tx:Database,actor:Actor,input:AgentLayoutReceipt,history:unknown,version:number,previous:{body:unknown;version:number}){
    const run=await this.journal.run(tx,actor,input.runId,true);await agentSnapshot(tx,actor,run.snapshot_hash);
    if(input.snapshotHash!==run.snapshot_hash)throw new HttpError(409,'AGENT_SCOPE_CHANGED','The native workspace save belongs to another snapshot.');
    const call=await this.row(tx,actor,input.callId),doc=this.journal.toolDocument(call);
    if(call.run_id!==run.id||call.lease_token!==input.leaseToken||call.mutation_id!==input.mutationId||!layoutTools.has(call.name)||doc.executionOwner!==input.clientId)throw new HttpError(403,'AGENT_LAYOUT_IDENTITY','This save is not bound to the original native mutation identity.');
    const digest=hash(history);validateResult(input.result);
    if(call.state==='completed'){
      if(call.layout_hash!==digest||call.layout_version!==version||hash(doc.result)!==hash(input.result))throw new HttpError(409,'AGENT_LAYOUT_RESULT_CHANGED','This original native mutation already has a different saved acknowledgement.');return;
    }
    if(doc.beforeLayoutVersion!==previous.version||doc.beforeLayoutHash!==hash(previous.body))throw new HttpError(409,'AGENT_LAYOUT_BASE_CHANGED','Another change replaced this native mutation’s exact saved starting point. The result is held.');
    const next=history as {undo:{id:string;source:{type:string;agent?:string}}[];redo:{id:string}[]};
    const before=previous.body as {undo:{id:string}[];redo:{id:string}[]};
    const existing=new Set([...before.undo,...before.redo].map(entry=>entry.id));
    const entries=next.undo.filter(entry=>!existing.has(entry.id));
    if(input.result.success&&digest!==doc.beforeLayoutHash&&(!entries.length||entries.some(entry=>entry.source.type!=='ai'||entry.source.agent!==run.agent_id)))throw new HttpError(409,'AGENT_NATIVE_ATTRIBUTION_REQUIRED','The changed report has no matching native agent history entry.');
    doc.historyEntryIds=entries.map(entry=>entry.id);
    await tx.query('UPDATE gh_agent_tool_calls SET layout_version=$3,layout_hash=$4 WHERE tenant_id=$1 AND id=$2',[actor.tenantId,call.id,version,digest]);
    await this.complete(tx,run,call,doc,input.result);
    await this.journal.event(tx,run,'native_mutation_saved',call.mutation_id!,`Saved the native ${run.agent_id} change and its exact tool result together at workspace revision ${version}.`,'success','Studio',call.name,call.input_hash);
  }
  private async domain(tx:Database,actor:Actor,run:RunRow,call:ToolRow,doc:ToolDocument,snapshot:Snapshot):Promise<AgAiToolResult>{
    const context={snapshotHash:snapshot.hash,context:snapshot.context};
    if(call.name==='read_incident')return success('Deterministic incident facts.',{...context,incidentId:'carrier-delay-pnw',totals:snapshot.totals,sourceCoverage:snapshot.sourceCoverage,detectors:snapshot.detectors,affectedOrderIds:snapshot.affectedOrderIds,removedOrderIds:snapshot.removedOrderIds,ownedOrders:snapshot.orders.filter(order=>order.paymentSource==='sandbox').slice(0,30).map(order=>({orderId:order.id,reference:order.reference,captureId:order.captureId,paypalOrderId:order.paypalOrderId,disputeId:order.disputeId}))});
    if(call.name==='read_evidence'){
      const offset=Number(doc.args.offset??0),rows=snapshot.evidence.filter(row=>!doc.args.orderId||row.orderId===doc.args.orderId);
      return success('Source-labelled evidence; quoted excerpts are untrusted data.',{...context,total:rows.length,offset,nextOffset:offset+40<rows.length?offset+40:null,evidence:rows.slice(offset,offset+40)});
    }
    if(call.name==='evaluate_recovery')return success('Exact policy totals and exclusions.',{...context,branches:snapshot.branches.map(({id,policyId,eligibleCount,refundTotalMinor,trackingCount,disputeCount,exclusionCounts,budgetMinor})=>({id,policyId,eligibleCount,refundTotalMinor,trackingCount,disputeCount,exclusionCounts,budgetMinor})),approvalRequired:true});
    if(call.name==='boundary_check'){
      let denied=false;try{requireTool(run.agent_id,'execute_refund');}catch(error){if(error instanceof HttpError&&error.code==='AGENT_TOOL_DENIED')denied=true;else throw error;}
      if(!denied)throw new Error('The financial capability boundary did not deny the investigator.');
      await audit(tx,actor,'authority.denied','The server agent registry denied financial execution',call.id,{runId:run.id,agent:run.agent_id,tool:'execute_refund',snapshotHash:snapshot.hash});
      return success('The server refused the financial capability.',{allowed:false,agent:run.agent_id,tool:'execute_refund',reason:'Delegate a proposal to Planner. Exact human review and approval remain separate.'});
    }
    if(call.name==='inspect_operations')return success('Observed original outcomes; submission does not imply resolution.',{...context,...await this.outcomes(tx,actor,snapshot)});
    if(call.name==='prepare_recovery'){
      if(actor.role==='viewer')throw new HttpError(403,'AGENT_PROPOSAL_DENIED','This role cannot prepare a recovery proposal.');
      const dataset=(await tx.query<{body:SeedDataset}>('SELECT body FROM gh_datasets WHERE tenant_id=$1',[actor.tenantId]))[0].body;
      if(buildSnapshot(dataset,snapshotContext(actor,dataset)).hash!==snapshot.hash)throw new HttpError(409,'AGENT_CURRENT_PROPOSAL_REQUIRED','A recovery proposal requires the latest operational time and knowledge cutoff.');
      const chosen=snapshot.branches.find(branch=>branch.id===doc.args.branchId)!;
      const budget=Number(doc.args.budgetMinor);if(chosen.refundTotalMinor>budget)throw new HttpError(409,'BUDGET_EXCEEDED','This exact branch exceeds the stated refund cap.');
      const id=`plan-agent-${hash({tenant:actor.tenantId,call:call.id}).slice(0,32)}`;
      const branch={...chosen,budgetMinor:budget,withinBudget:true,actions:chosen.actions.map(action=>freezeAction(actor.tenantId,id,action))};
      const plan:RecoveryPlan={id,tenantId:actor.tenantId,version:1,createdBy:actor.id,createdAt:new Date().toISOString(),status:'ready_for_review',branch,snapshotId:snapshot.id,snapshotHash:snapshot.hash,cohortVersion:snapshot.context.cohortVersion,hash:'',expiresAt:new Date(Date.now()+30*60000).toISOString(),staleReason:null,approvedBy:null,approvedAt:null,executionMode:snapshot.sourceCoverage.sandboxPayments>0&&branch.actions.filter(action=>action.kind==='refund').every(action=>action.sourceClass==='sandbox')?'sandbox':'sample',contractVersion:2,context:snapshot.context};
      plan.hash=exactPlanHash(plan);await storePlan(tx,plan);await audit(tx,actor,'plan.created','Agent prepared an exact proposal for human review',id,{runId:run.id,callId:call.id,planHash:plan.hash,snapshotHash:snapshot.hash});
      return success('Exact proposal frozen once. Human review is required before approval or execution.',{id:plan.id,hash:plan.hash,status:plan.status,branch:plan.branch.name,eligibleCount:plan.branch.eligibleCount,refundTotalMinor:plan.branch.refundTotalMinor,budgetMinor:budget,trackingCount:plan.branch.trackingCount,disputeCount:plan.branch.disputeCount,executionMode:plan.executionMode,snapshotHash:snapshot.hash,expiresAt:plan.expiresAt});
    }
    if(call.name==='record_finding'){
      const evidenceIds=doc.args.evidenceIds as string[],evidence=snapshot.evidence.filter(row=>evidenceIds.includes(row.id));
      if(new Set(evidenceIds).size!==evidenceIds.length||evidence.length!==evidenceIds.length)throw new HttpError(409,'AGENT_EVIDENCE_SCOPE','Each citation must refer to one distinct source visible in this snapshot.');
      const detector=snapshot.detectors.find(row=>row.kind===doc.args.hypothesis)!;
      const calls=await tx.query<ToolRow>("SELECT * FROM gh_agent_tool_calls WHERE tenant_id=$1 AND run_id=$2 AND state='completed' AND name IN ('read_incident','read_evidence','paypal_get_order','paypal_list_disputes','paypal_get_dispute','paypal_find_transaction')",[actor.tenantId,run.id]);
      if(!calls.some(row=>row.name==='read_evidence'))throw new HttpError(409,'AGENT_EVIDENCE_READ_REQUIRED','Read scoped evidence before recording a finding.');
      const observedIds=new Set(calls.filter(row=>row.name==='read_evidence').flatMap(row=>{const result=this.journal.toolDocument(row).result;return result?.success&&result.data&&typeof result.data==='object'&&'evidence'in result.data&&Array.isArray(result.data.evidence)?result.data.evidence.map((evidence:{id:string})=>evidence.id):[];}));
      if(evidenceIds.some(id=>!observedIds.has(id)))throw new HttpError(409,'AGENT_CITATION_NOT_READ','Read each cited source before adding it to a finding.');
      const finding:AgentFinding={id:`finding-${hash({tenant:actor.tenantId,call:call.id}).slice(0,28)}`,runId:run.id,snapshotHash:snapshot.hash,revision:snapshot.context.cohortVersion,title:detector.title,interpretation:String(doc.args.interpretation),counterpoint:String(doc.args.counterpoint),status:detector.status==='insufficient_evidence'?'insufficient_evidence':'hypothesis',evidence:evidence.map(row=>({id:row.id,sourceClass:row.sourceClass,sourceLabel:row.sourceLabel,title:row.title,occurredAt:row.occurredAt,ingestedAt:row.ingestedAt,hash:hash(row)})),facts:{affected:snapshot.totals.affected,orders:snapshot.totals.orders,capturedMinor:snapshot.totals.capturedMinor,refundMinor:snapshot.totals.refundMinor,openDisputes:snapshot.totals.openDisputes,currency:snapshot.context.currency,clock:snapshot.context.clockDomain,asOf:snapshot.context.asOf,knownAt:snapshot.context.knownAt},sourceCoverage:snapshot.sourceCoverage,tools:calls.filter(row=>this.journal.toolDocument(row).result?.success).map(row=>({callId:row.id,name:row.name,transport:row.transport,hash:hash(this.journal.toolDocument(row).result)})),createdAt:new Date().toISOString()};
      await this.document(tx,run,finding.id,'finding',finding);return success('Saved a sourced hypothesis. Counts are deterministic; interpretation is not a proven cause.',finding);
    }
    if(call.name==='write_incident_brief'){
      const findings=await this.documents(tx,actor,'finding',snapshot.hash);
      const brief={id:`brief-${hash({tenant:actor.tenantId,call:call.id}).slice(0,28)}`,title:'Fernwood incident brief',snapshotHash:snapshot.hash,context:snapshot.context,createdAt:new Date().toISOString(),facts:snapshot.totals,sourceCoverage:snapshot.sourceCoverage,findings,outcomes:await this.outcomes(tx,actor,snapshot),limitations:['Interpretations are hypotheses grounded in cited sources; correlation does not establish a cause.','A refund, shipment update, evidence submission and resolved case are different outcomes.','Provider reads have their own observation time and do not rewrite this saved T/K snapshot.']};
      await this.document(tx,run,brief.id,'brief',brief);return success('Saved the sourced incident brief.',brief);
    }
    throw new HttpError(403,'AGENT_DOMAIN_TOOL_DENIED','This domain tool is not authorized.');
  }
  private async outcomes(tx:Database,actor:Actor,snapshot:Snapshot){
    const operations=(await tx.query<{body:Operation}>('SELECT body FROM gh_operations WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 1000',[actor.tenantId])).map(row=>row.body).filter(row=>snapshot.orders.some(order=>order.id===row.orderId));
    const cases=(await tx.query<{body:DisputeObservation;order_id:string}>("SELECT body,order_id FROM gh_provider_resources WHERE tenant_id=$1 AND kind='dispute' AND active=true",[actor.tenantId])).filter(row=>snapshot.orders.some(order=>order.id===row.order_id));
    return {operations:operations.map(row=>({id:row.id,planId:row.planId,orderId:row.orderId,kind:row.kind,amountMinor:row.amountMinor,currency:row.currency,status:row.status,providerId:row.providerId,attempts:row.attempts,sourceClass:row.sourceClass,observedAt:row.updatedAt,reason:row.reason,receiptHash:row.result?hash(row.result):null})),cases:cases.map(({body,order_id})=>({id:body.id,orderId:order_id,status:body.status,stage:body.stage,sellerResponseDueAt:body.sellerResponseDueAt,observedAt:body.observedAt,bodyHash:body.bodyHash})),disclosure:'Persisted operation receipts and independent case observations. These current observations may be later than the selected snapshot knowledge cutoff.'};
  }
  private async document(tx:Database,run:RunRow,id:string,kind:string,value:unknown){await tx.query('INSERT INTO gh_agent_documents(tenant_id,id,run_id,kind,snapshot_hash,private_document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[run.tenant_id,id,run.id,kind,run.snapshot_hash,this.journal.secrets.seal(run.tenant_id,'document',id,value)]);}
  async documents(tx:Database,actor:Actor,kind?:string,snapshotHash?:string){
    await agentMember(tx,actor);
    const rows=await tx.query<{id:string;private_document:string;kind:string;snapshot_hash:string}>('SELECT d.* FROM gh_agent_documents d JOIN gh_agent_runs r ON r.tenant_id=d.tenant_id AND r.id=d.run_id WHERE d.tenant_id=$1 AND r.actor_id=$2 ORDER BY d.created_at DESC LIMIT 100',[actor.tenantId,actor.id]);
    return rows.filter(row=>(!kind||kind===row.kind)&&(!snapshotHash||snapshotHash===row.snapshot_hash)).map(row=>this.journal.secrets.open<unknown>(actor.tenantId,'document',row.id,row.private_document));
  }
}
