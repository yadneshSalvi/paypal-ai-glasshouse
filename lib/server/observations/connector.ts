import type { Database } from '@/packages/db/client';
import type { Actor } from '@/packages/domain/types';
import { digest } from '@/packages/payments/security';
import { HttpError } from '../errors';

export interface ObservationConnector {
  id: string; tenantId: string; credentialHash: string; webhookId: string; merchantId: string; configHash: string;
}
export type ConnectorAuthority = { kind:'connector'; connector:ObservationConnector };
export const connectorActor = (connector: ObservationConnector): Actor =>
  ({ id:`connector:${connector.id}`,tenantId:connector.tenantId,role:'investigator',membershipVersion:1 });

export function configuredConnector(env: Record<string,string|undefined> = process.env): ObservationConnector | null {
  const tenantId = env.GLASSHOUSE_PAYPAL_TENANT_ID, webhookId = env.PAYPAL_WEBHOOK_ID, merchantId = env.PAYPAL_MERCHANT_ID;
  if (!tenantId || !webhookId || !merchantId) return null;
  if (env.PAYPAL_PROJECT_ISOLATED !== 'true' || env.PAYPAL_ENVIRONMENT !== 'sandbox' || env.PAYPAL_API_BASE_URL !== 'https://api-m.sandbox.paypal.com' ||
    !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !/^fernwood-[A-Za-z0-9-]{1,100}$/.test(tenantId) ||
    !/^[A-Za-z0-9-]{5,128}$/.test(webhookId) || webhookId === 'WEBHOOK_ID' || !/^[A-Za-z0-9_-]{5,128}$/.test(merchantId)) {
    throw new HttpError(503,'CONNECTOR_CONFIGURATION_INVALID','The isolated merchant notification binding is incomplete.');
  }
  const credentialHash = digest(env.PAYPAL_CLIENT_ID);
  const facts = { tenantId,credentialHash,webhookId,merchantId,environment:'sandbox',project:'glasshouse' };
  return {id:`connector-${credentialHash.slice(0,32)}`,tenantId,credentialHash,webhookId,merchantId,configHash:digest(facts)};
}

/** Explicit deployment configuration may bind an existing owned sandbox, never move its grants. */
export async function bindConnector(db: Database, connector: ObservationConnector) {
  await db.transaction(async tx => {
    const owned = (await tx.query("SELECT provider_id FROM gh_provider_resources WHERE tenant_id=$1 AND kind='capture' AND active=true LIMIT 1",[connector.tenantId]))[0];
    if (!owned) throw new HttpError(503,'CONNECTOR_OWNERSHIP_REQUIRED','The notification connector needs an existing tenant with an independently owned sandbox capture.');
    await tx.query(`INSERT INTO gh_paypal_connectors(id,tenant_id,credential_hash,webhook_id,merchant_id,config_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [connector.id,connector.tenantId,connector.credentialHash,connector.webhookId,connector.merchantId,connector.configHash]);
    await requireConnector(tx,connector);
  });
}

export async function requireConnector(db: Database, connector: ObservationConnector) {
  const row = (await db.query<{tenant_id:string;credential_hash:string;webhook_id:string;merchant_id:string;config_hash:string;active:boolean}>(
    'SELECT tenant_id,credential_hash,webhook_id,merchant_id,config_hash,active FROM gh_paypal_connectors WHERE id=$1',[connector.id]))[0];
  if (!row?.active || row.tenant_id !== connector.tenantId || row.credential_hash !== connector.credentialHash || row.webhook_id !== connector.webhookId ||
    row.merchant_id !== connector.merchantId || row.config_hash !== connector.configHash) throw new HttpError(409,'CONNECTOR_BINDING_CHANGED','The stored isolated merchant connector must match the current deployment binding.');
}

export async function requireObservationAuthority(db: Database, actor: Actor, authority: ConnectorAuthority) {
  await requireConnector(db,authority.connector);
  if (actor.tenantId !== authority.connector.tenantId || actor.id !== connectorActor(authority.connector).id) {
    throw new HttpError(403,'CONNECTOR_SCOPE_DENIED','The connector cannot project into another workspace.');
  }
}
