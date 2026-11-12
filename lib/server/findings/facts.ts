import type {Actor,Evidence,QueryContext,SeedDataset,Snapshot,SnapshotOrder} from '@/packages/domain/types';
import type {FindingCitation,FindingFacts,FindingRevision} from '@/packages/findings/types';
import {buildSnapshot} from '@/packages/domain';
import {hash} from '../repository';
import {HttpError} from '../errors';
import {snapshotContext} from '../snapshots';

export function findingFacts(snapshot:Snapshot,scopeIds?:string[]):FindingFacts{
  const orders=snapshot.orders.filter(row=>scopeIds?scopeIds.includes(row.id):row.incidentMember),sorted=(rows:SnapshotOrder[])=>rows.map(row=>row.id).sort();
  return {affectedCount:orders.filter(row=>row.affected).length,scopeCount:orders.length,capturedMinor:orders.reduce((total,row)=>total+(row.capturedMinor??(['captured','completed'].includes(row.paymentState)?row.amountMinor:0)),0),currency:snapshot.context.currency,openDisputes:orders.filter(row=>row.disputeOpen).length,
    affectedOrderIds:sorted(orders.filter(row=>row.affected)),deliveredOrderIds:sorted(orders.filter(row=>row.fulfillmentState==='delivered')),scopeOrderIds:sorted(orders)};
}
/** Carrier explanation dependencies exclude the effects of its own approved
 * remediation. Refund inventory and independently changed payment/case facts
 * are still recorded at the common invalidation boundary. */
const causalOrder=(row:SnapshotOrder)=>({id:row.id,incidentMember:row.incidentMember,affected:row.affected,fulfillmentState:row.fulfillmentState,paymentState:row.paymentState,captureId:row.captureId,paymentSource:row.paymentSource,amountMinor:row.amountMinor,capturedMinor:row.capturedMinor,captureCount:row.captureCount,lineCount:row.lineCount,shipmentCount:row.shipmentCount,dueShipmentCount:row.dueShipmentCount,lateShipmentCount:row.lateShipmentCount,currency:row.currency,promisedAt:row.promisedAt,disputeOpen:row.disputeOpen,disputeId:row.disputeId,disputeSource:row.disputeSource,providerRefundConsumedMinor:row.providerRefundConsumedMinor??null,providerRefundInventoryHash:row.providerRefundInventoryHash??null});
export function sourceFingerprint(snapshot:Snapshot,orderIds:string[],evidenceIds:string[]){
  return hash({scopeOrderIds:snapshot.orders.filter(row=>row.incidentMember).map(row=>row.id).sort(),contraryEvidence:snapshot.evidence.filter(row=>row.contradicts.some(id=>evidenceIds.includes(id))).map(row=>({id:row.id,hash:hash(row)})).sort((a,b)=>a.id.localeCompare(b.id)),orders:snapshot.orders.filter(row=>orderIds.includes(row.id)).map(causalOrder).sort((a,b)=>a.id.localeCompare(b.id)),citations:snapshot.evidence.filter(row=>evidenceIds.includes(row.id)).map(row=>({id:row.id,hash:hash(row)})).sort((a,b)=>a.id.localeCompare(b.id))});
}
export function changedSourceOrders(before:Snapshot,after:Snapshot){
  const previous=new Map(before.orders.map(row=>[row.id,hash({...causalOrder(row),refundedMinor:row.refundedMinor,refundableMinor:row.refundableMinor,trackingInPayPal:row.trackingInPayPal,disputeState:row.disputeState,disputeEvidenceHash:row.disputeEvidenceHash??null,disputeCapabilities:row.disputeCapabilities??null,recoveryReviewVersion:row.recoveryReviewVersion??null})]));
  return [...new Set([...after.orders.filter(row=>previous.get(row.id)!==hash({...causalOrder(row),refundedMinor:row.refundedMinor,refundableMinor:row.refundableMinor,trackingInPayPal:row.trackingInPayPal,disputeState:row.disputeState,disputeEvidenceHash:row.disputeEvidenceHash??null,disputeCapabilities:row.disputeCapabilities??null,recoveryReviewVersion:row.recoveryReviewVersion??null})).map(row=>row.id),...before.orders.filter(row=>!after.orders.some(next=>next.id===row.id)).map(row=>row.id)])].sort();
}
export function cite(snapshot:Snapshot,supportIds:string[],counterIds:string[],earlier:FindingCitation[]=[]):FindingCitation[]{
  const ids=[...supportIds,...counterIds];if(ids.length>80||new Set(ids).size!==ids.length)throw new HttpError(400,'FINDING_CITATIONS_INVALID','Choose up to eighty distinct source records, each as support or counterevidence.');
  return ids.map(id=>{const current=snapshot.evidence.find(row=>row.id===id),previous=earlier.find(row=>row.id===id),evidence=current??(previous?citationEvidence(previous):undefined);if(!evidence)throw new HttpError(403,'FINDING_EVIDENCE_SCOPE','Each citation must be visible in this exact source snapshot.');return {...evidence,hash:hash(evidence),scope:current?'current' as const:'earlier_version' as const,relation:counterIds.includes(id)?'contradicts' as const:'supports' as const};});
}
export function currentFindingSnapshot(actor:Actor,dataset:SeedDataset,context?:QueryContext){
  const search=new URLSearchParams();if(context){search.set('asOf',context.asOf);search.set('currency',context.currency);search.set('clock',context.clockDomain==='observed'?'observed':'narrative_replay');}
  return buildSnapshot(dataset,snapshotContext(actor,dataset,search));
}
export function sameSource(revision:FindingRevision,snapshot:Snapshot){return sourceFingerprint(snapshot,revision.dependencies.orderIds,revision.dependencies.evidenceIds)===revision.dependencies.fingerprint;}
export function citationEvidence(citation:FindingCitation):Evidence{const {hash:unusedHash,relation:unusedRelation,scope:unusedScope,...evidence}=citation;void unusedHash;void unusedRelation;void unusedScope;return evidence;}
