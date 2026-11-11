import { HttpError } from '../errors';
import { paymentsRuntime } from '../payments/runtime';
import { DisputesGateway } from './disputes';
import { DisputeService } from './dispute-service';
import { ensureRecoverySchema } from './schema';
import { RecoveryService } from './service';
import { RecoveryExecutor } from './execution';
import { RecoveryEvidenceGateway } from './evidence';

let runtimePromise: ReturnType<typeof initialize> | undefined;
async function initialize() {
  const payments = await paymentsRuntime();
  if (!payments.providers) throw new HttpError(503,'SANDBOX_NOT_CONFIGURED','Connect the isolated Glasshouse sandbox to read or execute recovery evidence.');
  await ensureRecoverySchema(payments.service.db);
  const disputes = new DisputesGateway(process.env.PAYPAL_CLIENT_ID!,process.env.PAYPAL_CLIENT_SECRET!,payments.providers.transport);
  const disputeService = new DisputeService(payments.service.db,disputes,payments.providers.evidence);
  const recoveryService=new RecoveryService(payments.service.db,payments.service.secrets);
  const recoveryEvidence=new RecoveryEvidenceGateway(payments.providers.sdk.client,payments.providers.evidence,payments.providers.transport);
  const recoveryExecutor=new RecoveryExecutor({service:recoveryService,store:payments.providers.store,provider:payments.providers.sdk,transport:payments.providers.transport,evidence:recoveryEvidence,disputes});
  return { ...payments, disputes, disputeService, recoveryService, recoveryEvidence, recoveryExecutor };
}
export function recoveryRuntime() {
  runtimePromise ??= initialize().catch(error=>{runtimePromise=undefined;throw error;});
  return runtimePromise;
}
