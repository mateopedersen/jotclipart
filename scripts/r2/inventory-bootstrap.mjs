import { validateInventoryScope } from './inventory.mjs';
import { inventoryBoundaries } from '../delivery/inventory-reader.mjs';

// Old journals and local manifests only provide range/binding hints. They are
// deliberately not returned as a reservation and cannot authorize any write.
export function bootstrapInventoryHints(journal, accountId, knownKeys = []) {
  const scope = journal?.inventoryScope;
  if (!scope || scope.accountId !== accountId || !Array.isArray(scope.jurisdictions))
    throw Error('Prior inventory scope is unavailable or belongs to another account');
  const grouped = new Map();
  for (const item of knownKeys) {
    if (typeof item.bucket !== 'string' || typeof item.key !== 'string' || !item.key) continue;
    const list = grouped.get(item.bucket) ?? new Set();
    list.add(item.key);
    grouped.set(item.bucket, list);
  }
  const roster = {
    schemaVersion: 2,
    scopeVersion: scope.scopeVersion,
    accountId,
    observedAt: scope.observedAt,
    jurisdictions: scope.jurisdictions,
    buckets: scope.jurisdictions.flatMap((s) =>
      s.buckets.map((name) => ({
        name,
        jurisdiction: s.jurisdiction,
      })),
    ),
  };
  validateInventoryScope(roster);
  return {
    accountId,
    hintOnly: true,
    buckets: roster.buckets.map(({ name, jurisdiction }) => ({
      bucket: name,
      jurisdiction,
      bounds: inventoryBoundaries(
        jurisdiction === 'default' ? [...(grouped.get(name) ?? [])].map((key) => ({ key })) : [],
      ),
    })),
  };
}
