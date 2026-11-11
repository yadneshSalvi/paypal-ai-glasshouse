import { recoveryRuntime } from '../recovery/runtime';
import { database } from '@/packages/db/client';
import { PaymentSecrets } from '@/packages/payments/security';
import { ensurePaymentsSchema } from '../payments/schema';
import { ensureRecoverySchema } from '../recovery/schema';
import { bindConnector, configuredConnector } from './connector';
import { ensureObservationSchema } from './schema';
import { ObservationService } from './service';
import { ObservationWorker } from './worker';
import { BoundedWebhookVerifier } from './webhook';

let pending: ReturnType<typeof initialize>|undefined;
async function initialize() {
  const db = await database();
  await ensurePaymentsSchema(db);
  await ensureRecoverySchema(db);
  await ensureObservationSchema(db);
  const key = process.env.GLASSHOUSE_PAYMENT_KEY, secrets = key ? new PaymentSecrets(key) : null;
  const providerConfigured = process.env.PAYPAL_PROJECT_ISOLATED === 'true' && process.env.PAYPAL_ENVIRONMENT === 'sandbox' &&
    process.env.PAYPAL_API_BASE_URL === 'https://api-m.sandbox.paypal.com' && Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  if (!providerConfigured || !secrets) return {service:new ObservationService(db,secrets),worker:null,connector:null,verifier:null};
  const runtime = await recoveryRuntime();
  const connector = configuredConnector();
  if (connector) await bindConnector(db,connector);
  const service = new ObservationService(db,runtime.service.secrets,connector);
  const worker = new ObservationWorker({db,secrets:runtime.service.secrets,connector,recovery:runtime.recoveryExecutor,evidence:runtime.recoveryEvidence,disputes:runtime.disputes});
  const verifier = connector ? new BoundedWebhookVerifier({environment:'sandbox',baseUrl:'https://api-m.sandbox.paypal.com',isolatedProject:'glasshouse',
    clientId:process.env.PAYPAL_CLIENT_ID!,clientSecret:process.env.PAYPAL_CLIENT_SECRET!},connector.webhookId) : null;
  return {service,worker,connector,verifier};
}
export function observationRuntime() {
  pending ??= initialize().catch(error => {pending = undefined;throw error;});
  return pending;
}
