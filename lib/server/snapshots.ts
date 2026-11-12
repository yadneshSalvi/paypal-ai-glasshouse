import type { Actor, QueryContext, Snapshot,SeedDataset } from '@/packages/domain/types';
import { buildSnapshot } from '@/packages/domain';
import { datasetFor, saveSnapshot } from './repository';
import { HttpError } from './errors';
import {COMMERCE_SEMANTICS} from '@/packages/domain/commerce-resources';

const validTime = (value: string | null, fallback: string) => {
  if (!value) return fallback;
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400,'INVALID_TIME','Choose a valid timestamp.');
  return new Date(value).toISOString();
};
export async function snapshotFor(actor: Actor, search = new URLSearchParams()): Promise<Snapshot> {
  const dataset = await datasetFor(actor);
  const snapshot = buildSnapshot(dataset, snapshotContext(actor,dataset,search));
  await saveSnapshot(snapshot);
  return snapshot;
}
export function snapshotContext(actor:Actor,dataset:SeedDataset,search=new URLSearchParams()):Partial<QueryContext>&{generationId:number}{
  const latestProviderKnowledge=dataset.events.filter(event=>event.sourceClass==='sandbox'||event.payload.scenarioRevisionId).reduce((latest,event)=>Date.parse(event.ingestedAt)>(Date.parse(latest)||0)?new Date(event.ingestedAt).toISOString():latest,'');
  const deliveryKnown=dataset.events.some(event=>event.id.endsWith(':fulfillment.delivered:v2'))?'2026-11-06T10:05:00.000Z':'2026-11-06T10:00:00.000Z';
  if(search.has('clock')&&!['observed','narrative_replay'].includes(search.get('clock')!))throw new HttpError(400,'INVALID_CLOCK','Choose the observed or story clock.');
  const currency=search.get('currency')??'USD';
  if(!['USD','EUR','GBP'].includes(currency))throw new HttpError(400,'INVALID_CURRENCY','Choose one supported denomination. Currencies are never combined.');
  const resourceKnown=(dataset.commerceFacts??[]).reduce((latest,fact)=>Date.parse(fact.ingestedAt)>(Date.parse(latest)||0)?new Date(fact.ingestedAt).toISOString():latest,'');
  const generationId=search.has('generationId')?Number(search.get('generationId')):0;
  if(!Number.isSafeInteger(generationId)||generationId<0||generationId>1e9)throw new HttpError(400,'INVALID_GENERATION','The snapshot request generation must be a non-negative integer.');
  const context: Partial<QueryContext> & { generationId: number } = {
    tenantId: actor.tenantId, roleScope: actor.role, rolePolicyVersion: `roles-v1:${actor.membershipVersion}`,
    asOf: validTime(search.get('asOf'), '2026-11-06T10:00:00.000Z'),
    knownAt: validTime(search.get('knownAt'), [latestProviderKnowledge||deliveryKnown,resourceKnown].sort().at(-1)!),
    clockDomain: search.get('clock') === 'observed' ? 'observed' : 'narrative_replay',
    // New intents use the current version. Existing admitted contexts retain
    // their own semantic version when reconstructed from immutable snapshots.
    cohortId: 'carrier-delay-pnw', currency:currency as QueryContext['currency'],semanticModelVersion:COMMERCE_SEMANTICS,
    generationId,
  };
  return context;
}
