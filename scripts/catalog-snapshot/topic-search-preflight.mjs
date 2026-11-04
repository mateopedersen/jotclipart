import { canonical } from '../../server/catalog-search/store.mjs';

// Appending members must preserve every accepted search/category identity.
// Check this before binary transport as well as during final graph composition.
export function assertCompleteTopicSearchDelta(old, change, suppliedIds) {
  if (!old || !change.record) return;
  const identity = (t) => canonical({
    keyword: t.keyword,
    primaryCluster: t.primaryCluster,
    clusters: t.clusters,
  });
  if (JSON.stringify(identity(old)) !== JSON.stringify(identity(change.record)) &&
      change.artworkIds.some((id) => !suppliedIds.has(id)))
    throw Error('Changed topic search identity requires its complete scoped member delta');
}
