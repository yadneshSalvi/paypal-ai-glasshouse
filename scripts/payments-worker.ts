import { paymentsRuntime } from '../lib/server/payments/runtime';

const stop=new AbortController();
process.on('SIGINT',()=>stop.abort());
process.on('SIGTERM',()=>stop.abort());
const once=process.argv.includes('--once');
const argument=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const tenantId=argument('tenant');
const runId=argument('run');
const bounded=(name:string,fallback:number,maximum:number)=>{
  const raw=argument(name);
  const value=raw===undefined?fallback:Number(raw);
  if(!Number.isSafeInteger(value)||value<1||value>maximum)throw new Error(`--${name} must be an integer from 1 to ${maximum}.`);
  return value;
};
const limit=bounded('limit',40,60);
const concurrency=bounded('concurrency',3,4);
const runtime=await paymentsRuntime();
if(!runtime.executor)throw new Error('The isolated sandbox is not configured.');
do {
  const result=await runtime.executor.drain({tenantId,runId,limit,concurrency,signal:stop.signal});
  console.log(JSON.stringify({worker:'glasshouse-payments',...result,at:new Date().toISOString()}));
  if(once || stop.signal.aborted)break;
  await new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);stop.signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,result.claimed?500:5000);
    stop.signal.addEventListener('abort',done,{once:true});
  });
} while(!stop.signal.aborted);
process.exit(0);
