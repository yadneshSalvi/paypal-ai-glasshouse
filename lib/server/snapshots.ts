import type { Actor, QueryContext, Snapshot,SeedDataset } from '@/packages/domain/types';
import { buildSnapshot } from '@/packages/domain';
import { datasetFor, saveSnapshot } from './repository';
import { HttpError } from './errors';

const validTime = (value: string | null, fallback: string) => {
  if (!value) return fallback;
  if (!/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400,'INVALID_TIME','Choose a valid timestamp.');
  return new Date(value).toISOString();
};
export async function snapshotFor(actor: Actor, search = new URLSearchParams()): Promise<Snapshot> {
  const dataset = await datasetFor(actor);
  const snapshot = buildSnapshot(dataset, snapshotContext(actor,dataset,search));
  await saveSnapshot(snapshot);
  return snapshot;
}
export function snapshotContext(actor:Actor,dataset:SeedDataset,search=new URLSearchParams()):Partial<QueryContext>&{generationId:number}{
  const latestProviderKnowledge=dataset.events.filter(event=>event.sourceClass==='sandbox'||event.payload.scenarioRevisionId).reduce((latest,event)=>event.ingestedAt>latest?event.ingestedAt:latest,'');
  const deliveryKnown=dataset.events.some(event=>event.id.endsWith(':fulfillment.delivered:v2'))?'2026-11-06T10:05:00.000Z':'2026-11-06T10:00:00.000Z';
  const context: Partial<QueryContext> & { generationId: number } = {
    tenantId: actor.tenantId, roleScope: actor.role, rolePolicyVersion: `roles-v1:${actor.membershipVersion}`,
    asOf: validTime(search.get('asOf'), '2026-11-06T10:00:00.000Z'),
    knownAt: validTime(search.get('knownAt'), latestProviderKnowledge||deliveryKnown),
    clockDomain: search.get('clock') === 'observed' ? 'observed' : 'narrative_replay',
    cohortId: 'carrier-delay-pnw', currency: 'USD', generationId: Math.max(0,Math.min(1e9,Number(search.get('generationId')) || 0)),
  };
  return context;
}
