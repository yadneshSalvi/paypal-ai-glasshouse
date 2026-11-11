import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryHarness } from './helpers/recovery';
import { capabilities } from '../lib/server/capabilities';

test('capabilities require actual scoped receipt evidence; configuration flags and foreign observations cannot claim success',async t=>{
  const h=await recoveryHarness();t.after(()=>h.pg.close());
  const configuration={PAYPAL_PROJECT_ISOLATED:'true',PAYPAL_CLIENT_ID:'fixture',PAYPAL_CLIENT_SECRET:'fixture',PAYPAL_REFUNDS_VERIFIED:'true',PAYPAL_TRACKING_VERIFIED:'true',PAYPAL_DISPUTES_VERIFIED:'true',PAYPAL_WEBHOOK_ID:'configured-but-unobserved'};
  const initial=await capabilities(h.who,h.db,configuration);
  assert.equal(initial.paypal.available,true);assert.equal(initial.refunds.available,false);assert.equal(initial.tracking.available,false);assert.equal(initial.disputes.available,false);assert.equal(initial.webhooks.available,false);
  const plan=await h.plan();await h.approveAndQueue(plan);await h.worker().drain({tenantId:h.who.tenantId,planId:plan.id,limit:4});
  const current=await capabilities(h.who,h.db,configuration);
  assert.equal(current.refunds.available,true);assert.equal(current.refunds.verifiedCount,1);assert.equal(current.tracking.verifiedCount,1);assert.equal(current.disputes.available,false);
  // Re-reading a successful result does not increase the number of proven resources.
  await h.db.query(`INSERT INTO gh_provider_observations(tenant_id,id,order_id,resource_id,kind,observed_at,body_hash,body)
    SELECT tenant_id,id||'-reread',order_id,resource_id,kind,observed_at,body_hash,body FROM gh_provider_observations WHERE kind='refund' ON CONFLICT DO NOTHING`);
  assert.equal((await capabilities(h.who,h.db,configuration)).refunds.verifiedCount,1);
  const foreign={...h.who,tenantId:'foreign-workspace'};
  await h.db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,$4)',[foreign.tenantId,foreign.id,foreign.role,foreign.membershipVersion]);
  const other=await capabilities(foreign,h.db,configuration);assert.equal(other.paypal.available,false);assert.equal(other.refunds.available,false);assert.equal(other.tracking.available,false);
  assert.equal((await capabilities(h.who,h.db,{...configuration,PAYPAL_PROJECT_ISOLATED:'false'})).refunds.available,false);
});
