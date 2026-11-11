import { SandboxPayPalProvider, SqlPaymentStore } from '@fracture/paypal-core';
import { database } from '@/packages/db/client';
import { PaymentSecrets } from '@/packages/payments/security';
import { HttpError } from '../errors';
import { coreDatabase, ensurePaymentsSchema } from './schema';
import { OneWriteTransport } from './transport';
import { VaultGateway } from './vault';
import { PaymentService } from './service';
import { OrderEvidenceGateway } from './evidence';
import { SeedExecutor } from './execution';

export interface PaymentsRuntime {
  service: PaymentService; executor: SeedExecutor | null;
  providers: { sdk: SandboxPayPalProvider; transport: OneWriteTransport; store: SqlPaymentStore; evidence: OrderEvidenceGateway } | null;
}
// Module lifetime retains OAuth reuse in production and permits safe code refreshes in development.
let runtimePromise: Promise<PaymentsRuntime> | undefined;

async function initialize(): Promise<PaymentsRuntime> {
  const db = await database();
  await ensurePaymentsSchema(db);
  const key = process.env.GLASSHOUSE_PAYMENT_KEY;
  if (!key) throw new HttpError(503,'PAYMENT_STORAGE_KEY_REQUIRED','Private payment storage is not configured. The investigation workspace remains available.');
  const secrets = new PaymentSecrets(key);
  const isolated = process.env.PAYPAL_PROJECT_ISOLATED === 'true';
  const configured = isolated && process.env.PAYPAL_ENVIRONMENT === 'sandbox' && process.env.PAYPAL_API_BASE_URL === 'https://api-m.sandbox.paypal.com' && Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  if (!configured) {
    const unavailable = async (): Promise<never> => { throw new HttpError(503,'SANDBOX_NOT_CONFIGURED','Connect the isolated Glasshouse sandbox to continue.'); };
    return {service:new PaymentService({db,secrets,configured:false,isolated,vault:{createSetup:unavailable,getSetup:unavailable,exchange:unavailable,getToken:unavailable,listTokens:unavailable,baselineTokens:unavailable}}),executor:null,providers:null};
  }
  const transport = new OneWriteTransport();
  const sdk = new SandboxPayPalProvider({environment:'sandbox',baseUrl:'https://api-m.sandbox.paypal.com',clientId:process.env.PAYPAL_CLIENT_ID!,clientSecret:process.env.PAYPAL_CLIENT_SECRET!,isolatedProject:'glasshouse'},transport.fetch);
  const vault = new VaultGateway(sdk.client,transport);
  const service = new PaymentService({db,secrets,vault,configured,isolated});
  const store = new SqlPaymentStore(coreDatabase(db),{operationDocumentCodec:secrets.operationCodec()});
  await store.initialize();
  const evidence = new OrderEvidenceGateway(sdk.client);
  const executor = new SeedExecutor({service,store,provider:transport.provider(sdk),evidence});
  return {service,executor,providers:{sdk,transport,store,evidence}};
}
export function paymentsRuntime(): Promise<PaymentsRuntime> {
  runtimePromise ??= initialize().catch(error=>{runtimePromise=undefined;throw error;});
  return runtimePromise;
}
