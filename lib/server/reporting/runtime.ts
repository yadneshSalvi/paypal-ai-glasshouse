import {database} from '@/packages/db/client';
import {paymentsRuntime} from '../payments/runtime';
import {observationRuntime} from '../observations/runtime';
import {ReportingGateway} from './gateway';
import {ensureReportingSchema} from './schema';
import {ReportingService} from './service';
let pending:Promise<ReportingService>|undefined;
export function reportingRuntime(){return pending??=initialize().catch(e=>{pending=undefined;throw e;});}
async function initialize(){const db=await database();const observations=await observationRuntime();await ensureReportingSchema(db);
 const payments=await paymentsRuntime();return new ReportingService(db,observations.connector,payments.providers?new ReportingGateway(payments.providers.sdk.client):null);}
