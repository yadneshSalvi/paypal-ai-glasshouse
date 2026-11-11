import {database} from '@/packages/db/client';
import {HttpError} from '../errors';
import {AgentSecrets} from '../agents/security';
import {ReportSecrets} from './crypto';
import {ReportService} from './service';
import {requireReportsSchema} from './schema';
import {REPORT_RENDERER_VERSION,renderReportPdf} from './pdf';

export async function reportRuntime(){
  const key=process.env.GLASSHOUSE_REPORT_KEY||process.env.GLASSHOUSE_PAYMENT_KEY,agentKey=process.env.GLASSHOUSE_AGENT_KEY||process.env.GLASSHOUSE_PAYMENT_KEY;
  if(!key||!agentKey)throw new HttpError(503,'REPORT_STORAGE_KEY_REQUIRED','Encrypted report storage is not configured. The investigation remains available.');
  const db=await database();await requireReportsSchema(db);
  return new ReportService(db,new ReportSecrets(key),new AgentSecrets(agentKey),{version:REPORT_RENDERER_VERSION,render:renderReportPdf});
}
