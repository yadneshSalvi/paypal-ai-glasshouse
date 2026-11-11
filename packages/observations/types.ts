export interface StatusCheckView {
  operationId:string; outcome:'verified'|'pending'|'unresolved'|'not_dispatched'|'not_completed'|'busy';
  observedAt:string; providerId:string|null; providerStatus:string|null; bodyHash:string|null;
  reason:string; evidenceSubmitted?:boolean; caseResolved?:boolean;
}
export interface ObservationOverview {
  connectorConfigured:boolean;
  notifications:{verified:number;applied:number;duplicates:number;rejected:number;conflicts:number;lastVerifiedAt:string|null};
  jobs:{queued:number;running:number;retry:number;complete:number;attention:number};
  recent:Array<{id:string;kind:string;state:string;attempts:number;updatedAt:string;reason:string|null}>;
  pendingOperations:string[];
  heldOperations:Array<{operationId:string;reason:string;updatedAt:string}>;
  checks:StatusCheckView[];
}
