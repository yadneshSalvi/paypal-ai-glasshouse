import { database,type Database } from '@/packages/db/client';
import { buildSnapshot } from '@/packages/domain';
import { buildOrderDetail,type StoredProviderObservation } from '@/packages/domain/order-detail';
import type { Actor,QueryContext } from '@/packages/domain/types';
import { datasetFor } from './repository';
import { recoveryMember } from './recovery/authority';
import { HttpError } from './errors';

/** Rebuild the saved manifest against one dataset read; never substitute a latest order row. */
export async function orderDetailFor(actor:Actor,orderId:string,snapshotHash:string,connection?:Database){
  if(!/^[a-f0-9]{64}$/.test(snapshotHash))throw new HttpError(400,'SNAPSHOT_REQUIRED','Open this order from a current or saved investigation snapshot.');
  const db=connection??await database();
  actor=await recoveryMember(db,actor);
  const manifest=(await db.query<{context:QueryContext}>('SELECT context FROM gh_snapshots WHERE tenant_id=$1 AND hash=$2',[actor.tenantId,snapshotHash]))[0];
  if(!manifest||manifest.context.tenantId!==actor.tenantId)throw new HttpError(404,'SNAPSHOT_NOT_FOUND','This snapshot is outside your workspace.');
  if(manifest.context.roleScope!==actor.role||manifest.context.rolePolicyVersion!==`roles-v1:${actor.membershipVersion}`)throw new HttpError(409,'SNAPSHOT_AUTHORITY_CHANGED','Workspace access changed. Refresh the investigation before opening its evidence.');
  const dataset=await datasetFor(actor,db),snapshot=buildSnapshot(dataset,manifest.context);
  if(snapshot.hash!==snapshotHash)throw new HttpError(409,'SNAPSHOT_CHANGED','This saved evidence context could not be reconstructed. Refresh the investigation.');
  if(!snapshot.orders.some(order=>order.id===orderId))throw new HttpError(404,'ORDER_NOT_VISIBLE','This order is outside the selected time, evidence cutoff or workspace.');
  const rows=await db.query<{tenant_id:string;order_id:string;resource_id:string;kind:string;body_hash:string;observed_at:string|Date;body:Record<string,unknown>}>(
    'SELECT tenant_id,order_id,resource_id,kind,body_hash,observed_at,body FROM gh_provider_observations WHERE tenant_id=$1 AND order_id=$2 AND observed_at<=$3 ORDER BY observed_at',
    [actor.tenantId,orderId,snapshot.context.knownAt]);
  const observations:StoredProviderObservation[]=rows.map(row=>({tenantId:row.tenant_id,orderId:row.order_id,resourceId:row.resource_id,kind:row.kind,bodyHash:row.body_hash,observedAt:new Date(row.observed_at).toISOString(),body:row.body}));
  return buildOrderDetail(dataset,snapshot,orderId,observations)!;
}
