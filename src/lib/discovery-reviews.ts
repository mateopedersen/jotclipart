import gta from '../../data/gta-six-review.json' with { type: 'json' };
import remaining from '../../data/remaining-thirty-one-review.json' with { type: 'json' };
import type { DiscoveryArtwork } from './cute-discovery';

// Preserve these existing actual-pixel exclusion decisions only while their
// original source hashes match. This is finite historical evidence, not a new
// visual review or a whitelist admitting future content.
const exclusions = new Map<string, string>();
for (const ledger of [gta, remaining]) {
  const review = ledger.discoveryReview;
  if (review.status !== 'PASS' || review.reviewedFromActualPixels !== true)
    throw new Error('Historical discovery evidence is invalid');
  const accepted = new Set<string>(review.cuteSelections);
  for (const row of ledger.rows) {
    if (!accepted.has(row.id) && /^[a-f0-9]{64}$/.test(row.hashes.webp))
      exclusions.set(row.id, row.hashes.webp);
  }
}

export function withDiscoveryReview<T extends DiscoveryArtwork>(item: T): T {
  const source = exclusions.get(item.id);
  return source && source === item.files?.webp?.sha256
    ? { ...item, discovery: { ...item.discovery, cute: false, reviewedSourceSha256: source } }
    : item;
}
