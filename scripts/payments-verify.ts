import { mkdir, writeFile } from 'node:fs/promises';
import { paymentsRuntime } from '../lib/server/payments/runtime';
import { runRecord, type ItemRecord } from '../lib/server/payments/records';
import { seedMarker } from '../lib/server/payments/execution';

const argument=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const tenantId=argument('tenant');
const runId=argument('run');
if(!tenantId||!runId||!/^[a-zA-Z0-9_-]+$/.test(tenantId)||!/^[a-zA-Z0-9_-]+$/.test(runId))throw new Error('Provide the exact --tenant and --run identities.');
const runtime=await paymentsRuntime();
if(!runtime.executor)throw new Error('The isolated sandbox is not configured.');
const run=await runRecord(runtime.service.db,tenantId,runId);
const items=await runtime.service.db.query<ItemRecord>('SELECT * FROM gh_seed_items WHERE tenant_id=$1 AND run_id=$2 ORDER BY order_id',[tenantId,runId]);
const first=items.find(item=>item.order_id===run.manifest.entries[0].orderId);
let firstProviderRead=null;
if(first?.status==='captured'&&first.provider_order_id&&first.provider_capture_id){
  const order=await runtime.executor.options.evidence.order(first.provider_order_id,first.entry,seedMarker(tenantId,runId,first.order_id));
  const capture=await runtime.executor.options.evidence.capture(first.provider_capture_id,order,first.entry);
  firstProviderRead={reference:first.entry.reference,order,capture};
}
const operations=(await runtime.executor.options.store.list({tenantId,projectId:'glasshouse'})).filter(operation=>operation.command.businessKey.startsWith(`seed:${runId}:`));
const captured=items.filter(item=>item.status==='captured');
const states:Record<string,number>={};
for(const item of items)states[item.status]=(states[item.status]??0)+1;
const operationStates:Record<string,number>={};
for(const operation of operations){const key=`${operation.command.action.kind}:${operation.status}`;operationStates[key]=(operationStates[key]??0)+1;}
const report={
  observedAt:new Date().toISOString(),source:'sandbox',transport:'apimatic_sdk',tenantId,runId,
  status:run.status,manifestHash:run.manifest_hash,approvalVersion:run.approval_version,approvalExpiresAt:run.approval_expires_at,
  expectedCount:run.manifest.entryCount,expectedMinor:run.manifest.totalMinor,maximumOrderMinor:run.manifest.maximumOrderMinor,
  states,capturedMinor:captured.reduce((sum,item)=>sum+item.entry.amountMinor,0),
  distinctOrderIds:new Set(captured.map(item=>item.provider_order_id)).size,
  distinctCaptureIds:new Set(captured.map(item=>item.provider_capture_id)).size,
  allCapturedReceiptsMatch:captured.every(item=>!!item.provider_order_id&&!!item.provider_capture_id&&item.receipt?.id===item.provider_capture_id&&item.receipt?.orderId===item.provider_order_id&&item.receipt?.status==='COMPLETED'&&item.receipt?.amountMinor===item.entry.amountMinor&&item.receipt?.currency===item.entry.currency),
  operationStates,
  heldEntries:items.filter(item=>['unknown','refused','held','awaiting_buyer'].includes(item.status)).map(item=>({reference:item.entry.reference,status:item.status,reason:item.reason})),
  firstProviderRead,
  firstOperations:operations.filter(operation=>first&&operation.command.intentId===`seed:${runId}:${first.order_id}`).map(operation=>({kind:operation.command.action.kind,status:operation.status,operationId:operation.command.operationId,providerRequestId:operation.command.providerRequestId,receipt:operation.receipt?{status:operation.receipt.status,source:operation.receipt.source,transport:operation.receipt.transport,observedAt:operation.receipt.observedAt,debugId:operation.receipt.debugId,bodyHash:operation.receipt.bodyHash}:null,error:operation.error})),
};
await mkdir('.setup-evidence',{recursive:true});
await writeFile(`.setup-evidence/glasshouse-seed-verification-${runId}.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report));
process.exit(0);
