import { mkdir, writeFile } from 'node:fs/promises';
import { ProviderError } from '@fracture/paypal-core';
import type { Actor, Role } from '../packages/domain/types';
import { HttpError } from '../lib/server/errors';
import { recoveryRuntime } from '../lib/server/recovery/runtime';

const args = Object.fromEntries(process.argv.slice(2).map(value=>{const index=value.indexOf('=');return[index<0?value:value.slice(0,index),index<0?'':value.slice(index+1)];}));
const tenantId = args['--tenant'];
const references = args['--references']?.split(',') ?? [];
const disputeId=args['--case'];
if (!tenantId || !/^[A-Za-z0-9_-]{1,128}$/.test(tenantId) || !references.length || references.length>63 || references.some(value=>!/^FW-\d{6}$/.test(value))) throw new Error('Provide --tenant and an exact comma-separated --references=FW-106010,... scope.');
if(disputeId&&(references.length!==1||!/^PP-[A-Z0-9-]{3,100}$/.test(disputeId)))throw new Error('An exact --case=PP-... requires one owned reference.');
const runtime = await recoveryRuntime();
const db = runtime.service.db;
const results: unknown[] = [];
for (const reference of references) {
  const row = (await db.query<{order_id:string;approved_by:string;role:Role;version:number}>(`SELECT i.order_id,r.approved_by,m.role,m.version FROM gh_seed_items i
    JOIN gh_seed_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id
    JOIN gh_memberships m ON m.tenant_id=r.tenant_id AND m.actor_id=r.approved_by AND m.active=true
    WHERE i.tenant_id=$1 AND i.entry->>'reference'=$2 AND i.status='captured'`,[tenantId,reference]))[0];
  if (!row) { results.push({reference,status:'held',reason:'No current owned capture and membership.'});continue; }
  const actor:Actor = {id:row.approved_by,tenantId,role:row.role,membershipVersion:row.version};
  try {
    const result = disputeId?await runtime.disputeService.syncCase(actor,row.order_id,disputeId):await runtime.disputeService.syncOrder(actor,row.order_id);
    results.push({reference,status:'read_verified',...result});
  } catch(error) {
    results.push({reference,status:'held',reason:error instanceof ProviderError||error instanceof HttpError?error.message:'The original provider read was not qualified.',httpStatus:error instanceof ProviderError?error.httpStatus:error instanceof HttpError?error.status:null});
  }
}
const report={observedAt:new Date().toISOString(),source:'sandbox',transport:'typed_rest',scope:references,results};
await mkdir('.setup-evidence',{recursive:true,mode:0o700});
await writeFile(`.setup-evidence/glasshouse-disputes-${tenantId}-${Date.now()}.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report));
process.exit(0);
