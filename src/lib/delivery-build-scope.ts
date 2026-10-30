import { readIncrementalPlan } from '../../scripts/delivery/incremental.mjs';

// Server-build scope only. Publication still requires the complete, verified
// inherited+new manifest; setting this environment variable cannot hide pages.
export function renderArtworkScope<T extends { id: string }>(artwork: T[]): T[] {
  const plan = readIncrementalPlan();
  if (!plan) return artwork;
  const selected = new Set<string>(plan.artworkIds);
  return artwork.filter((item) => selected.has(item.id));
}
