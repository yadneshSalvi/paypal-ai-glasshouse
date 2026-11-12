import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSnapshot} from '../packages/domain';
import {buildOrderDetail} from '../packages/domain/order-detail';
import {instrumentCorpus,times} from './reference/instrument-corpus';

test('a scoped order proof exposes each admitted resource without multiplying money or showing later knowledge',()=>{
 const dataset=instrumentCorpus(),context={semanticModelVersion:'commerce-semantic-v2',asOf:times.end,knownAt:times.known,currency:'USD' as const};
 const snapshot=buildSnapshot(dataset,context),proof=buildOrderDetail(dataset,snapshot,'a')!;
 assert.equal(proof.snapshotHash,snapshot.hash);assert.equal(proof.order.capturedMinor,10000);assert.equal(proof.order.refundedMinor,1000);assert.equal(proof.order.refundableMinor,8800);
 const resources=proof.resources!;assert.equal(resources.filter(row=>row.kind==='line').length,2);assert.equal(resources.filter(row=>row.kind==='capture').length,2);assert.equal(resources.filter(row=>row.kind==='shipment').length,2);assert.equal(resources.filter(row=>row.kind==='refund').length,3);
 assert.equal(resources.filter(row=>row.kind==='capture').reduce((sum,row)=>sum+row.amountMinor!,0),10000);assert.equal(resources.filter(row=>row.kind==='refund'&&row.state==='completed').reduce((sum,row)=>sum+row.amountMinor!,0),1000);
 assert.ok(resources.every(row=>Date.parse(row.ingestedAt)<=Date.parse(times.known)));assert.ok(resources.every(row=>row.sourceClass==='sample'));
 assert.ok(proof.evidence.some(row=>row.excerpt.includes('Parent line sample:line-a.')));assert.ok(proof.evidence.some(row=>row.excerpt.includes('Parent capture sample:cap-a-0.')));
 const earlySnapshot=buildSnapshot(dataset,{...context,knownAt:times.four}),early=buildOrderDetail(dataset,earlySnapshot,'a')!;
 assert.equal(early.order.refundedMinor,300);assert.equal(early.resources!.filter(row=>row.kind==='refund').length,1);assert.ok(!JSON.stringify(early).includes('sample:refund-a-0'));
 const euro=buildOrderDetail(dataset,buildSnapshot(dataset,{...context,currency:'EUR'}),'e')!;assert.equal(euro.order.capturedMinor,900);assert.ok(euro.resources!.every(row=>row.currency==='EUR'));assert.equal(euro.resources!.filter(row=>row.kind==='capture').length,2);
 assert.equal(buildOrderDetail(dataset,snapshot,'e'),null);assert.equal(buildOrderDetail(dataset,snapshot,'foreign'),null);
 const legacy=buildOrderDetail(dataset,buildSnapshot(dataset,{...context,semanticModelVersion:'commerce-semantic-v1'}),'a')!;assert.equal(Object.hasOwn(legacy,'resources'),false);
});
