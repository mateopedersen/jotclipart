/** Only this site's preview origins are excluded; production is unchanged. */
export function isJotclipartPreview(request) {
  const host = new URL(request.url).hostname;
  return (
    host === 'preview.jotclipart.com' ||
    host === 'jotclipart.pages.dev' ||
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jotclipart\.pages\.dev$/.test(host)
  );
}

export function previewResponsePolicy(request, response) {
  if (!isJotclipartPreview(request)) return response;
  const existing = response.headers.get('X-Robots-Tag') ?? '',
    tokens = new Set(existing.split(',').map((token) => token.trim().toLowerCase())),
    missing = ['noindex', 'nofollow'].filter((token) => !tokens.has(token));
  if (!missing.length) return response;
  // Pass the Response itself as init. Workerd preserves its internal automatic
  // or manual encodeBody contract, WebSocket and cf metadata. Replacing init
  // with a plain headers/status object can double-gzip precompressed responses.
  const result = new Response(response.body, response);
  result.headers.set('X-Robots-Tag', [existing, ...missing].filter(Boolean).join(', '));
  return result;
}

/** Wrap outside dispatch so early AI/share, catalog and fallback returns agree. */
export function withPreviewResponsePolicy(handler) {
  return async function (request, env, ctx) {
    return previewResponsePolicy(request, await handler.call(this, request, env, ctx));
  };
}
