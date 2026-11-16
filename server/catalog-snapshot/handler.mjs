import {
  catalogOgRoute,
  catalogOgSource,
  readCatalogOgSource,
  applyCatalogOgMetadata,
} from '../jotclipart/og-catalog-source.mjs';
import { teacherArtworkIDs } from '../../src/lib/teacher-resources.ts';
import { auxiliaryRoutes } from './auxiliary-routes.mjs';
import { resolvePublicArtworkRoute } from './public-artwork-routes.mjs';
import { separatedSitemaps } from './sitemap-policy.mjs';
import { readPreparedHTML } from './prepared-html.mjs';
import { readPreparedStudioInfo } from './prepared-studio.mjs';
import { preloadDocumentModules } from './module-preloads.mjs';
import { navigationRulesResponse, publicNavigationDocument } from './navigation-speculation.mjs';
import { snapshotHTMLResponse } from './snapshot-html-cache.mjs';
import { readSurprisePicks } from './surprise-picks.mjs';
import { readCollectionReferences } from '../catalog-collections/reader.mjs';
import { readPublicArtwork as readArtwork } from './public-artwork-routes.mjs';
// Integration handler: injected capture must authenticate production snapshots.
import { readArtworkPageState } from './art-page-data.mjs';
import { readEditorPageState } from './editor-page-data.mjs';
import { readHomePageState } from './home-page-data.mjs';
import { readShellPageState } from './shell-page-data.mjs';
import { readSitemap } from './sitemap-reader.mjs';
import { openSevenFacetCollectionContext } from './collection-context.mjs';
import { collectionStateFromContext } from './collection-page-data.mjs';
import { createSnapshotSearchApi } from '../catalog-search/api.mjs';
import { uiProviders } from '../catalog-search/ui-metadata.mjs';
import { curatedBySlug, curatedSitemap } from '../../src/lib/curated-collection-policy.mjs';
import { curatedStatistics } from './curated-collections.mjs';
const paths = {
  ...auxiliaryRoutes,
  '/new/': 'new',
  '/search/': 'search',
  '/black-and-white/': 'monochrome',
  '/categories/': 'categories',
  '/collections/': 'collections',
  '/library-index/': 'library',
  '/create/': 'create',
  '/favorites/': 'favorites',
  '/ai-clipart-generator/': 'ai',
};
const json = (body, root) =>
  Response.json(body, { headers: { 'cache-control': 'no-store', 'x-uc-snapshot': root } });
const missing = () =>
  new Response(
    '<!doctype html><html lang="en"><head><meta name="robots" content="noindex"><title>Page Not Found</title></head><body><h1>Page Not Found</h1><a href="/">JotClipart</a></body></html>',
    {
      status: 404,
      headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
    },
  );
export function createCatalogHandler({
  capture,
  bucket,
  allowPrivateFixture = false,
  softwareRevision,
  redirects = {},
  renderers,
  cache,
  rendererSHA256,
  validateHTML,
  defer,
  ogService,
}) {
  if (typeof capture !== 'function' || !bucket) throw Error('Captured catalog provider required');
  const { render: renderArtwork, css: artCSS, scripts: artScripts } = renderers.art,
    {
      render: renderEditor,
      css: editorCSS,
      scripts: editorScripts,
      preloads: editorPreloads,
    } = renderers.editor,
    { render: renderHome, css: homeCSS, scripts: homeScripts } = renderers.home,
    {
      render: renderCollection,
      css: collectionCSS,
      scripts: collectionScripts,
    } = renderers.collection,
    shells = renderers.shells,
    shellScripts = renderers.shellScripts;
  return async (request) => {
    const rules = navigationRulesResponse(request);
    if (rules) return rules;
    const url = new URL(request.url),
      path = url.pathname,
      legacyDownload = /^\/download\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(path),
      art =
        /^\/(art|edit)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(path) ??
        (legacyDownload ? [path, 'art', legacyDownload[1]] : null),
      topic = /^\/clipart\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path),
      cluster = /^\/collection\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path),
      xml = /^\/sitemap(?:-(?:(?:pages|topics|collections|art|images)(?:-[1-9]\d*)?))?\.xml$/.test(
        path,
      ),
      kind = paths[path],
      ogRoute = ogService ? catalogOgRoute(path) : undefined,
      siteDirectory = /^\/search-data\/([a-f0-9]{64})\/(?:site|navigation)\.json$/.exec(path);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (redirects[path]) {
        const target = new URL(redirects[path], url.origin);
        target.search = url.search;
        return Response.redirect(target, 301);
      }
      if (
        !path.endsWith('/') &&
        (/^\/(?:edit|clipart|collection)\/[a-z0-9-]+$/.test(path) ||
          Object.hasOwn(paths, path + '/'))
      )
        return Response.redirect(new URL(path + '/' + url.search, url.origin), 301);
    }
    // Older open tabs retain the legacy manifests and their immutable old data.
    if (
      [
        '/search-data/manifest.json',
        '/studio-manifest.json',
        '/studio-featured.json',
        '/studio-catalog.json',
      ].includes(path) &&
      request.headers.get('x-uc-catalog-protocol') !== 'snapshot-search-v1'
    )
      return null;
    const apiPath =
      Boolean(siteDirectory) ||
      [
        '/catalog-search.json',
        '/search-data/manifest.json',
        '/studio-manifest.json',
        '/studio-featured.json',
        '/studio-catalog.json',
        '/catalog-stats.json',
        '/surprise-picks.json',
        '/related-release.json',
        '/delivery-release.json',
        '/category-search/current.json',
        '/collection-feed.json',
      ].includes(path);
    if (!art && !topic && !cluster && !xml && !kind && path !== '/' && !apiPath && !ogRoute)
      return null;
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !(path === '/catalog-search.json' && request.method === 'POST')
    )
      return new Response('Method not allowed', {
        status: 405,
        headers: {
          allow: path === '/catalog-search.json' ? 'POST' : 'GET, HEAD',
          'cache-control': 'no-store',
        },
      });
    try {
      const requestStarted = performance.now();
      const context = await capture(request),
        privateRoot =
          context?.snapshot?.fixture === true ||
          context?.snapshot?.status === 'PRIVATE_UNPUBLISHABLE';
      if (privateRoot ? !allowPrivateFixture : context?.authorizationVerified !== true)
        throw Error('Catalog authorization missing');
      const capturedAt = performance.now();
      const resultHeaders = {
        'content-type': 'text/html;charset=utf-8',
        'cache-control': 'no-cache',
        'x-uc-snapshot': context.rootSHA256,
        'x-uc-revision': context.snapshot.revision,
      };
      const cc = () =>
        openSevenFacetCollectionContext(bucket, {
          snapshot: context.snapshot,
          allowUnpublishableFixture: allowPrivateFixture,
        });
      const api = createSnapshotSearchApi({
        captureAuthorizedSnapshot: async () => ({ ...context, bucket }),
        bucket,
        allowPrivateFixture,
        directoryCache: cache,
        defer,
        ...uiProviders,
      });
      if (ogRoute) {
        const source = await readCatalogOgSource({
          bucket,
          context,
          ...ogRoute,
          allowFixture: allowPrivateFixture,
        });
        if (!source || (await ogService.descriptor(source)).digest !== ogRoute.digest)
          return missing();
        const image = await ogService.image(request, source, { cache, defer });
        const headers = new Headers(image.headers);
        headers.set('x-uc-snapshot', context.rootSHA256);
        return new Response(request.method === 'HEAD' ? null : image.body, {
          status: image.status,
          headers,
        });
      }
      if (
        xml &&
        path === '/sitemap-images.xml' &&
        separatedSitemaps(await context.getFacet('sitemaps'))
      )
        return Response.redirect(new URL('/sitemap-images-1.xml', url.origin), 301);
      let resolvedArtwork;
      if (art && art[1] === 'art') {
        resolvedArtwork = await resolvePublicArtworkRoute(context, art[2]);
        if (!resolvedArtwork) return missing();
        if (resolvedArtwork.slug !== art[2] || path !== '/art/' + resolvedArtwork.slug + '/') {
          if (!(await readArtwork(context, resolvedArtwork.id))) return missing();
          return Response.redirect(
            new URL('/art/' + resolvedArtwork.slug + '/' + url.search, url.origin),
            301,
          );
        }
      }
      let response;
      if (siteDirectory) response = await api.siteDirectory(request, siteDirectory[1]);
      else if (path === '/catalog-search.json') response = await api.post(request);
      else if (path === '/search-data/manifest.json') response = await api.manifest(request);
      else if (path === '/studio-manifest.json') response = await api.studioManifest(request);
      else if (path === '/studio-featured.json' || path === '/studio-catalog.json') {
        const prepared = rendererSHA256
          ? await readPreparedStudioInfo(context, rendererSHA256)
          : null;
        response =
          prepared === null
            ? await api.studioCatalog(request)
            : new Response(prepared, {
                headers: {
                  'Content-Type': 'application/json',
                  'Cache-Control': 'private, no-store',
                  'X-Content-Type-Options': 'nosniff',
                  'x-uc-data-source': 'prepared',
                },
              });
      } else if (path === '/catalog-stats.json') {
        const c = await cc(),
          base =
            url.searchParams.get('scope') === 'visible'
              ? await c.countsFor(url.searchParams.getAll('topic'))
              : await c.allLegacyCounts();
        response = json(await curatedStatistics(c, base), context.rootSHA256);
      } else if (path === '/surprise-picks.json') {
        response = json(
          { version: 3, items: await readSurprisePicks(context) },
          context.rootSHA256,
        );
      } else if (path === '/related-release.json')
        response = json(
          { version: (await context.getFacet('related')).version },
          context.rootSHA256,
        );
      else if (path === '/delivery-release.json') {
        const c = await cc();
        response = json(
          {
            schema: 2,
            mode: 'catalog-snapshot-v1',
            renderedRevision: context.snapshot.revision,
            controlRevision: softwareRevision,
            verifiedRoot: context.rootSHA256,
            artworks: c.global.totals.artworks,
            subjects: c.global.totals.subjects,
          },
          context.rootSHA256,
        );
      } else if (xml) {
        let body;
        if (
          (path === '/sitemap-collections.xml' || path === '/sitemap.xml') &&
          !separatedSitemaps(await context.getFacet('sitemaps'))
        ) {
          const c = await cc(),
            keys = [...new Set([...curatedBySlug.values()].flatMap((g) => g.topicSlugs))],
            counts = {};
          for (let i = 0; i < keys.length; i += 64)
            Object.assign(counts, (await c.countsFor(keys.slice(i, i + 64))).topics);
          const extra = curatedSitemap(counts);
          if (path === '/sitemap-collections.xml') body = extra;
          else {
            body = await readSitemap(context, path);
            if (extra)
              body = body.replace(
                '</sitemapindex>',
                '<sitemap><loc>https://jotclipart.com/sitemap-collections.xml</loc></sitemap></sitemapindex>',
              );
          }
        } else body = await readSitemap(context, path);
        response =
          body === undefined
            ? missing()
            : new Response(body, {
                headers: { ...resultHeaders, 'content-type': 'application/xml;charset=utf-8' },
              });
      } else if (path === '/category-search/current.json' || path === '/collection-feed.json') {
        const state = await readShellPageState(
          bucket,
          context,
          path === '/collection-feed.json' ? 'collections' : 'categories',
          { allowFixture: allowPrivateFixture, dataOnly: true },
        );
        response = json(
          path === '/collection-feed.json'
            ? state.collectionFeed
            : {
                version: 1,
                subjects: state.categorySubjects.map((s) => ({
                  id: s.slug,
                  name: s.name,
                  groups: s.groups.join(' '),
                  keywords: s.searchKeywords,
                })),
              },
          context.rootSHA256,
        );
      } else {
        const generate = async () => {
          let state,
            html = await readPreparedHTML(context, path, rendererSHA256);
          resultHeaders['x-uc-html-source'] = html === null ? 'rendered' : 'prepared';
          if (html === null) {
            html = undefined;
            if (path === '/') {
              state = await readHomePageState(bucket, context, {
                allowFixture: allowPrivateFixture,
              });
              html = await renderHome(state, 'https://jotclipart.com/', homeCSS, homeScripts);
            } else if (art) {
              state =
                art[1] === 'art'
                  ? await readArtworkPageState(bucket, context, resolvedArtwork?.id ?? art[2], {
                      allowFixture: allowPrivateFixture,
                    })
                  : await readEditorPageState(bucket, context, art[2], {
                      allowFixture: allowPrivateFixture,
                    });
              if (state)
                html =
                  art[1] === 'art'
                    ? await renderArtwork(
                        state,
                        'https://jotclipart.com' + path,
                        artCSS,
                        artScripts,
                      )
                    : await renderEditor(
                        state,
                        'https://jotclipart.com' + path,
                        editorCSS,
                        editorScripts,
                        editorPreloads,
                      );
            } else if (topic) {
              try {
                state = (
                  await ((await context.getFacet('collections')).viewProtocol ===
                  'collection-references-v2'
                    ? readCollectionReferences(context, topic[1], {
                        resolveArtwork: async (id, ctx) => ({
                          rootSHA256: ctx.rootSHA256,
                          artwork: await readArtwork(ctx, id),
                        }),
                        resolveSurprise: async (ctx) => ({
                          rootSHA256: ctx.rootSHA256,
                          items: await readSurprisePicks(ctx, { limit: 48 }),
                        }),
                      })
                    : collectionStateFromContext(await cc(), topic[1]))
                ).state;
              } catch (error) {
                if (error.status !== 404) throw error;
              }
              if (state)
                html = await renderCollection(
                  state,
                  'https://jotclipart.com' + path,
                  collectionCSS,
                  collectionScripts,
                );
            } else {
              const selected = cluster ? 'cluster' : kind,
                c = cluster ? (await cc()).global.collections[cluster[1]] : undefined,
                clusterName = cluster
                  ? curatedBySlug.has(cluster[1])
                    ? cluster[1]
                    : c?.name
                  : undefined;
              if (cluster && !clusterName) {
                const cctx = await cc(),
                  root = await context.read('collections', cctx.collections.shells),
                  pages = root.fields.clusters;
                for (const d of pages) {
                  const page = await context.read('collections', d, { maxBytes: 65536 });
                  for (const name of page.entries)
                    if (
                      name
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '') === cluster[1]
                    )
                      state = { cluster: name };
                }
                if (!state) return missing();
              }
              state = await readShellPageState(
                bucket,
                context,
                auxiliaryRoutes[path] ? 'new' : selected,
                {
                  cluster: clusterName ?? state?.cluster,
                  allowFixture: allowPrivateFixture,
                },
              );
              if (state && selected === 'teachers') {
                const ids = new Set(state.art.map((a) => a.id));
                for (const id of teacherArtworkIDs) {
                  if (ids.has(id)) continue;
                  const item = await readArtwork(context, id);
                  if (!item?.published || !item.indexable)
                    throw Error('Missing source-bound teacher artwork');
                  state.art.push(item);
                }
              }
              if (state && selected === 'info') state.params = { info: path.split('/')[1] };
              if (state)
                html = await shells[selected][0](
                  state,
                  'https://jotclipart.com' + path,
                  shells[selected][1],
                  shellScripts,
                );
            }
          }
          if (html !== undefined) {
            if (ogService && (art || topic || cluster)) {
              const ogKind = art
                ? art[1] === 'art'
                  ? 'art'
                  : 'editor'
                : topic
                  ? 'topic'
                  : 'collection';
              const ogId = art ? (resolvedArtwork?.id ?? art[2]) : (topic?.[1] ?? cluster[1]);
              const source = state
                ? await catalogOgSource({ kind: ogKind, id: ogId, state, context })
                : await readCatalogOgSource({
                    bucket,
                    context,
                    kind: ogKind,
                    id: ogId,
                    allowFixture: allowPrivateFixture,
                  });
              if (!source) throw Error('Missing authenticated page OG source');
              html = applyCatalogOgMetadata(html, await ogService.descriptor(source));
            }
            html = preloadDocumentModules(html, softwareRevision, renderers.moduleImports);
            if (publicNavigationDocument(path))
              html = html.replace(
                '</head>',
                '<meta name="uc-navigation-rules" content="/navigation-rules.json"></head>',
              );
            if (!/^[a-f0-9]{64}$/.test(context.rootSHA256))
              throw Error('Invalid captured identity');
            html = html.replace(
              /(<meta name="build-revision" content=")[a-f0-9]{40}(")/,
              (_, a, b) => a + context.snapshot.revision + b,
            );
            html = html.replace(
              '</head>',
              '<meta name="catalog-snapshot" content="' + context.rootSHA256 + '"></head>',
            );
            if (validateHTML) await validateHTML(html);
          }
          return html === undefined ? missing() : new Response(html, { headers: resultHeaders });
        };
        response = cache
          ? await snapshotHTMLResponse({
              request,
              context,
              rendererSHA256,
              cache,
              render: generate,
              defer,
            })
          : await generate();
      }
      const headers = new Headers(response.headers);
      // Numeric request-local diagnostics only; never persist timings in cached HTML.
      const completedAt = performance.now();
      headers.append(
        'Server-Timing',
        `uc_capture;dur=${Math.max(0, capturedAt - requestStarted).toFixed(1)}, uc_resolve;dur=${Math.max(0, completedAt - capturedAt).toFixed(1)}, uc_total;dur=${Math.max(0, completedAt - requestStarted).toFixed(1)}`,
      );
      if (
        response.status === 200 &&
        publicNavigationDocument(path) &&
        headers.get('content-type')?.startsWith('text/html')
      )
        headers.set('Speculation-Rules', '"/navigation-rules.json"');
      headers.set('x-uc-snapshot', context.rootSHA256);
      headers.set('x-uc-revision', context.snapshot.revision);
      if (privateRoot) headers.set('x-private-catalog', 'not-published');
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        headers,
      });
    } catch (error) {
      return new Response('Temporarily unavailable', {
        status: 503,
        headers: {
          'cache-control': 'no-store',
          ...(allowPrivateFixture ? { 'x-private-error': String(error).slice(0, 400) } : {}),
        },
      });
    }
  };
}
