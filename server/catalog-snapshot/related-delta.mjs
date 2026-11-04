// Publisher-only changed-path related index update. Requires an authenticated
// predecessor and exact old public-record hashes; it never approves pixels.
import { RelatedIndex } from '../../src/lib/related/engine.ts';
import { normalize } from '../../src/lib/related/normalize.ts';
import { BY_TOPIC, THEME_COLLECTIONS, words } from '../../src/lib/related/taxonomy.ts';
import { readArtwork } from './artwork-facet-reader.mjs';
import { lookupHashedRecord } from './hashed-record-directory.mjs';
import { updateHashedRecord } from './hashed-record-directory-update.mjs';
import { updateRemotePosting, serializeRemotePosting } from './related-posting-remote.mjs';
import { makePostingTree } from './related-posting-tree.mjs';
import { digest, canonical } from '../catalog-search/store.mjs';
async function profile(item, topicFor) {
  if (!item) return null;
  if (BY_TOPIC.has(item.topic) || THEME_COLLECTIONS.has(item.topic)) return normalize(item);
  const t = await topicFor(item.topic);
  if (!t || t.slug !== item.topic || !t.keyword?.trim())
    throw Error('Missing source-bound related subject');
  const label = t.keyword.replace(/\s+clipart$/i, '').trim();
  return normalize(item, {
    catalogSubject: {
      id: `catalog.topic.${t.slug}`,
      topic: t.slug,
      label,
      plural: `${label.toLowerCase()} designs`,
      domain: 'catalog',
      family: t.slug,
      terms: [...new Set([words(label), words(t.slug)])],
    },
  });
}
async function keys(p, topicFor) {
  if (!p) return [];
  const s = p.subject?.id,
    result =
      p.eligible && s
        ? [
            s,
            `${s}:color:${p.colorMode}`,
            ...(p.technique ? [`${s}:tech:${p.technique}`] : []),
            ...(p.styleFamily ? [`${s}:family:${p.styleFamily}`] : []),
            ...p.composition.map((x) => `${s}:comp:${x}`),
          ]
        : [];
  if (p.publicationEligible && (await topicFor(p.item.topic)))
    result.push(`collection:${p.item.topic}`);
  return [...new Set(result)];
}
export async function applyRelatedBatch(context, changes, { beforeTopic, afterTopic } = {}) {
  if (
    typeof beforeTopic !== 'function' ||
    typeof afterTopic !== 'function' ||
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > 256 ||
    new Set(changes.map((c) => c.id)).size !== changes.length
  )
    throw Error('Bounded source-bound related batch required');
  const root = await context.getFacet('related'),
    index = new RelatedIndex([]);
  if (
    root.type !== 'related-posting-index' ||
    root.schema !== 2 ||
    !/^\d{1,20}$/.test(root.digest ?? '')
  )
    throw Error('Invalid related baseline');
  index.digest = BigInt(root.digest);
  if (index.version !== root.version)
    throw Error('Related software changed; full reviewed migration required');
  const created = new Map(),
    enc = new TextEncoder(),
    descriptors = new Map();
  let directory = root.directory;
  const overlay = {
    read: async (f, d, opts) => {
      const b = created.get(d.key);
      return b ? JSON.parse(new TextDecoder().decode(b)) : context.read(f, d, opts);
    },
  };
  const remember = (result) => {
    for (const [k, b] of result.created) created.set(k, b);
  };
  for (const change of changes) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change.id ?? '') ||
      change.expectedPublicSHA256 === undefined ||
      (change.record && change.record.id !== change.id)
    )
      throw Error('Invalid related identity');
    const old = await readArtwork(context, change.id);
    if ((old ? await digest(JSON.stringify(canonical(old))) : null) !== change.expectedPublicSHA256)
      throw Error('Stale related artwork');
    if (!old && !change.record) throw Error('Absent related withdrawal');
    const [before, after] = await Promise.all([
        profile(old, beforeTopic),
        profile(change.record, afterTopic),
      ]),
      oldKeys = await keys(before, beforeTopic),
      newKeys = await keys(after, afterTopic);
    if (before) index.digest ^= BigInt('0x' + before.fingerprint);
    if (after) index.digest ^= BigInt('0x' + after.fingerprint);
    for (const name of new Set([...oldKeys, ...newKeys])) {
      let current = descriptors.has(name)
        ? descriptors.get(name)
        : await lookupHashedRecord(overlay, 'related', directory, name);
      const prior = current ?? null;
      if (!current) {
        const empty = serializeRemotePosting(makePostingTree([]));
        remember(empty);
        current = empty.root;
      }
      const row = (a) => ({
          id: a.id,
          ...(a.createdAt !== undefined ? { createdAt: a.createdAt } : {}),
        }),
        updated = await updateRemotePosting(overlay, current, {
          oldItem: oldKeys.includes(name) ? row(old) : null,
          newItem: newKeys.includes(name) ? row(change.record) : null,
        });
      remember(updated);
      const changed = await updateHashedRecord(overlay, 'related', directory, {
        name,
        expectedValue: prior,
        newValue: updated.root,
      });
      remember(changed);
      directory = changed.root;
      descriptors.set(name, updated.root);
    }
  }
  const bytes = enc.encode(
      JSON.stringify(
        canonical({ ...root, digest: index.digest.toString(), version: index.version, directory }),
      ),
    ),
    sha256 = await digest(bytes),
    descriptor = { key: `catalog/objects/related/${sha256}.json`, sha256, bytes: bytes.length };
  created.set(descriptor.key, bytes);
  return {
    root: descriptor,
    created,
    version: index.version,
    status: 'SOURCE_DELTA_REQUIRES_GRAPH_REVIEW_NOT_PUBLISHABLE',
  };
}
