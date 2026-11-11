import {database} from '@/packages/db/client';
import {HttpError} from '../errors';
import {ensurePaymentsSchema} from '../payments/schema';
import {ensureAgentsSchema} from './schema';
import {AgentSecrets} from './security';
import {AgentJournal} from './journal';
import {AgentModels} from './model-service';
import {OpenAIBackgroundProvider} from './provider';
import {ScopedPayPalToolkit} from './toolkit';
import {AgentTools} from './tools';
import {AgentThreads} from './threads';

let instance:Promise<ReturnType<typeof services>>|undefined;
function services(journal:AgentJournal,models:AgentModels,tools:AgentTools,threads:AgentThreads){return {journal,models,tools,threads};}
async function initialize(){
  const key=process.env.GLASSHOUSE_AGENT_KEY||process.env.GLASSHOUSE_PAYMENT_KEY;
  if(!key)throw new HttpError(503,'AGENT_STORAGE_KEY_REQUIRED','Encrypted investigation storage is not configured. The manual workspace remains available.');
  if(process.env.GLASSHOUSE_AGENT_TEST_MODE==='synthetic'&&(!process.env.GLASSHOUSE_AGENT_ISOLATED_QA||process.env.OPENAI_API_KEY||process.env.PAYPAL_CLIENT_ID||process.env.PAYPAL_CLIENT_SECRET))throw new HttpError(503,'AGENT_QA_ISOLATION_REQUIRED','Synthetic qualification requires an isolated database and blank provider credentials.');
  const db=await database();await ensurePaymentsSchema(db);await ensureAgentsSchema(db);
  const journal=new AgentJournal(db,new AgentSecrets(key));
  const configured=process.env.GLASSHOUSE_TOOLKIT_READS_ENABLED==='true'&&process.env.PAYPAL_PROJECT_ISOLATED==='true'&&process.env.PAYPAL_ENVIRONMENT==='sandbox'&&process.env.PAYPAL_API_BASE_URL==='https://api-m.sandbox.paypal.com'&&!!process.env.PAYPAL_CLIENT_ID&&!!process.env.PAYPAL_CLIENT_SECRET;
  const provider=process.env.OPENAI_API_KEY?new OpenAIBackgroundProvider(process.env.OPENAI_API_KEY):null;
  return services(journal,new AgentModels(journal,provider),new AgentTools(journal,configured?new ScopedPayPalToolkit(process.env.PAYPAL_CLIENT_ID!,process.env.PAYPAL_CLIENT_SECRET!):null),new AgentThreads(journal));
}
export function agentRuntime(){instance??=initialize().catch(error=>{instance=undefined;throw error;});return instance;}
