import {
  SITEMAP_KIND,
  SITEMAP_URL_LIMIT,
  separatedSitemaps,
  sitemapFamily,
  sitemapDocumentKind,
  sitemapChangeFamily,
  canonicalPageFamily,
} from './sitemap-policy.mjs';
// Private changed-part sitemap writer. Source approval and activation are external.
import { buildMap, mapGet, patchMap, digest } from '../catalog-search/store.mjs';
const MAX = 24 * 1024 ** 2,
  enc = new TextEncoder(),
  bytes = (x) => enc.encode(x).length;
export const sitemapEnvelope = (kind) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${kind.startsWith('images') ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' : ''}>`;
function identity(entry) {
  const loc = /^<url><loc>(https:\/\/ultraclipart\.com\/[a-z0-9/-]*)<\/loc>/.exec(entry ?? '')?.[1];
  if (!loc || !entry.endsWith('</url>')) throw Error('Invalid canonical sitemap entry');
  return loc;
}
const family = sitemapFamily;
const keyFor = (kind, loc) => `${family(kind)}|${loc}`;
const overhead = (kind) => bytes(sitemapEnvelope(kind) + '</urlset>');
function stats(entries) {
  return {
    slots: entries.length,
    count: entries.filter((x) => x !== null).length,
    xmlBytes: entries.reduce((n, x) => n + (x === null ? 0 : bytes(x)), 0),
  };
}
export async function bootstrapSitemaps(
  store,
  documents,
  { separated = documents.some((d) => /^(?:art|topics|collections)(?:-|$)/.test(d.kind)) } = {},
) {
  const maxUrls = separated ? SITEMAP_URL_LIMIT : 50000;
  const slots = [],
    rows = [],
    kinds = [],
    tails = {};
  for (const { kind, xml } of documents) {
    if (!SITEMAP_KIND.test(kind) || kinds.includes(kind)) throw Error('Invalid sitemap kind');
    const entries = xml.match(/<url>.*?<\/url>/gs) ?? [];
    if (
      !entries.length ||
      entries.length > maxUrls ||
      bytes(xml) > MAX ||
      xml !== sitemapEnvelope(kind) + entries.join('') + '</urlset>'
    )
      throw Error('Invalid sitemap baseline');
    const parts = [];
    for (let offset = 0; offset < entries.length; offset += 500) {
      const values = entries.slice(offset, offset + 500),
        part = parts.length;
      parts.push({
        ...(await store.put({
          type: 'sitemap-entries',
          protocol: 'slot-parts-v2',
          kind,
          part,
          entries: values,
        })),
        ...stats(values),
      });
      for (const [index, entry] of values.entries())
        slots.push({
          key: keyFor(kind, identity(entry)),
          value: { kind, part, index, entrySHA256: await digest(entry) },
        });
    }
    rows.push({
      key: kind,
      value: await store.put({
        type: 'sitemap-document',
        protocol: 'slot-parts-v2',
        kind,
        urls: entries.length,
        slots: entries.length,
        xmlBytes: bytes(xml),
        parts,
      }),
    });
    kinds.push(kind);
    tails[family(kind)] = kind;
  }
  return store.put({
    type: 'sitemap-directory',
    protocol: separated ? 'ledger-separated-v3' : 'ledger-slots-v2',
    documents: await buildMap(store, 'sitemap-documents', rows),
    slots: await buildMap(store, 'sitemap-slots', slots),
    index: await store.put({ type: 'sitemap-index', kinds }),
    tails,
  });
}
export async function applySitemapBatch(store, descriptor, changes) {
  const root = await store.get(descriptor);
  if (
    root.type !== 'sitemap-directory' ||
    !['ledger-slots-v2', 'ledger-separated-v3'].includes(root.protocol) ||
    !Array.isArray(changes)
  )
    throw Error('Invalid sitemap batch');
  const separated = separatedSitemaps(root),
    maxUrls = separated ? SITEMAP_URL_LIMIT : 50000;
  changes = changes.map((c) => ({ ...c, kind: sitemapChangeFamily(root, c.kind, c.loc) }));
  const seen = new Set(),
    prepared = [];
  for (const change of changes) {
    if (
      !(
        separated ? ['pages', 'topics', 'collections', 'art', 'images'] : ['pages', 'images']
      ).includes(change.kind) ||
      change.expectedEntrySHA256 === undefined ||
      (change.entry !== null && identity(change.entry) !== change.loc) ||
      !/^https:\/\/ultraclipart\.com\/[a-z0-9/-]*$/.test(change.loc ?? '')
    )
      throw Error('Invalid sitemap change');
    const key = keyFor(change.kind, change.loc);
    if (seen.has(key)) throw Error('Duplicate sitemap change');
    seen.add(key);
    const prior = await mapGet(store, root.slots, 'sitemap-slots', key);
    if ((prior?.entrySHA256 ?? null) !== change.expectedEntrySHA256)
      throw Error('Stale sitemap entry');
    if (change.entry === null && !prior) throw Error('Unknown sitemap removal');
    prepared.push({ ...change, key, prior });
  }
  const docs = new Map(),
    parts = new Map(),
    tails = { ...root.tails },
    slotUpdates = new Map(),
    index = await store.get(root.index),
    kinds = [...index.kinds];
  async function document(kind) {
    if (docs.has(kind)) return docs.get(kind);
    const d = await mapGet(store, root.documents, 'sitemap-documents', kind);
    if (!d) throw Error('Missing sitemap document');
    const value = await store.get(d);
    if (
      value.type !== 'sitemap-document' ||
      value.protocol !== 'slot-parts-v2' ||
      value.kind !== kind
    )
      throw Error('Invalid sitemap document');
    const copy = { ...value, parts: [...value.parts] };
    docs.set(kind, copy);
    return copy;
  }
  async function part(kind, number) {
    const key = `${kind}|${number}`;
    if (parts.has(key)) return parts.get(key);
    const doc = await document(kind),
      d = doc.parts[number];
    if (!d) throw Error('Missing sitemap part');
    const value = await store.get(d);
    if (
      value.type !== 'sitemap-entries' ||
      value.kind !== kind ||
      value.part !== number ||
      !Array.isArray(value.entries) ||
      value.entries.length > 500
    )
      throw Error('Invalid sitemap part');
    const copy = { ...value, entries: [...value.entries] };
    parts.set(key, copy);
    return copy;
  }
  async function replace(kind, number, index, value) {
    const doc = await document(kind),
      p = await part(kind, number),
      before = p.entries[index];
    if (index < 0 || index >= p.entries.length) throw Error('Missing sitemap slot');
    doc.urls += Number(value !== null) - Number(before !== null);
    doc.xmlBytes += (value === null ? 0 : bytes(value)) - (before === null ? 0 : bytes(before));
    p.entries[index] = value;
    return doc;
  }
  async function append(type, entry) {
    let kind = tails[type],
      doc = kind ? await document(kind) : null;
    if (!doc || doc.slots >= maxUrls || doc.xmlBytes + bytes(entry) > MAX) {
      const next = kind ? Number(kind.split('-')[1] ?? 1) + 1 : 1;
      kind = separated ? sitemapDocumentKind(type, next) : next === 1 ? type : `${type}-${next}`;
      if (kinds.includes(kind)) throw Error('Sitemap tail conflicts');
      doc = {
        schema: 1,
        type: 'sitemap-document',
        protocol: 'slot-parts-v2',
        kind,
        urls: 0,
        slots: 0,
        xmlBytes: overhead(kind),
        parts: [],
      };
      docs.set(kind, doc);
      tails[type] = kind;
      kinds.push(kind);
    }
    if (doc.xmlBytes + bytes(entry) > MAX) throw Error('One sitemap entry exceeds byte bound');
    const number = Math.floor(doc.slots / 500),
      index = doc.slots % 500,
      key = `${kind}|${number}`;
    let p = parts.get(key);
    if (!p) {
      if (doc.parts[number]) p = await part(kind, number);
      else {
        p = {
          schema: 1,
          type: 'sitemap-entries',
          protocol: 'slot-parts-v2',
          kind,
          part: number,
          entries: [],
        };
        parts.set(key, p);
      }
    }
    if (p.entries.length !== index) throw Error('Sitemap tail slot mismatch');
    p.entries.push(entry);
    doc.slots++;
    doc.urls++;
    doc.xmlBytes += bytes(entry);
    return { kind, part: number, index, entrySHA256: await digest(entry) };
  }
  for (const change of prepared) {
    const { prior, entry, key } = change;
    if (prior) {
      const old = await part(prior.kind, prior.part),
        before = old.entries[prior.index];
      if ((before === null ? null : await digest(before)) !== prior.entrySHA256)
        throw Error('Sitemap slot source changed');
      const doc = await document(prior.kind),
        delta = (entry === null ? 0 : bytes(entry)) - (before === null ? 0 : bytes(before));
      if (entry !== null && doc.xmlBytes + delta > MAX) {
        await replace(prior.kind, prior.part, prior.index, null);
        slotUpdates.set(key, await append(change.kind, entry));
      } else {
        await replace(prior.kind, prior.part, prior.index, entry);
        slotUpdates.set(key, {
          ...prior,
          entrySHA256: entry === null ? null : await digest(entry),
        });
      }
    } else slotUpdates.set(key, await append(change.kind, entry));
  }
  for (const p of parts.values()) {
    const doc = await document(p.kind),
      s = stats(p.entries);
    if (s.slots > 500 || p.entries.some((e) => e !== null && identity(e) === undefined))
      throw Error('Invalid changed sitemap part');
    doc.parts[p.part] = { ...(await store.put(p)), ...s };
  }
  const docUpdates = new Map();
  for (const [kind, doc] of docs) {
    if (
      doc.urls < 0 ||
      doc.urls > maxUrls ||
      doc.slots > maxUrls ||
      doc.xmlBytes > MAX ||
      doc.parts.reduce((n, p) => n + p.count, 0) !== doc.urls ||
      overhead(kind) + doc.parts.reduce((n, p) => n + p.xmlBytes, 0) !== doc.xmlBytes
    )
      throw Error('Sitemap aggregate mismatch');
    docUpdates.set(kind, await store.put(doc));
  }
  const activeKinds = [];
  for (const kind of new Set([...kinds, ...docs.keys()])) {
    const changed = docs.get(kind);
    if (!changed || changed.urls > 0) activeKinds.push(kind);
  }
  activeKinds.sort(
    (a, b) =>
      Number(a.startsWith('images')) - Number(b.startsWith('images')) ||
      Number(a.split('-')[1] ?? 1) - Number(b.split('-')[1] ?? 1),
  );
  if (activeKinds.length > 50000) throw Error('Sitemap index limit exceeded');
  return store.put({
    ...root,
    documents: await patchMap(store, root.documents, 'sitemap-documents', docUpdates),
    slots: await patchMap(store, root.slots, 'sitemap-slots', slotUpdates),
    index: await store.put({ type: 'sitemap-index', kinds: activeKinds }),
    tails,
  });
}
