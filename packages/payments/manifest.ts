import type { SeedDataset } from '@/packages/domain/types';
import { digest } from './security';
import type { SeedManifest } from './types';

export function seedManifest(dataset: SeedDataset): SeedManifest {
  const entries = dataset.orders.map(order => {
    if (order.currency !== 'USD' || !Number.isSafeInteger(order.amountMinor) || order.amountMinor < 1 || order.amountMinor > 100_000) throw new Error('The seed manifest contains an unsupported amount.');
    return { orderId: order.id, reference: order.reference, product: order.product, amountMinor: order.amountMinor, currency: 'USD' as const, resourceVersion: order.resourceVersion };
  }).sort((a, b) => a.reference.localeCompare(b.reference));
  if (entries.length !== 600 || new Set(entries.map(entry => entry.orderId)).size !== 600) throw new Error('The seed manifest must contain exactly 600 distinct orders.');
  const content = {
    schemaVersion: 'glasshouse.seed.v1' as const,
    tenantId: dataset.tenantId,
    seedVersion: dataset.version,
    currency: 'USD' as const,
    entryCount: entries.length,
    totalMinor: entries.reduce((total, entry) => total + entry.amountMinor, 0),
    maximumOrderMinor: Math.max(...entries.map(entry => entry.amountMinor)),
    entries,
  };
  return { ...content, hash: digest(content) };
}
