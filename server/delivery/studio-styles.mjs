const editorPath = (path) =>
  /^\/create\/$/.test(path) || /^\/edit\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path);
export function studioStyleRequest(request) {
  if (!['GET', 'HEAD'].includes(request.method) || !editorPath(new URL(request.url).pathname))
    return request;
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  return new Request(request, { headers });
}
/** A narrowly scoped transport patch for the already-reviewed mobile workspace.
 * The exact current shared stylesheet is bundled at release preparation. */
export function studioStylePatch(css, version) {
  if (
    typeof css !== 'string' ||
    !css.includes('.uc-editor') ||
    css.includes('</style') ||
    !/^[a-f0-9]{16}$/.test(version)
  )
    throw Error('Reviewed shared Studio stylesheet required');
  return async (request, response, Rewriter = globalThis.HTMLRewriter) => {
    const path = new URL(request.url).pathname;
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      !editorPath(path) ||
      response.status !== 200 ||
      !response.headers.get('Content-Type')?.includes('text/html')
    )
      return response;
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    const original = headers.get('ETag');
    const etag = original ? `"studio-${version}-${original.replaceAll('"', '')}"` : null;
    if (etag) headers.set('ETag', etag);
    headers.set('X-UC-Studio-Style', version);
    if (etag && request.headers.get('If-None-Match') === etag) {
      await response.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    if (typeof Rewriter !== 'function') throw Error('HTML streaming transformation is unavailable');
    const updated = new Response(response.body, { status: response.status, headers });
    return new Rewriter()
      .on('head', {
        element(element) {
          element.append(`<style data-uc-studio-style="${version}">${css}</style>`, { html: true });
        },
      })
      .transform(updated);
  };
}
