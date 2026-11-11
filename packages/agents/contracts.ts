import type {AgAiRunInput,AgAiToolResult,AgLlmRequest,AgLlmResponse} from 'ag-studio';
import type {Snapshot} from '../domain/types';

export const agentIds=['coordinator','investigator','planner','operator','writer','page','widget','planning'] as const;
export type AgentId=typeof agentIds[number];
export type RunState='running'|'completed'|'held'|'cancelled';
export type TurnState='prepared'|'dispatching'|'pending'|'completed'|'failed'|'unknown'|'unavailable';
export type ToolState='issued'|'running'|'completed'|'unknown'|'denied';
export interface ModelOutcome {status:'incomplete'|'failed'|'cancelled';reason:'max_output_tokens'|'content_filter'|'provider_failure'|'cancelled'|'incomplete';outputLimit:number|null;outputTokens:number|null}
export interface EnrollRun {
  input:AgAiRunInput; agentId:AgentId; params?:unknown; snapshotHash:string;
  clientId:string; resumeRunId?:string;
}
export interface RunView {
  id:string;threadId:string;agentId:AgentId;parentRunId:string|null;parentToolCallId:string|null;
  snapshotHash:string;state:RunState;reason:string|null;updatedAt:string;canResume:boolean;
  modelTurns:{index:number;state:TurnState;hasProviderId:boolean;dispatchCount:number;providerStored:boolean|null;outcome?:ModelOutcome}[];
  tools:{id:string;name:string;state:ToolState;transport:string;layoutVersion:number|null}[];
}
export interface EnrolledRun {run:RunView;input:AgAiRunInput;params?:unknown;replaying:boolean}
export interface SubmitTurn {runId:string;index:number;request:AgLlmRequest;clientId:string;snapshotHash:string}
export interface TurnView {runId:string;index:number;state:TurnState;hasProviderId:boolean;providerStored:boolean|null;response?:AgLlmResponse;reason?:string|null;outcome?:ModelOutcome;retryAfterMs?:number}
export interface ToolClaim {runId:string;callId:string;name:string;args:Record<string,unknown>;clientId:string;snapshotHash:string}
export interface ToolGrant {state:'execute'|'completed'|'held';result?:AgAiToolResult;reason?:string;mutationId?:string;leaseToken?:string}
export interface NativeAcknowledgement {runId:string;callId:string;clientId:string;leaseToken:string;result:AgAiToolResult;snapshotHash:string}
export interface AgentLayoutReceipt extends NativeAcknowledgement {mutationId:string}
export interface AgentFinding {
  id:string;runId:string;snapshotHash:string;revision:number;title:string;
  interpretation:string;counterpoint:string;status:'hypothesis'|'supported'|'insufficient_evidence';
  evidence:{id:string;sourceClass:string;sourceLabel:string;title:string;occurredAt:string;ingestedAt:string;hash:string}[];
  facts:{affected:number;orders:number;capturedMinor:number;refundMinor:number;openDisputes:number;currency:string;clock:string;asOf:string;knownAt:string};
  sourceCoverage:Snapshot['sourceCoverage'];
  tools:{callId:string;name:string;transport:string;hash:string}[];
  createdAt:string;
}
export const domainTools=['read_incident','read_findings','read_finding','read_evidence','evaluate_recovery','prepare_recovery','read_recovery_proposal','inspect_operations','boundary_check','record_finding','write_incident_brief','paypal_get_order','paypal_list_disputes','paypal_get_dispute','paypal_find_transaction'] as const;
export const isDomainTool=(name:string):boolean=>(domainTools as readonly string[]).includes(name);
export const delegationTargets:Record<AgentId,readonly AgentId[]>={coordinator:['investigator','planner','operator','writer','planning'],investigator:['page','widget','planning'],planner:[],operator:[],writer:[],page:[],widget:[],planning:[]};
