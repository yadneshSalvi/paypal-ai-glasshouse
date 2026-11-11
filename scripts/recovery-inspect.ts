import { mkdir, writeFile } from 'node:fs/promises';
import { recoveryRuntime } from '../lib/server/recovery/runtime';
import { ownedPaymentResource } from '../lib/server/recovery/authority';
import type { RecoveryIntent } from '../lib/server/recovery/contracts';
import { evidenceObserved } from '../lib/server/recovery/disputes';
import { PaymentError, ProviderError } from '@fracture/paypal-core';
import { HttpError } from '../lib/server/errors';

// Read-only inspection. It never approves, enqueues, reconciles or resends an operation.
const argument=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const tenantId=argument('tenant'),planId=argument('plan'),operationId=argument('operation');
if(!tenantId||!planId)throw new Error('An exact --tenant and --plan are required.');
const runtime=await recoveryRuntime(),db=runtime.service.db;
const plan=(await db.query('SELECT id,status,body FROM gh_plans WHERE tenant_id=$1 AND id=$2',[tenantId,planId]))[0];
if(!plan)throw new Error('The requested plan was not found in this workspace.');
const body=plan.body as Record<string,unknown>;
const progress=await db.query(`SELECT kind,status,count(*)::int AS count,
  sum((command->'action'->>'amountMinor')::bigint)::text AS amount_minor
  FROM gh_recovery_intents WHERE tenant_id=$1 AND plan_id=$2 GROUP BY kind,status ORDER BY kind,status`,[tenantId,planId]);
const rows=await db.query<RecoveryIntent>(`SELECT * FROM gh_recovery_intents WHERE tenant_id=$1 AND plan_id=$2${operationId?' AND id=$3':''} ORDER BY created_at,id`,operationId?[tenantId,planId,operationId]:[tenantId,planId]);
if(operationId&&!rows.length)throw new Error('The original operation is not part of this exact plan.');
const independentlyRead:Record<string,unknown>[]=[];
if(process.argv.includes('--verify'))for(const row of rows.filter(row=>row.status==='provider_success')){
  try{
    const owned=await ownedPaymentResource(db,tenantId,row.order_id);
    let observation:unknown,matched=true;
    if(row.kind==='refund'){
      if(!row.provider_id)throw new Error('A verified refund must retain its original provider identity.');
      observation=await runtime.recoveryEvidence.refund(row.provider_id,owned,row.id,row.command.action.amountMinor);
    }else if(row.kind==='tracking'){
      if(!row.provider_id||!row.command.tracking)throw new Error('A verified tracking operation must retain its original assignment.');
      observation=await runtime.recoveryEvidence.tracking(owned,row.command.tracking,row.provider_id);
    }else{
      if(!row.command.evidence)throw new Error('A verified case response must retain its original evidence statement.');
      const value=await runtime.disputes.get(row.command.evidence.disputeId,{captureId:owned.captureId,amountMinor:owned.entry.amountMinor,currency:'USD'});
      matched=evidenceObserved(value,row.command.evidence);
      const {buyerTransactionId:_,...safe}=value;observation=safe;
    }
    independentlyRead.push({operationId:row.id,reference:row.command.action.reference,kind:row.kind,matched,observation});
  }catch(error){
    independentlyRead.push({operationId:row.id,reference:row.command.action.reference,kind:row.kind,matched:false,
      reason:error instanceof ProviderError||error instanceof PaymentError||error instanceof HttpError?error.message:'The independent read did not confirm this original result.'});
  }
}
const report={observedAt:new Date().toISOString(),tenantId,plan:{id:plan.id,status:plan.status,hash:body.hash,expiresAt:body.expiresAt,executionMode:body.executionMode},
  progress,operations:rows.map(row=>({id:row.id,reference:row.command.action.reference,kind:row.kind,status:row.status,providerId:row.provider_id,
    amountMinor:row.command.action.amountMinor,attempt:row.attempt,reason:row.reason,receipt:row.receipt})),independentlyRead};
await mkdir('.setup-evidence',{recursive:true});
const file=`.setup-evidence/glasshouse-recovery-${planId}-${Date.now()}.json`;
await writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const summary=process.argv.includes('--summary');
console.log(JSON.stringify({...report,
  operations:summary?report.operations.filter(row=>['unknown_outcome','provider_failed','blocked'].includes(row.status)):report.operations.filter(row=>row.status!=='queued'||operationId),
  independentlyRead:summary?{count:independentlyRead.length,matched:independentlyRead.filter(row=>row.matched===true).length,unconfirmed:independentlyRead.filter(row=>row.matched!==true)}:independentlyRead,
  evidenceFile:file}));
process.exit(independentlyRead.some(row=>row.matched===false)?1:0);
