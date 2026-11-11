import { mkdir,writeFile } from 'node:fs/promises';
import { recoveryRuntime } from '../lib/server/recovery/runtime';
import type { RecoveryIntent } from '../lib/server/recovery/contracts';

// Safe diagnostic of an already-dispatched original refund. No provider mutation.
const argument=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const tenantId=argument('tenant'),operationId=argument('operation');
if(!tenantId||!operationId)throw new Error('Choose an exact tenant and original operation.');
const runtime=await recoveryRuntime();
const row=(await runtime.service.db.query<RecoveryIntent>('SELECT * FROM gh_recovery_intents WHERE tenant_id=$1 AND id=$2',[tenantId,operationId]))[0];
if(!row||row.kind!=='refund'||!row.provider_id)throw new Error('An original refund with a known provider identity is required.');
const command=row.command,owned=command.owned;
const refund=await runtime.providers!.sdk.client.payments.getRefund({refundId:row.provider_id}).asApiResult();
const order=await runtime.providers!.evidence.order(owned.providerOrderId,owned.entry,owned.customId);
const capture=await runtime.providers!.sdk.client.payments.getCapturedPayment({captureId:owned.captureId}).asApiResult();
const report={observedAt:new Date().toISOString(),originalOperation:operationId,expectedCapture:owned.captureId,expectedOrder:owned.providerOrderId,
  ownOrder:{id:order.id,captureIds:order.captureIds,refundIds:order.refundIds},
  capture:capture.ok?{httpStatus:capture.status,id:capture.value.id,status:capture.value.status,amount:capture.value.amount,relatedOrderId:capture.value.supplementaryData?.relatedIds?.orderId??null}:{httpStatus:capture.status},
  refund:refund.ok?{httpStatus:refund.status,id:refund.value.id,status:refund.value.status,amount:refund.value.amount,
    customIdMatches:refund.value.customId===operationId,createdAt:refund.value.createTime,
    links:refund.value.links?.map(link=>{const url=new URL(link.href);return {rel:link.rel,method:link.method,origin:url.origin,path:url.pathname,hasQuery:!!url.search,hasHash:!!url.hash};})
  }:{httpStatus:refund.status}};
await mkdir('.setup-evidence',{recursive:true});
const file=`.setup-evidence/glasshouse-refund-probe-${operationId}-${Date.now()}.json`;
await writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({...report,evidenceFile:file}));
process.exit(0);
