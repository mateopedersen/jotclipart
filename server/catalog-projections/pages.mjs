import { mapFour } from '../catalog-search/bounded-map.mjs';
// Stable child-page reconciliation. It stages immutable metadata only.
import { canonical, digest } from '../catalog-search/store.mjs';
const bytes = (x) => new TextEncoder().encode(JSON.stringify(canonical(x))),
  same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export async function readPages(
  store,
  descriptors,
  type,
  { stable = false, limit = 10000, field } = {},
) {
  if (!Array.isArray(descriptors) || descriptors.length > 128) throw Error('Projection page limit');
  const entries = [],
    pages = [];
  let offset = 0;
  const loaded = await mapFour(descriptors, (d) => store.get(d));
  for (const [index, d] of descriptors.entries()) {
    const page = loaded[index];
    if (
      page.schema !== 1 ||
      (field !== undefined && page.field !== field) ||
      !Array.isArray(page.entries) ||
      page.entries.length !== d.count ||
      page.entries.length < 1 ||
      !Number.isSafeInteger(d.count) ||
      (page.type !== type && (!stable || page.type !== type + '-stable-v2')) ||
      (page.type === type &&
        ((field === undefined && (!Number.isSafeInteger(d.offset) || d.offset < 0)) ||
          (d.offset !== undefined && page.offset !== d.offset) ||
          (!stable && page.offset !== offset))) ||
      (page.type === type + '-stable-v2' &&
        (Object.hasOwn(page, 'offset') || Object.hasOwn(d, 'offset')))
    )
      throw Error('Projection page identity differs');
    entries.push(...page.entries);
    offset += page.entries.length;
    if (offset > limit) throw Error('Projection row limit');
    pages.push({ descriptor: d, page });
  }
  return { entries, pages };
}
export async function reconcilePages(
  store,
  oldDescriptors,
  type,
  desired,
  { stable = false, key, limit = 10000, maxBytes = 48000, field } = {},
) {
  if (
    typeof key !== 'function' ||
    !Array.isArray(desired) ||
    desired.length > limit ||
    desired.some((x) => typeof key(x) !== 'string') ||
    new Set(desired.map(key)).size !== desired.length
  )
    throw Error('Invalid desired projection rows');
  const old = await readPages(store, oldDescriptors, type, { stable, limit, field });
  if (
    old.entries.some((x) => typeof key(x) !== 'string') ||
    new Set(old.entries.map(key)).size !== old.entries.length
  )
    throw Error('Duplicate source projection identity');
  const anchors = new Map();
  for (const p of old.pages) {
    const start = key(p.page.entries[0]);
    if (anchors.has(start)) throw Error('Duplicate projection anchor');
    anchors.set(start, p);
  }
  const planned = [];
  let batch = [],
    reused = 0;
  const flush = () => {
    if (!batch.length) return;
    const value = {
      schema: 1,
      type: type + '-stable-v2',
      ...(field === undefined ? {} : { field }),
      entries: batch,
    };
    if (bytes(value).length > maxBytes) throw Error('Oversized projection row');
    planned.push({ value });
    batch = [];
  };
  for (let i = 0; i < desired.length;) {
    const anchor = anchors.get(key(desired[i]));
    if (
      anchor &&
      anchor.page.entries.length <= desired.length - i &&
      anchor.page.entries.every((v, j) => same(v, desired[i + j]))
    ) {
      flush();
      planned.push({ descriptor: anchor.descriptor });
      reused++;
      i += anchor.page.entries.length;
      continue;
    }
    const next = desired[i++];
    if (
      batch.length &&
      bytes({
        schema: 1,
        type: type + '-stable-v2',
        ...(field === undefined ? {} : { field }),
        entries: [...batch, next],
      }).length > maxBytes
    )
      flush();
    batch.push(next);
  }
  flush();
  if (planned.length > 128) {
    // Once reused fragments exhaust the descriptor budget, repack the same
    // ordered rows before writing. Readers keep their existing bounded format.
    if (reused)
      return reconcilePages(store, [], type, desired, { stable, key, limit, maxBytes, field });
    throw Error('Projection page limit');
  }
  const result = [];
  for (const entry of planned)
    result.push(
      entry.descriptor ?? { count: entry.value.entries.length, ...(await store.put(entry.value)) },
    );
  return {
    pages: result,
    metrics: { reusedPages: reused, stagedPages: planned.length - reused },
    changed: !same(oldDescriptors, result),
  };
}
export const projectionDigest = (value) => digest(bytes(value));
