import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Validate identity before importing any application module. This entry point
// always refuses financial provider credentials and original/hosted databases.
const [mode='start',filename='.setup-evidence/agents-stage5/isolated.env',...flags]=process.argv.slice(2);
if(!['build','start','dev','migrate'].includes(mode)||flags.some(flag=>flag!=='--live-model'))throw new Error('Use agents-qa.mjs build|start|dev|migrate [private isolated env] [--live-model].');
const values=parseEnv(await readFile(filename,'utf8')),url=new URL(values.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^\/gh_agents_stage5_[a-f0-9]{12}$/.test(url.pathname)||!/^ghas5_[a-f0-9]{12}$/.test(url.username)||values.GLASSHOUSE_AGENT_ISOLATED_QA!==url.pathname.slice(1)||!/^glasshouse_agents_[a-f0-9]{12}$/.test(values.GLASSHOUSE_SESSION_COOKIE||''))throw new Error('An exact isolated Glasshouse agent database and cookie are required.');
if(values.PAYPAL_CLIENT_ID||values.PAYPAL_CLIENT_SECRET||values.GEMINI_API_KEY||values.GOOGLE_API_KEY)throw new Error('This local QA entry point refuses provider credentials other than an explicitly enabled model.');
if(!!values.OPENAI_API_KEY!==flags.includes('--live-model'))throw new Error('A nonempty private model key requires the explicit --live-model qualification flag; blank credentials must omit it.');
if(!values.GLASSHOUSE_AGENT_KEY||!values.GLASSHOUSE_PAYMENT_KEY||!values.AUTH_SECRET||!values.JUDGE_SESSION_SECRET)throw new Error('Persisted isolated storage and session keys are required.');
const env={...process.env,...values,PORT:'4507',PAYPAL_CLIENT_ID:'',PAYPAL_CLIENT_SECRET:'',PAYPAL_PROJECT_ISOLATED:'false',PAYPAL_WEBHOOK_ID:'',PAYPAL_MERCHANT_ID:'',GLASSHOUSE_PAYPAL_TENANT_ID:'',GLASSHOUSE_OBSERVATION_TENANT_ID:'',GEMINI_API_KEY:'',GOOGLE_API_KEY:'',GLASSHOUSE_TOOLKIT_READS_ENABLED:'false',GLASSHOUSE_AGENT_WORKER_ENABLED:'false',CRON_SECRET:'',NEXT_TELEMETRY_DISABLED:'1',GLASSHOUSE_BUILD_DIRECTORY:'.next-agents-stage5',GLASSHOUSE_AGENT_MIGRATION_CONFIRM:'schema7-and-private-agent-documents'};
if(mode==='build'||mode==='migrate')env.OPENAI_API_KEY='';
env.GLASSHOUSE_AGENT_TEST_MODE='';env.GLASSHOUSE_AGENTS_TEST_PG='false';
if(mode==='build'||mode==='start')env.NODE_ENV='production';else if(mode==='dev')env.NODE_ENV='development';
const root=fileURLToPath(new URL('..',import.meta.url));
const args=mode==='migrate'?['--import','tsx','scripts/agents-migrate.ts']:['node_modules/next/dist/bin/next',mode,...(mode==='start'||mode==='dev'?['--port','4507']:[])];
console.log(JSON.stringify({mode,port:4507,database:url.pathname.slice(1),cookie:'isolated',model:env.OPENAI_API_KEY?'live-explicit':'unavailable',financialProviders:'disabled'}));
const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
