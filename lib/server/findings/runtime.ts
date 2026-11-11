import {database,type Database} from '@/packages/db/client';
import {HttpError} from '../errors';
import {AgentSecrets} from '../agents/security';
import {FindingSecrets} from './crypto';
import {FindingService} from './service';
import {requireFindingsSchema} from './schema';
export function findingService(db:Database){
  const key=process.env.GLASSHOUSE_FINDING_KEY||process.env.GLASSHOUSE_AGENT_KEY||process.env.GLASSHOUSE_PAYMENT_KEY;
  const agentKey=process.env.GLASSHOUSE_AGENT_KEY||process.env.GLASSHOUSE_PAYMENT_KEY||key;
  if(!key||!agentKey)throw new HttpError(503,'FINDING_STORAGE_REQUIRED','Encrypted finding storage is not configured. Saved source evidence remains available.');
  return new FindingService(db,new FindingSecrets(key),new AgentSecrets(agentKey));
}
export async function findingRuntime(){const db=await database();await requireFindingsSchema(db);return findingService(db);}
