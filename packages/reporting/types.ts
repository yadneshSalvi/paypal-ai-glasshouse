export interface ReportingEntry {
  transactionId:string; kind:'capture'|'refund'; orderId:string; status:string;
  amountMinor:number; currency:string; occurredAt:string; updatedAt:string;
}
export interface ReportingPage {
  page:number; totalPages:number; totalItems:number; returned:number; excluded:number;
  refreshedAt:string|null; observedAt:string; bodyHash:string; entries:ReportingEntry[];
}
export interface ReportingRunView {
  id:string; start:string; end:string; state:'active'|'complete'|'attention'|'cancelled';
  createdAt:string; completedAt:string|null; windows:number; completedWindows:number; pages:number;
  ownedResources:number; observedResources:number; refreshedAt:string|null; reason:string|null;
  coverage:Array<{index:number;start:string;end:string;state:string;nextPage:number;pages:number;reason:string|null}>;
}
export interface ReportingOverview {configured:boolean;runs:ReportingRunView[];limitations:string[]}

export interface ReportingEvidencePage {runId:string;page:number;total:number;pageSize:number;rows:Array<ReportingEntry&{observedAt:string;evidenceHash:string}>}
