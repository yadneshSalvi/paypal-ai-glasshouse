import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyDeliveryRevision,buildSnapshot,createSeedDataset} from '../packages/domain';
import type {Actor,QueryContext} from '../packages/domain/types';
import {currentFindingSnapshot,sourceFingerprint} from '../lib/server/findings/facts';
import {snapshotContext} from '../lib/server/snapshots';

const actor:Actor={id:'synthetic-semantic-reviewer',tenantId:'synthetic-semantic-compatibility',role:'judge',membershipVersion:3};
const versions=['commerce-semantic-v1','commerce-semantic-v2','commerce-semantic-v3'] as const;
const fingerprint=(snapshot:ReturnType<typeof buildSnapshot>)=>sourceFingerprint(snapshot,snapshot.orders.filter(value=>value.incidentMember).map(value=>value.id),['evidence-finding-carrier-v1']);

for(const semanticModelVersion of versions){
  test(`unchanged ${semanticModelVersion} finding retains its source semantics with current actor authority`,()=>{
    const dataset=createSeedDataset(actor.tenantId),saved=buildSnapshot(dataset,{...snapshotContext(actor,dataset),semanticModelVersion});
    const oldContext:QueryContext={...saved.context,roleScope:'viewer',rolePolicyVersion:'roles-v1:1',cohortVersion:-1,knownAt:'2020-01-01T00:00:00.000Z'};
    const original=JSON.stringify(oldContext),current=currentFindingSnapshot(actor,dataset,oldContext);
    assert.equal(current.context.semanticModelVersion,semanticModelVersion);assert.equal(fingerprint(current),fingerprint(saved));
    assert.equal(current.context.roleScope,actor.role);assert.equal(current.context.rolePolicyVersion,'roles-v1:3');assert.equal(current.context.tenantId,actor.tenantId);
    assert.equal(current.context.cohortVersion,dataset.revision);assert.equal(current.context.knownAt,saved.context.knownAt);assert.equal(current.context.asOf,saved.context.asOf);assert.equal(current.context.currency,saved.context.currency);assert.equal(current.context.clockDomain,saved.context.clockDomain);
    assert.equal(JSON.stringify(oldContext),original,'Reading current source must not rewrite the saved context.');
  });
  test(`actual source amendments still change the ${semanticModelVersion} finding at current knowledge`,()=>{
    const dataset=createSeedDataset(actor.tenantId),saved=buildSnapshot(dataset,{...snapshotContext(actor,dataset),semanticModelVersion}),revised=applyDeliveryRevision(dataset),current=currentFindingSnapshot(actor,revised,saved.context);
    assert.equal(saved.totals.affected,63);assert.equal(current.totals.affected,54);assert.equal(current.removedOrderIds.length,9);assert.notEqual(fingerprint(current),fingerprint(saved));
    assert.equal(current.context.semanticModelVersion,semanticModelVersion);assert.equal(current.context.cohortVersion,revised.revision);assert(Date.parse(current.context.knownAt)>Date.parse(saved.context.knownAt),'The saved semantic version must not pin stale knowledge.');
    assert.equal(current.context.rolePolicyVersion,'roles-v1:3');
  });
}

test('new finding source intents retain current v3 semantics without a saved context',()=>{
  const dataset=createSeedDataset(actor.tenantId),current=currentFindingSnapshot(actor,dataset);
  assert.equal(current.context.semanticModelVersion,'commerce-semantic-v3');assert.equal(current.context.roleScope,actor.role);assert.equal(current.context.rolePolicyVersion,'roles-v1:3');
});
