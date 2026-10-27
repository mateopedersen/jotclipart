const htmlRoute = /^\/(art|edit)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const previewRoute = /^\/previews\/p1\/[a-f0-9]{24}-(96|220|320|440|640|960)\.webp$/;
const assetRoute = /^\/_astro\/[A-Za-z0-9_.-]+$/;
const temporary = () =>
  new Response('File temporarily unavailable', {
    status: 503,
    headers: { 'Cache-Control': 'no-store' },
  });
/** The activated Worker owns one verified HTML release and immutable asset keys.
 * No administrative write operation is exposed by the production Worker. */
export function createPublicFileHandler(options) {
  if (!/^[a-f0-9]{40}$/.test(options.revision ?? '') || !Array.isArray(options.ids))
    throw Error('Verified delivery release required');
  const ids = new Set(options.ids),
    withdrawn = new Set(options.withdrawnIds ?? []);
  return async function handle(
    request,
    env,
    context,
    fallback,
    cache = globalThis.caches?.default,
  ) {
    const url = new URL(request.url),
      match = htmlRoute.exec(url.pathname);
    const html = !!match;
    if (!html && !previewRoute.test(url.pathname) && !assetRoute.test(url.pathname))
      return fallback.fetch(request, env);
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (html) {
      const [, kind, id] = match;
      if (!ids.has(id) || withdrawn.has(id)) return fallback.fetch(request, env);
      if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
        return Response.redirect(url, 308);
      }
    }
    if (!env.CATALOG_PAGES) return temporary();
    const pathname = url.pathname;
    const objectKey = html
      ? `delivery/${options.revision}${pathname}index.html`
      : pathname.startsWith('/_astro/')
        ? `delivery/assets${pathname}`
        : `delivery${pathname}`;
    // HTML is isolated by release, including withdrawal changes. Public files
    // have no visitor-specific data. Tracking queries cannot multiply the cache.
    const cacheUrl = new URL(url);
    cacheUrl.search = '';
    cacheUrl.searchParams.set('__uc_release', html ? options.revision : 'immutable-v1');
    const cacheKey = new Request(cacheUrl, { method: 'GET' }),
      range = request.headers.get('Range');
    if (!range && cache) {
      try {
        const hit = await cache.match(cacheKey);
        if (hit) {
          if (html)
            hit.headers.set('Cache-Control', 'public,max-age=0,s-maxage=300,must-revalidate');
          if (request.headers.get('If-None-Match') === hit.headers.get('ETag'))
            return new Response(null, { status: 304, headers: hit.headers });
          return new Response(request.method === 'HEAD' ? null : hit.body, {
            status: hit.status,
            headers: hit.headers,
          });
        }
      } catch {
        /* A cache outage does not invalidate the checked R2 source. */
      }
    }
    let object;
    try {
      object =
        request.method === 'HEAD' || range
          ? await env.CATALOG_PAGES.head(objectKey)
          : await env.CATALOG_PAGES.get(objectKey);
    } catch {
      return temporary();
    }
    // A verified active file disappearing is an outage, never a soft 404/empty 200.
    if (!object) return temporary();
    const headers = new Headers(
      html && match[1] === 'edit' ? options.editorHeaders : options.pageHeaders,
    );
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
    headers.set('Content-Length', String(object.size));
    headers.set('ETag', object.httpEtag);
    headers.set(
      'Cache-Control',
      html ? 'public,max-age=0,s-maxage=300,must-revalidate' : 'public,max-age=31536000,immutable',
    );
    headers.set('X-UC-Delivery', `r2; html=${options.revision}`);
    if (html && match[1] === 'edit') headers.set('X-Robots-Tag', 'noindex');
    if (request.headers.get('If-None-Match') === object.httpEtag)
      return new Response(null, { status: 304, headers });
    let status = 200;
    if (
      range &&
      request.method === 'GET' &&
      !html &&
      (!request.headers.has('If-Range') || request.headers.get('If-Range') === object.httpEtag)
    ) {
      const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start, end;
      if (parsed && (parsed[1] || parsed[2])) {
        start = parsed[1] ? Number(parsed[1]) : Math.max(0, object.size - Number(parsed[2]));
        end = parsed[1]
          ? parsed[2]
            ? Math.min(Number(parsed[2]), object.size - 1)
            : object.size - 1
          : object.size - 1;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= object.size ||
        end < start
      ) {
        headers.set('Content-Range', `bytes */${object.size}`);
        headers.delete('Content-Length');
        return new Response(null, { status: 416, headers });
      }
      try {
        object = await env.CATALOG_PAGES.get(objectKey, {
          range: { offset: start, length: end - start + 1 },
        });
      } catch {
        return temporary();
      }
      if (!object) return temporary();
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
      headers.set('Content-Length', String(end - start + 1));
    } else if (range && request.method === 'GET') {
      try {
        object = await env.CATALOG_PAGES.get(objectKey);
      } catch {
        return temporary();
      }
      if (!object) return temporary();
    }
    if (!html) headers.set('Accept-Ranges', 'bytes');
    const response = new Response(request.method === 'HEAD' ? null : object.body, {
      status,
      headers,
    });
    if (request.method === 'GET' && !range && status === 200 && cache && context?.waitUntil) {
      const stored = response.clone();
      if (html) stored.headers.set('Cache-Control', 'public,max-age=300');
      context.waitUntil(cache.put(cacheKey, stored).catch(() => {}));
    }
    return response;
  };
}
