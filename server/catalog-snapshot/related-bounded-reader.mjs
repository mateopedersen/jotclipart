// Private full-index adapter. Reuses established ranking; not yet production.
import { RelatedIndex } from '../../src/lib/related/engine.ts';
import { normalize } from '../../src/lib/related/normalize.ts';
import {
  companionSubjects,
  BY_TOPIC,
  THEME_COLLECTIONS,
  words,
} from '../../src/lib/related/taxonomy.ts';
import { readPublicArtwork as readArtwork } from './public-artwork-routes.mjs';
import { lookupHashedRecord } from './hashed-record-directory.mjs';
const validId = (x) => typeof x === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);
export async function readBoundedRelated(context, id, { hasTopic, topicFor } = {}) {
  if (typeof hasTopic !== 'function') throw Error('Snapshot-scoped topic lookup required');
  const [item, root] = await Promise.all([readArtwork(context, id), context.getFacet('related')]);
  if (!item) return undefined;
  if (
    root.schema !== 2 ||
    root.type !== 'related-posting-index' ||
    !/^\d{1,20}$/.test(root.digest ?? '')
  )
    throw Error('Invalid related index');
  const index = new RelatedIndex([]);
  index.digest = BigInt(root.digest);
  if (index.version !== root.version) throw Error('Related software binding changed');
  const topicRequests = new Map(),
    registered = new Set();
  const registeredTopic = async (slug) => {
    if (!topicRequests.has(slug))
      topicRequests.set(
        slug,
        Promise.resolve(hasTopic(slug)).then((found) => {
          if (found) registered.add(slug);
          return found;
        }),
      );
    return topicRequests.get(slug);
  };
  const details = new Map();
  async function profile(item) {
    if (!topicFor || BY_TOPIC.has(item.topic) || THEME_COLLECTIONS.has(item.topic))
      return normalize(item);
    if (!details.has(item.topic)) details.set(item.topic, Promise.resolve(topicFor(item.topic)));
    const record = await details.get(item.topic);
    if (!record || record.slug !== item.topic || typeof record.keyword !== 'string')
      throw Error('Missing captured subject context');
    const label = record.keyword.replace(/\s+clipart$/i, '').trim();
    if (!label) throw Error('Empty catalog subject');
    return normalize(item, {
      catalogSubject: {
        id: `catalog.topic.${record.slug}`,
        topic: record.slug,
        label,
        plural: `${label.toLowerCase()} designs`,
        domain: 'catalog',
        family: record.slug,
        terms: [...new Set([words(label), words(record.slug)])],
      },
    });
  }
  const source = await profile(item),
    subject = source.subject?.id,
    needs = new Map();
  const request = (name, limit) => needs.set(name, Math.max(needs.get(name) ?? 0, limit));
  if (await registeredTopic(item.topic ?? '')) request(`collection:${item.topic}`, 64);
  if (source.technique) request(`${subject}:tech:${source.technique}`, 32);
  for (const comp of source.composition) request(`${subject}:comp:${comp}`, 24);
  if (source.styleFamily) request(`${subject}:family:${source.styleFamily}`, 32);
  request(`${subject}:color:monochrome`, 20);
  if (subject) request(subject, 64);
  for (const partner of source.subject ? companionSubjects(source.subject) : []) {
    if (source.technique) request(`${partner.id}:tech:${source.technique}`, 12);
    if (source.styleFamily) request(`${partner.id}:family:${source.styleFamily}`, 8);
  }
  const profiles = new Map([[id, source]]),
    buckets = new Map(),
    dates = new Map();
  await Promise.all(
    [...needs].map(async ([name, limit]) => {
      const descriptor = await lookupHashedRecord(context, 'related', root.directory, name);
      if (!descriptor) return;
      const node = await context.read('related', descriptor, { maxBytes: 524288 });
      if (
        node.schema !== 1 ||
        node.prefix !== '' ||
        !['posting-leaf-v2', 'posting-branch-v2'].includes(node.type) ||
        !Array.isArray(node.top) ||
        node.top.length > 96 ||
        node.top.some((x) => !validId(x.id)) ||
        new Set(node.top.map((x) => x.id)).size !== node.top.length
      )
        throw Error('Invalid related posting');
      const chosen = node.top.slice(0, limit);
      for (const row of chosen) {
        if (dates.has(row.id) && dates.get(row.id) !== row.createdAt)
          throw Error('Conflicting posting source');
        dates.set(row.id, row.createdAt);
      }
      buckets.set(
        name,
        chosen.map((x) => x.id),
      );
    }),
  );
  const ids = [...new Set([...buckets.values()].flat())];
  // Bound outstanding reads; each artwork lookup reuses the captured context.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, ids.length) }, async () => {
      while (cursor < ids.length) {
        const target = ids[cursor++],
          candidate = await readArtwork(context, target);
        if (!candidate || candidate.createdAt !== dates.get(target))
          throw Error('Related reference missing or changed artwork');
        profiles.set(target, await profile(candidate));
      }
    }),
  );
  for (const [name, ids] of buckets)
    for (const candidateId of ids) {
      const p = profiles.get(candidateId),
        s = p.subject?.id,
        keys =
          p.eligible && s
            ? [
                s,
                `${s}:color:${p.colorMode}`,
                ...(p.technique ? [`${s}:tech:${p.technique}`] : []),
                ...(p.styleFamily ? [`${s}:family:${p.styleFamily}`] : []),
                ...p.composition.map((x) => `${s}:comp:${x}`),
              ]
            : [];
      if (p.publicationEligible && (await registeredTopic(p.item.topic ?? '')))
        keys.push(`collection:${p.item.topic}`);
      if (!keys.includes(name)) throw Error('Stale related membership');
    }
  index.registeredTopics = registered;
  index.profiles = profiles;
  index.buckets = buckets;
  index.topics = new Set(
    source.subject && (await hasTopic(source.subject.topic)) ? [source.subject.topic] : [],
  );
  return index.snapshot(id);
}
