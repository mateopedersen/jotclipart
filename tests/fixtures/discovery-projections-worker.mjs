// Private native workerd/R2 fixture. Not reachable from the production router.
import { refreshDiscoveryViews } from '../../server/catalog-projections/refresh.mjs';
import { facetStore, lookupTopic } from '../../server/catalog-collections/store.mjs';
import { makeStore } from '../../server/catalog-search/store.mjs';
import { readShellField } from '../../server/catalog-projections/shell.mjs';
import { readFacts, collectionStore } from '../../server/catalog-projections/facts.mjs';
import { projectionDigest } from '../../server/catalog-projections/pages.mjs';
import { readUi, readUiEntries } from '../../server/catalog-search/ui-metadata.mjs';
async function context(bucket, indexes) {
  const store = makeStore(bucket),
    cs = facetStore(bucket),
    read = async (facet, d) => {
      if (facet === 'search') return store.get(d);
      if (['collections', 'artworks', 'counts'].includes(facet)) return cs.read(facet, d);
      if (facet !== 'recent' || !d.key.startsWith('catalog/objects/recent/') || d.bytes > 65536)
        throw Error('Private recent descriptor');
      const o = await bucket.get(d.key);
      if (!o || o.size !== d.bytes) throw Error('Missing private object');
      const b = await o.arrayBuffer();
      if (
        (await crypto.subtle
          .digest('SHA-256', b)
          .then((b) =>
            [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''),
          )) !== d.sha256
      )
        throw Error('Private hash differs');
      return JSON.parse(new TextDecoder().decode(b));
    };
  return {
    snapshot: { fixture: true, status: 'PRIVATE_UNPUBLISHABLE', revision: 'a'.repeat(40), indexes },
    rootSHA256: await projectionDigest(indexes),
    read,
    getFacet: (f) => read(f, indexes[f]),
  };
}
async function topic(bucket, ctx, slug) {
  const store = facetStore(bucket),
    r = await ctx.getFacet('collections'),
    d = await lookupTopic(store, r.directory, 'collection', slug);
  return d ? store.read('collections', d) : null;
}
export default {
  async fetch(request, env) {
    try {
      if (request.method !== 'POST')
        return new Response('Private native test only', { status: 405 });
      const p = await request.json();
      if (p.privateFixture !== true) throw Error('Private test required');
      const before = await context(env.TEST, p.before),
        after = await context(env.TEST, p.after),
        ss = makeStore(env.TEST, { writable: true });
      const result = await refreshDiscoveryViews({
        bucket: env.TEST,
        parentContext: before,
        context: after,
        changes: p.changes,
        topicChanges: p.topicChanges,
        searchStore: ss,
        searchDataDescriptor: p.searchDataDescriptor,
        sourceReceiptSHA256: 'b'.repeat(64),
        beforeTopic: (slug) => topic(env.TEST, before, slug),
        afterTopic: (slug) => topic(env.TEST, after, slug),
        readArtwork: async (id) => ({
          rootSHA256: after.rootSHA256,
          artwork: (await after.getFacet('artworks')).records[id],
        }),
      });
      const final = await context(env.TEST, {
          ...p.after,
          collections: result.collections,
          search: result.search,
        }),
        r = await final.getFacet('collections'),
        shell = await final.read('collections', r.shells),
        fields = {};
      for (const name of Object.keys(shell.fields))
        fields[name] = await readShellField(final, shell, name);
      const manifest = await ss.get(result.search),
        ui = await readUi({}, { manifest, store: ss }),
        facts = await readFacts(collectionStore(facetStore(env.TEST)), r.discoveryProjection);
      return Response.json({
        result,
        fields,
        topics: facts.topics.size,
        site: await readUiEntries(ss, ui, 'site', 'public-site-search-entries'),
        categories: await readUiEntries(ss, ui, 'categories', 'studio-category-entries'),
        mono: await readUiEntries(ss, ui, 'mono', 'monochrome-topic-entries'),
      });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 503 });
    }
  },
};
