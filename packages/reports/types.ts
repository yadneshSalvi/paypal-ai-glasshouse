import type {AuditEvent,Operation,QueryContext,RecoveryPlan,Snapshot} from '../domain/types';
import type {AgentFinding} from '../agents/contracts';
import type {ReportHistory} from '../studio/history-saves';

export type ReportPaper='A4'|'LETTER';
export interface ReportRequest {
  requestId:string;title:string;description:string;snapshotHash:string;
  expectedLayoutVersion:number;expectedLayoutHash:string;planIds:string[];parentId?:string;
}
export interface ReportGrant {kind:'order'|'capture'|'dispute';id:string;orderId:string;runId:string}
export interface ReportOperation extends Pick<Operation,'id'|'planId'|'actionId'|'orderId'|'kind'|'amountMinor'|'currency'|'status'|'providerId'|'attempts'|'updatedAt'|'sourceClass'|'reason'> {receiptHash:string|null}
export interface ReportCase {id:string;orderId:string;captureId:string;status:string;stage:string;dueAt:string|null;observedAt:string;bodyHash:string}
export interface ReportSummary {
  id:string;title:string;description:string;createdAt:string;createdBy:string;creatorName:string;
  workspaceName:string;merchantName:string;parentId:string|null;documentHash:string;snapshotHash:string;
  context:QueryContext;layoutVersion:number;planCount:number;operationCount:number;findingCount:number;
}
export interface ReportDocument {
  schemaVersion:1;id:string;title:string;description:string;createdAt:string;parentId:string|null;
  workspace:{id:string;name:string;merchantName:string;organizationName:string|null;source:'sample'|'existing'};
  creator:{actorId:string;displayName:string;role:string;membershipVersion:number;identityKind:'browser_capability'};
  snapshot:Snapshot;
  layout:{version:number;hash:string;history:ReportHistory};
  plans:RecoveryPlan[];findings:AgentFinding[];
  observed:{capturedAt:string;operations:ReportOperation[];cases:ReportCase[]};
  audit:{scope:'workspace_at_export';events:Pick<AuditEvent,'id'|'timestamp'|'actorId'|'type'|'summary'|'refId'>[];throughSequence:number};
  grants:ReportGrant[];
  coverage:{snapshotOrders:number;snapshotEvidence:number;snapshotTransitions:number;nativePages:number;nativeWidgets:number;undoEntries:number;redoEntries:number;fullSnapshotInJson:true;staticInstruments:'whole_admitted_snapshot';customMappings:'preserved_in_native_history';agentNarratives:'creator_owned_findings_for_exact_snapshot';sharing:'current_workspace_members_only';limitations:string[]};
}
export interface SavedReport {summary:ReportSummary;document:ReportDocument}
export interface ReportList {reports:ReportSummary[];hasMore:boolean;nextCursor:string|null}
export interface PdfRepresentation {bytes:Buffer;hash:string;pages:number;rendererVersion:string;paper:ReportPaper}
