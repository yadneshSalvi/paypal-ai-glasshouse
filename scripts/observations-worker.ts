import { observationRuntime } from '../lib/server/observations/runtime';

const stop = new AbortController();
process.on('SIGINT',() => stop.abort());process.on('SIGTERM',() => stop.abort());
const argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length+3);
const tenantId = argument('tenant'), jobId = argument('job'), limit = Number(argument('limit') ?? 20);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40 || jobId && !tenantId) throw new Error('Choose --limit=1..40 and include --tenant when selecting --job.');
const runtime = await observationRuntime();
const worker = runtime.worker;
if (!worker) throw new Error('Connect the isolated sandbox and private receipt storage before starting independent provider reads.');
do {
  const result = await worker.drain({tenantId,jobId,limit,signal:stop.signal});
  console.log(JSON.stringify({worker:'glasshouse-independent-observations',...result,at:new Date().toISOString()}));
  if (process.argv.includes('--once') || stop.signal.aborted) break;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer);stop.signal.removeEventListener('abort',done);resolve(); };
    const timer = setTimeout(done,result.claimed?500:5000);stop.signal.addEventListener('abort',done,{once:true});
  });
} while (!stop.signal.aborted);
process.exit(0);
