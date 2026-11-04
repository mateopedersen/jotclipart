import { createCatalogHandler } from '../../server/catalog-snapshot/handler.mjs';
import { openSnapshot } from '../../server/catalog-snapshot/snapshot-context.mjs';
const renderer = {
  render: (state) =>
    JSON.stringify({
      props: state.props,
      counts: state.counts,
      curated: state.curatedCollections?.map((g) => ({
        slug: g.slug,
        count: g.count,
        topics: g.topics.map((t) => t.slug),
        covers: g.previews.map((a) => a.id),
        gallery: g.items?.map((a) => ({ id: a.id, topic: a.topic })),
      })),
      primary: state.categoryCollections?.map((g) => g.slug),
    }),
  css: '',
  scripts: {},
};
export default {
  async fetch(request, env) {
    const bucket = { get: (key) => env.TEST.get(key) };
    const handler = createCatalogHandler({
      bucket,
      allowPrivateFixture: true,
      softwareRevision: 'b'.repeat(40),
      capture: () => openSnapshot(bucket, { allowFixture: true }),
      renderers: {
        art: renderer,
        editor: renderer,
        home: renderer,
        collection: renderer,
        shells: { collections: [renderer.render, ''], cluster: [renderer.render, ''] },
        shellScripts: {},
      },
    });
    return (await handler(request)) ?? new Response('Not handled', { status: 404 });
  },
};
