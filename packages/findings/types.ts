import type {Evidence,QueryContext,Role,Snapshot} from '../domain/types';

export const FINDING_DEPENDENCY_POLICY='finding-dependencies-v1' as const;
export type FindingState='proposed'|'supported_for_current_scope'|'challenged'|'revised'|'retracted';
export type FindingAction='support'|'challenge'|'revise'|'retract';
export interface FindingReference {findingId:string;revisionId:string;hash:string}
export interface FindingCitation extends Evidence {hash:string;relation:'supports'|'contradicts';scope?:'current'|'earlier_version'}
export interface FindingFacts {
  affectedCount:number;scopeCount:number;capturedMinor:number;currency:string;openDisputes:number;
  affectedOrderIds:string[];deliveredOrderIds:string[];scopeOrderIds:string[];
}
export interface FindingDelta {
  beforeCount:number;afterCount:number;removedOrderIds:string[];addedOrderIds:string[];
  changedOrderIds:string[];staleDependentPlanIds:string[];sourceChangeId:string|null;
}
export interface FindingRevision {
  schemaVersion:1;id:string;findingId:string;tenantId:string;workspaceId:string;merchantId:string;
  sequence:number;previousRevisionId:string|null;previousHash:string|null;hash:string;
  creatorId:string;actorId:string;actorRole:Role|'source';createdAt:string;
  state:FindingState;event:'created'|'legacy_adopted'|'supported'|'challenged'|'revised'|'retracted'|'source_revised';
  title:string;interpretation:string;counterpoint:string;reason:string;interpretationReview:'required'|'supported_for_scope'|'retracted';
  sourceSnapshotId:string;sourceSnapshotHash:string;context:QueryContext;cohortVersion:number;
  facts:FindingFacts;citations:FindingCitation[];sourceCoverage:Snapshot['sourceCoverage'];
  dependencies:{orderIds:string[];sourceEventIds:string[];evidenceIds:string[];fingerprint:string;resources:{kind:'order'|'capture'|'dispute';id:string;orderId:string}[]};
  delta:FindingDelta|null;openChallengeRevisionId:string|null;resolvedChallengeRevisionId:string|null;
  origin:{kind:'human'|'agent'|'legacy';documentId:string|null;documentHash:string|null;legacyCohortRevision:number|null};
}
export interface FindingSummary extends FindingReference {
  title:string;sequence:number;state:FindingState;creatorId:string;actorId:string;createdAt:string;
  affectedCount:number;cohortVersion:number;sourceSnapshotHash:string;isCurrent:boolean;shared:boolean;
  currentSource:boolean;canReview:boolean;canEdit:boolean;canShare:boolean;
}
export interface FindingDetail {
  revision:FindingRevision;summary:FindingSummary;revisions:FindingSummary[];
  plans:{id:string;hash:string;status:string;createdAt:string;dependencyRevisionId:string;invalidated:boolean}[];
  corrections:FindingCorrection[];
  correctionMoment:{sourceChangeId:string;revisionId:string;removedOrderIds:string[];stalePlanIds:string[]}|null;
}
export interface FindingCorrection {
  findingId:string;revisionId:string;revisionHash:string;currentRevisionId:string|null;
  reason:string;createdAt:string;state:FindingState|'superseded';delta:FindingDelta|null;
}
export interface LegacyFinding {
  documentId:string;documentHash:string;title:string;createdAt:string;snapshotHash:string;cohortRevision:number;
  explanation:'Legacy revision is a cohort version; no human review sequence was recorded.';
}
export interface FindingList {findings:FindingSummary[];legacy:LegacyFinding[];hasMore:boolean;nextCursor:string|null}
export interface FindingCreate {
  requestId:string;snapshotHash:string;title:string;interpretation:string;counterpoint:string;
  evidenceIds:string[];counterEvidenceIds:string[];reason:string;
}
export interface FindingDecision {
  requestId:string;expectedRevisionId:string;expectedHash:string;action:FindingAction;reason:string;
  snapshotHash?:string;title?:string;interpretation?:string;counterpoint?:string;
  evidenceIds?:string[];counterEvidenceIds?:string[];
}
export interface SourceChange {
  id:string;tenantId:string;kind:string;reason:string;createdAt:string;actorId:string;
  beforeSnapshotHash:string;afterSnapshotHash:string;previousCohortVersion:number;cohortVersion:number;
  changedOrderIds:string[];removedOrderIds:string[];addedOrderIds:string[];
  revisions:FindingReference[];staleDependentPlanIds:string[];ownPlanId:string|null;
}
export interface PlanDependencyReview {
  policy:typeof FINDING_DEPENDENCY_POLICY;valid:boolean;checkedAt:string;
  dependencies:(FindingReference&{title:string;sequence:number;state:FindingState;current:boolean;shared:boolean})[];
  reason:string|null;
}
