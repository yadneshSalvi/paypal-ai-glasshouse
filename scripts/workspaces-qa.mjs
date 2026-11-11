import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const [mode='start',filename='.setup-evidence/organization-export-stage6/isolated.env',...flags]=process.argv.slice(2);
if(!['build','start','dev','migrate'].includes(mode)||flags.some(flag=>flag!=='--live-model'))throw new Error('Use workspaces-qa.mjs build|start|dev|migrate [private isolated env] [--live-model].');
const values=parseEnv(await readFile(filename,'utf8')),url=new URL(values.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^\/gh_agents_stage5_[a-f0-9]{12}$/.test(url.pathname)||!/^ghas5_[a-f0-9]{12}$/.test(url.username)||values.GLASSHOUSE_AGENT_ISOLATED_QA!==url.pathname.slice(1)||values.GLASSHOUSE_WORKSPACE_ISOLATED_QA!=='true'||!/^glasshouse_agents_[a-f0-9]{12}$/.test(values.GLASSHOUSE_SESSION_COOKIE||'')||values.PORT!=='4525')throw new Error('Exact dedicated workspace QA database/cookie and port4525 required.');
if(values.PAYPAL_CLIENT_ID||values.PAYPAL_CLIENT_SECRET||values.GEMINI_API_KEY||values.GOOGLE_API_KEY)throw new Error('Workspace QA refuses all financial provider credentials.');
if(!!values.OPENAI_API_KEY!==flags.includes('--live-model'))throw new Error('Only an explicitly enabled model qualification may load a model key.');
if(!values.GLASSHOUSE_AGENT_KEY||!values.GLASSHOUSE_PAYMENT_KEY||!values.AUTH_SECRET||!values.JUDGE_SESSION_SECRET)throw new Error('Stable isolated private storage and session keys are required.');
const env={...process.env,...values,PAYPAL_CLIENT_ID:'',PAYPAL_CLIENT_SECRET:'',PAYPAL_PROJECT_ISOLATED:'false',PAYPAL_WEBHOOK_ID:'',PAYPAL_MERCHANT_ID:'',GLASSHOUSE_PAYPAL_TENANT_ID:'',GLASSHOUSE_OBSERVATION_TENANT_ID:'',GEMINI_API_KEY:'',GOOGLE_API_KEY:'',GLASSHOUSE_TOOLKIT_READS_ENABLED:'false',GLASSHOUSE_AGENT_WORKER_ENABLED:'false',CRON_SECRET:'',NEXT_TELEMETRY_DISABLED:'1',GLASSHOUSE_BUILD_DIRECTORY:'.next-workspaces-stage6',GLASSHOUSE_AGENT_MIGRATION_CONFIRM:'schema7-and-private-agent-documents',GLASSHOUSE_WORKSPACE_MIGRATION_CONFIRM:'schema8-private-workspaces',GLASSHOUSE_REPORT_MIGRATION_CONFIRM:'schema9-immutable-reports',GLASSHOUSE_AGENT_TEST_MODE:'',GLASSHOUSE_AGENTS_TEST_PG:'false'};
if(mode==='build'||mode==='migrate')env.OPENAI_API_KEY='';
if(mode==='start'||mode==='build')env.NODE_ENV='production';else if(mode==='dev')env.NODE_ENV='development';
const root=fileURLToPath(new URL('..',import.meta.url));
console.log(JSON.stringify({mode,port:4525,database:url.pathname.slice(1),cookie:'isolated',model:env.OPENAI_API_KEY?'live-explicit':'unavailable',financialProviders:'disabled'}));
async function run(args){
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit'});
  const interrupt=()=>child.kill('SIGINT'),terminate=()=>child.kill('SIGTERM');process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve(code??(signal?1:0))));process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);return result;
}
if(mode==='migrate'){
  for(const script of ['scripts/agents-migrate.ts','scripts/workspaces-migrate.ts','scripts/reports-migrate.ts']){const status=await run(['--import','tsx',script]);if(status){process.exitCode=status;break;}}
}else process.exitCode=await run(['node_modules/next/dist/bin/next',mode,...(mode==='start'||mode==='dev'?['--port','4525']:[])]);
