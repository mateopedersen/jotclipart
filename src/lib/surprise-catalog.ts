import { art } from './catalog';
import { buildCuteIndex } from './cute-discovery';
import { withDiscoveryReview } from './discovery-reviews';
export const cuteSurpriseIndex = buildCuteIndex(
  art.map(withDiscoveryReview),
  512,
  import.meta.env.PUBLIC_RELEASE_REVISION || 'local',
);
if (!cuteSurpriseIndex.length)
  throw new Error('Surprise me needs at least one published cute artwork.');
