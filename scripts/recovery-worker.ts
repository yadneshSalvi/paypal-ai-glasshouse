import { recoveryRuntime } from '../lib/server/recovery/runtime';
import type { ActionKind } from '../packages/domain/types';

const stop=new AbortController();
process.on('SIGINT',()=>stop.abort());process.on('SIGTERM',()=>stop.abort());
const argument=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const bounded=(name:string,fallback:number,maximum:number)=>{const value=Number(argument(name)??fallback);if(!Number.isSafeInteger(value)||value<1||value>maximum)throw new Error(`--${name} must be an integer from 1 to ${maximum}.`);return value;};
const tenantId=argument('tenant'),planId=argument('plan'),operationId=argument('operation'),kind=argument('kind') as ActionKind|undefined;
if(kind&&!['refund','tracking','dispute_response'].includes(kind))throw new Error('Choose an exact --kind=refund,tracking,dispute_response.');
const runtime=await recoveryRuntime();
do{
  const result=await runtime.recoveryExecutor.drain({tenantId,planId,kind,operationId,limit:bounded('limit',20,40),concurrency:bounded('concurrency',2,3),signal:stop.signal});
  console.log(JSON.stringify({worker:'glasshouse-recovery',...result,at:new Date().toISOString()}));
  if(process.argv.includes('--once')||stop.signal.aborted)break;
  await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);stop.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,result.claimed?500:5000);stop.signal.addEventListener('abort',done,{once:true});});
}while(!stop.signal.aborted);
process.exit(0);
