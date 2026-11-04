// Stage only changed collection/count objects. Never activates a snapshot.
import { bytesOf, canonical, digest, lookupTopic, patchTopic, slugOK, fail } from './store.mjs';
export const VIEW_PROTOCOL = 'collection-references-v2';
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)),
  clusterSlug = (r) =>
    r.primaryCluster
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
export function validateTopicIdentity(r, slug = r?.slug) {
  if (
    !r ||
    !slugOK(slug) ||
    r.slug !== slug ||
    r.path !== `/clipart/${slug}/` ||
    r.canonical !== `https://ultraclipart.com/clipart/${slug}/` ||
    ['keyword', 'title', 'summary', 'metaDescription', 'primaryCluster', 'sourceCluster'].some(
      (k) => typeof r[k] !== 'string' || !r[k].trim(),
    ) ||
    !slugOK(r.coverArtworkId) ||
    !Array.isArray(r.clusters) ||
    !r.clusters.length ||
    r.clusters.some(
      (c) =>
        typeof c.name !== 'string' ||
        !c.name.trim() ||
        typeof c.path !== 'string' ||
        !/^\/collection\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(c.path),
    ) ||
    !Array.isArray(r.paragraphs) ||
    r.paragraphs.length < 2 ||
    r.paragraphs.length > 3 ||
    r.paragraphs.some((p) => typeof p !== 'string' || !p.trim()) ||
    r.paragraphs.join(' ').split('{{artworkCount}}').length !== 2 ||
    !r.editorial ||
    r.editorial.intro !== r.summary ||
    !same(r.editorial.paragraphs, r.paragraphs) ||
    !Array.isArray(r.related) ||
    r.related.length > 6 ||
    new Set(r.related.map((t) => t.slug)).size !== r.related.length ||
    r.related.some((t) => !slugOK(t.slug) || t.slug === slug)
  )
    fail('Invalid source-bound topic identity');
}
export function validateTopicRecord(r, ids) {
  validateTopicIdentity(r);
  if (
    !r ||
    !slugOK(r.slug) ||
    r.path !== `/clipart/${r.slug}/` ||
    r.canonical !== `https://ultraclipart.com/clipart/${r.slug}/` ||
    typeof r.keyword !== 'string' ||
    typeof r.title !== 'string' ||
    typeof r.summary !== 'string' ||
    !r.summary.trim() ||
    typeof r.primaryCluster !== 'string' ||
    typeof r.sourceCluster !== 'string' ||
    !Array.isArray(r.clusters) ||
    !Array.isArray(r.paragraphs) ||
    r.paragraphs.length < 2 ||
    r.paragraphs.length > 3 ||
    r.paragraphs.some((p) => typeof p !== 'string' || !p.trim()) ||
    !r.editorial ||
    r.editorial.intro !== r.summary ||
    !same(r.editorial.paragraphs, r.paragraphs) ||
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10000 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !slugOK(id)) ||
    r.artworkCount !== ids.length ||
    r.coverArtworkId !== ids[0] ||
    !Array.isArray(r.related) ||
    r.related.length > 6 ||
    new Set(r.related.map((t) => t.slug)).size !== r.related.length ||
    r.related.some((t) => !slugOK(t.slug) || t.slug === r.slug)
  )
    fail('Invalid source-bound topic record');
}
export async function membership(store, record) {
  let offset = 0;
  const ids = [];
  for (const d of record.membership) {
    const part = await store.read('collections', d);
    if (
      part.type !== 'collection-members' ||
      part.slug !== record.slug ||
      part.offset !== offset ||
      d.offset !== offset ||
      !Array.isArray(part.artworkIds) ||
      part.artworkIds.length !== d.count ||
      d.count < 1 ||
      d.count > 256
    )
      fail('Invalid old membership');
    ids.push(...part.artworkIds);
    offset += d.count;
  }
  if (
    ids.length !== record.artworkCount ||
    new Set(ids).size !== ids.length ||
    ids[0] !== record.coverArtworkId
  )
    fail('Old topic membership differs');
  return ids;
}
async function printable(ids, slug, resolve) {
  let count = 0;
  for (const id of ids) {
    const a = await resolve(id);
    if (
      !a ||
      a.id !== id ||
      a.topic !== slug ||
      !a.published ||
      !a.indexable ||
      typeof a.monochrome !== 'boolean'
    )
      fail('Unresolved source count fact');
    if (a.monochrome) count++;
  }
  return count;
}
export async function applyCollectionBatch(
  store,
  { collections: baseCollection, counts: baseCounts },
  changes,
  {
    expectedCollectionsSha256,
    expectedCountsSha256,
    validateSourceTopic,
    resolveBeforeArtwork,
    resolveAfterArtwork,
  } = {},
) {
  if (
    expectedCollectionsSha256 !== baseCollection.sha256 ||
    expectedCountsSha256 !== baseCounts.sha256
  )
    fail('Collection/count parent changed');
  if (
    typeof validateSourceTopic !== 'function' ||
    typeof resolveBeforeArtwork !== 'function' ||
    typeof resolveAfterArtwork !== 'function'
  )
    fail('Source validation/resolvers required');
  if (
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > 64 ||
    new Set(changes.map((c) => c.slug)).size !== changes.length
  )
    fail('Invalid changed topic batch');
  const collection = await store.read('collections', baseCollection),
    counts = await store.read('counts', baseCounts),
    beforeGlobal = await store.read('counts', counts.global);
  if (
    collection.type !== 'collection-directory' ||
    counts.type !== 'catalog-count-directory' ||
    !['collection-context-v1', VIEW_PROTOCOL].includes(collection.viewProtocol) ||
    collection.topicCount !== counts.topicCount ||
    collection.artworkCount !== counts.artworkCount ||
    beforeGlobal.totals.artworks !== collection.artworkCount ||
    beforeGlobal.totals.subjects !== collection.topicCount
  )
    fail('Inconsistent base facets');
  // All stale/source checks precede staging, including later entries in a batch.
  const plans = [];
  for (const change of changes) {
    if (!slugOK(change.slug)) fail('Invalid changed topic');
    const oldEntry = await lookupTopic(store, collection.directory, 'collection', change.slug);
    if ((oldEntry?.sha256 ?? null) !== change.expectedRecordSha256) fail('Stale topic source');
    const oldRecord = oldEntry ? await store.read('collections', oldEntry) : null,
      oldIds = oldRecord ? await membership(store, oldRecord) : [];
    const oldCount = await lookupTopic(store, counts.topics, 'count', change.slug);
    if (
      (oldCount?.count ?? 0) !== oldIds.length ||
      (oldRecord && oldEntry.artworkCount !== oldRecord.artworkCount)
    )
      fail('Old scoped count differs');
    const ids = change.record ? change.artworkIds : [];
    if (change.record) {
      validateTopicRecord(change.record, ids);
      if (change.record.slug !== change.slug) fail('Topic identity changed');
    } else if (!oldRecord) fail('Cannot remove absent topic');
    const binding = await validateSourceTopic({ change, oldRecord, oldIds });
    if (
      binding?.oldRecordSha256 !== (oldEntry?.sha256 ?? null) ||
      binding?.newRecordSha256 !== (change.record ? await digest(bytesOf(change.record)) : null)
    )
      fail('Source validation was not bound to this exact topic record');
    const oldPrintable = await printable(oldIds, change.slug, resolveBeforeArtwork),
      newPrintable = await printable(ids, change.slug, resolveAfterArtwork);
    plans.push({ change, oldEntry, oldRecord, oldIds, ids, oldPrintable, newPrintable });
  }
  // A move/withdrawal must update both affected topics; never leave an old page
  // pointing at an eligible artwork that the new membership silently omitted.
  const byTopic = new Map(plans.map((p) => [p.change.slug, p]));
  for (const p of plans) {
    const oldSet = new Set(p.oldIds),
      newSet = new Set(p.ids);
    for (const id of p.ids)
      if (!oldSet.has(id)) {
        const prior = await resolveBeforeArtwork(id);
        if (prior?.published && prior.indexable && prior.topic !== p.change.slug) {
          const origin = byTopic.get(prior.topic);
          if (!origin || !origin.oldIds.includes(id) || origin.ids.includes(id))
            fail('Cross-topic move omits its original topic');
        }
      }
    for (const id of p.oldIds)
      if (!newSet.has(id)) {
        const after = await resolveAfterArtwork(id);
        if (after?.published && after.indexable) {
          const target = byTopic.get(after.topic);
          if (after.topic === p.change.slug || !target || !target.ids.includes(id))
            fail('Eligible artwork omitted from changed membership');
        }
      }
  }
  let directory = collection.directory,
    topicCounts = counts.topics;
  const global = structuredClone(beforeGlobal),
    changed = [];
  let countChanged = false;
  const adjustGroup = (record, artDelta, subjectDelta) => {
    if (!record) return;
    const key = clusterSlug(record),
      group = Object.hasOwn(global.collections, key)
        ? global.collections[key]
        : { artworks: 0, subjects: 0 };
    group.artworks += artDelta;
    group.subjects += subjectDelta;
    if (group.artworks < 0 || group.subjects < 0) fail('Negative category count');
    if (!group.subjects) {
      if (group.artworks) fail('Empty category retains artwork');
      delete global.collections[key];
    } else global.collections[key] = group;
  };
  for (const p of plans) {
    const { change, oldRecord, oldIds, ids } = p,
      oldN = oldIds.length,
      newN = ids.length;
    let entry = null;
    if (change.record) {
      const record = {
        ...structuredClone(change.record),
        schema: 1,
        type: 'collection-topic-references',
        membership: [],
        pageBlocks: [],
        related: change.record.related.map((t) => ({ slug: t.slug })),
      };
      delete record.relatedContext;
      for (let offset = 0; offset < ids.length; offset += 256) {
        const values = ids.slice(offset, offset + 256),
          old = oldRecord?.membership.find((d) => d.offset === offset);
        if (old && same(oldIds.slice(offset, offset + old.count), values))
          record.membership.push(old);
        else
          record.membership.push({
            offset,
            count: values.length,
            ...(await store.put('collections', {
              type: 'collection-members',
              slug: change.slug,
              offset,
              artworkIds: values,
            })),
          });
      }
      for (let offset = 0; offset < ids.length; offset += 32) {
        const values = ids.slice(offset, offset + 32),
          old = oldRecord?.pageBlocks.find((d) => d.offset === offset);
        if (old && old.count === values.length) {
          const block = await store.read('collections', old),
            prior = block.artworkIds ?? block.artworks?.map((a) => a.id);
          if (
            block.slug !== change.slug ||
            block.offset !== offset ||
            !Array.isArray(prior) ||
            prior.length !== old.count
          )
            fail('Invalid existing page block');
          if (same(prior, values)) {
            record.pageBlocks.push(old);
            continue;
          }
        }
        record.pageBlocks.push({
          offset,
          count: values.length,
          ...(await store.put('collections', {
            type: 'collection-page-ids',
            slug: change.slug,
            offset,
            artworkIds: values,
          })),
        });
      }
      entry = {
        slug: change.slug,
        path: record.path,
        artworkCount: newN,
        ...(await store.put('collections', record)),
      };
    }
    directory = await patchTopic(store, directory, 'collection', change.slug, entry);
    if (oldN !== newN) {
      topicCounts = await patchTopic(
        store,
        topicCounts,
        'count',
        change.slug,
        newN ? { slug: change.slug, count: newN } : null,
      );
      countChanged = true;
    }
    const oldSubject = Number(oldN > 0),
      newSubject = Number(newN > 0);
    global.totals.artworks += newN - oldN;
    global.totals.subjects += newSubject - oldSubject;
    global.totals.printable += p.newPrintable - p.oldPrintable;
    adjustGroup(oldRecord, -oldN, -oldSubject);
    adjustGroup(change.record, newN, newSubject);
    changed.push({
      slug: change.slug,
      before: oldN,
      after: newN,
      beforeDescriptor: p.oldEntry,
      afterDescriptor: entry,
    });
  }
  global.totals.collections = Object.keys(global.collections).length;
  if (
    Object.values(global.totals).some((n) => !Number.isSafeInteger(n) || n < 0) ||
    global.totals.printable > global.totals.artworks
  )
    fail('Invalid updated totals');
  const oldValues = { ...beforeGlobal, version: '' },
    newValues = { ...global, version: '' };
  if (!same(oldValues, newValues) || countChanged)
    global.version = (
      await digest(
        bytesOf({
          totals: global.totals,
          collections: global.collections,
          topicCountsSha256: topicCounts.sha256,
        }),
      )
    ).slice(0, 16);
  const globalDescriptor = same(beforeGlobal, global)
      ? counts.global
      : await store.put('counts', global),
    countRoot = {
      ...counts,
      topicCount: global.totals.subjects,
      artworkCount: global.totals.artworks,
      topics: topicCounts,
      global: globalDescriptor,
    },
    collectionRoot = {
      ...collection,
      topicCount: global.totals.subjects,
      artworkCount: global.totals.artworks,
      directory,
      viewProtocol: VIEW_PROTOCOL,
    };
  return {
    status: 'STAGED_METADATA_NOT_ACTIVATION_PROOF',
    collections: await store.put('collections', collectionRoot),
    counts: await store.put('counts', countRoot),
    changed,
    metrics: store.metrics(),
  };
}
