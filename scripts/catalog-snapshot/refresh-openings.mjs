// Maintain the compact prose registry during normal append/edit/withdraw batches.
import { facetStore, digest, emitDirectory } from '../../server/catalog-collections/store.mjs';
import {
  collectionOpening,
  collectionIntroductionTemplate,
  collectionSourceSignature,
  verifyCollectionOpenings,
} from '../collection-editorial.mjs';
export async function refreshCollectionOpenings({
  bucket,
  parentContext,
  context,
  topicChanges,
  readArtwork,
}) {
  const store = facetStore(bucket, {
      writable: true,
      maxReads: 20000,
      maxBytes: 128 * 1024 * 1024,
    }),
    old = await parentContext.getFacet('collections'),
    current = await context.getFacet('collections');
  if (!old.openingIndex)
    throw Error('Verified opening-index bootstrap required before new content');
  const rows = [];
  async function walk(d, prefix = '') {
    const n = await store.read('collections', d);
    if (n.kind !== 'collection' || n.prefix !== prefix)
      throw Error('Opening registry scope differs');
    if (n.type === 'hashed-topic-leaf') {
      rows.push(...n.entries);
      return;
    }
    if (n.type !== 'hashed-topic-branch') throw Error('Invalid opening index');
    for (const [p, child] of Object.entries(n.children)) await walk(child, p);
  }
  await walk(old.openingIndex);
  if (rows.length !== old.topicCount || new Set(rows.map((r) => r.slug)).size !== rows.length)
    throw Error('Incomplete opening registry');
  const index = new Map(rows.map((r) => [r.slug, r]));
  for (const t of topicChanges) {
    if (!t.record) {
      index.delete(t.slug);
      continue;
    }
    verifyCollectionOpenings({ topics: { [t.slug]: t.record.editorial } });
    const inventory = collectionSourceSignature(
      await Promise.all(t.artworkIds.map((id) => readArtwork(id))),
    );
    if (
      t.record.editorial.paragraphSourceSha256 !==
      (await digest(JSON.stringify([inventory, t.record.summary])))
    )
      throw Error('Opening inventory differs from reviewed topic');
    const opening = collectionOpening(t.record.paragraphs[0]);
    index.set(t.slug, {
      slug: t.slug,
      inventory,
      exact: await digest(opening.normalize('NFKC').toLowerCase()),
      template: await digest(collectionIntroductionTemplate(t.slug, opening)),
    });
  }
  if (index.size !== current.topicCount) throw Error('Opening registry topic count differs');
  for (const key of ['exact', 'template'])
    if (new Set([...index.values()].map((r) => r[key])).size !== index.size)
      throw Error('Repeated catalog collection opening');
  const openingIndex = await emitDirectory(store, [...index.values()], 'collection');
  return store.put('collections', { ...current, openingIndex });
}
