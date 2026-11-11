'use client';
import {createAiHarness,directLlmRunner,type AgStudioApi,type AgAiHarness} from 'ag-studio';
import type {GlasshouseRegistry,StudioBridge} from '../studio/types';
import {DurableAgents,type AgentHistoryBridge} from './durable-client';

export function buildHarness(studioApi:AgStudioApi<GlasshouseRegistry>,bridge:StudioBridge,history:AgentHistoryBridge):AgAiHarness{
  const durable=new DurableAgents(studioApi,bridge,history),adapter=durable.adapter,studio=studioApi.getAiTools();
  const read=(name:string,description:string)=>studioApi.defineAiTool({name,description,params:s=>s.object({}),execute:(_args,ctx)=>ctx.error('A server-issued durable tool grant is required.')});
  const readIncident=read('read_incident','Read deterministic incident facts at the exact saved snapshot.');
  const readFindings=read('read_findings','Read bounded, currently permitted finding summaries and exact version hashes.');
  const readFinding=studioApi.defineAiTool({name:'read_finding',description:'Read one permitted finding version and its separate correction status. No review or sharing authority.',params:s=>s.object({findingId:s.string(),revisionId:s.string().optional()}),execute:(_args,ctx)=>ctx.error('A durable tool grant is required.')});
  const readEvidence=studioApi.defineAiTool({name:'read_evidence',description:'Read source-labelled evidence in pages, with optional local order scope.',params:s=>s.object({orderId:s.string().optional(),offset:s.number().optional()}),execute:(_args,ctx)=>ctx.error('A durable tool grant is required.')});
  const evaluate=read('evaluate_recovery','Compute exact policy amounts and exclusions.');
  const boundary=read('boundary_check','Verify the Investigator financial denial through the server capability registry.');
  const operations=read('inspect_operations','Read actual original operation outcomes and current case observations.');
  const brief=read('write_incident_brief','Save a sourced brief from deterministic facts, findings and observed outcomes.');
  const prepare=studioApi.defineAiTool({name:'prepare_recovery',description:'Freeze a proposal once for human review. Never approves or executes.',params:s=>s.object({branchId:s.enum(['targeted','comprehensive']),budgetMinor:s.number(),findingDependencies:s.array(s.object({findingId:s.string(),revisionId:s.string(),hash:s.string()})).optional()}),execute:(_args,ctx)=>ctx.error('A durable tool grant is required.')});
  const readProposal=studioApi.defineAiTool({name:'read_recovery_proposal',description:'Inspect an exact saved proposal manifest and exclusions without creating or approving anything.',params:s=>s.object({planId:s.string()}),execute:(_args,ctx)=>ctx.error('A durable tool grant is required.')});
  const finding=studioApi.defineAiTool({name:'record_finding',description:'Record a hypothesis, exact evidence citations and a counterpoint; the server supplies all factual totals.',params:s=>s.object({hypothesis:s.enum(['carrier_delay','margin_leak','checkout_decline']),evidenceIds:s.array(s.string()),interpretation:s.string(),counterpoint:s.string()}),execute:(_args,ctx)=>ctx.error('A durable tool grant is required.')});
  const paypal=(name:string,description:string)=>studioApi.defineAiTool({name,description,params:s=>s.object({orderId:s.string()}),execute:(_args,ctx)=>ctx.error('A durable tool grant is required.')});
  const paypalReads=[paypal('paypal_get_order','Use the installed Toolkit to read one owned sandbox order.'),paypal('paypal_list_disputes','Use the installed Toolkit to read one owned capture’s bounded dispute page.'),paypal('paypal_find_transaction','Use the installed Toolkit to look for one owned capture in a bounded reporting page.'),studioApi.defineAiTool({name:'paypal_get_dispute',description:'Use the installed Toolkit to read an already bound owned dispute.',params:s=>s.object({orderId:s.string(),disputeId:s.string()}),execute:(_args,ctx)=>ctx.error('A durable tool grant is required.')})];
  const harness=createAiHarness(studioApi as unknown as AgStudioApi,({tools,builtIn})=>({
    primary:'coordinator',history:durable.history,
    agents:[
      durable.wrap(directLlmRunner({id:'coordinator',name:'Coordinator',description:'Routes evidence, proposals, outcome inspection and sourced briefs through recorded native handoffs.',adapter,maxTurns:100,instructions:()=>`Coordinate the current saved snapshot ${bridge.getSnapshot().hash}.`,tools:()=>[tools.delegateTo(['investigator','planner','operator','writer','planning']),tools.renameThread(),readIncident,operations]})),
      durable.wrap(directLlmRunner({id:'investigator',name:'Investigator',description:'Investigates sourced hypotheses and asks native Page/Widget agents to build requested comparisons. No financial authority.',adapter,maxTurns:100,tools:()=>[readIncident,readFindings,readFinding,readEvidence,boundary,finding,...paypalReads,studio.viewSchema(),studio.viewPage(),studio.executeQuery(),tools.delegateTo(['page','widget','planning'])]})),
      durable.wrap(directLlmRunner({id:'planner',name:'Recovery Planner',description:'Evaluates versioned policy and freezes an exact proposal for human review. Never approves.',adapter,maxTurns:100,tools:()=>[readIncident,readFindings,readFinding,readEvidence,evaluate,prepare,readProposal]})),
      durable.wrap(directLlmRunner({id:'operator',name:'Operator',description:'Verifies original approved outcomes and scoped provider evidence. Financial dispatch stays in the human review flow.',adapter,maxTurns:100,tools:()=>[readIncident,operations,...paypalReads]})),
      durable.wrap(directLlmRunner({id:'writer',name:'Incident Writer',description:'Produces a saved, source-bound brief from findings, deterministic facts and actual outcomes.',adapter,maxTurns:100,tools:()=>[readIncident,readFindings,readFinding,readEvidence,operations,brief]})),
      durable.wrap(directLlmRunner({...builtIn.widget,adapter,maxTurns:100})),
      durable.wrap(directLlmRunner({...builtIn.page,adapter,maxTurns:100})),
      durable.wrap(directLlmRunner({...builtIn.planning,adapter,maxTurns:100})),
    ],
    promptStarters:[{label:'Why these orders?',prompt:'Investigate why these orders are affected. Inspect evidence, save a sourced finding with a counterpoint, and have the Page and Widget agents create a useful regional comparison.'},{label:'Compare recovery',prompt:'Compare the recovery branches under a $300 refund cap and explain every exclusion.'},{label:'Write the incident brief',prompt:'Ask the Writer for a sourced incident brief using our saved findings and actual operation outcomes. Clearly identify cases still awaiting the buyer.'}],
  }));
  durable.attach(harness);return harness;
}
