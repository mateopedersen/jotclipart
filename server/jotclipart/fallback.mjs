import { handleCookieRegion } from '../cookies/region.mjs';

/** Only local immutable UI/software assets. No old project/host proxy exists. */
export const transferCSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function fallbackFetch(request, env, execution, reviewedPagePolicy) {
  const url = new URL(request.url);
  if (url.pathname === '/api/cookie-region.json') return handleCookieRegion(request);
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  if (!env.ASSETS?.fetch) throw Error('Independent Pages asset binding required');
  const response = await env.ASSETS.fetch(request);
  const html = response.headers.get('content-type')?.toLowerCase().startsWith('text/html');
  if (!html && request.method !== 'HEAD') return response;
  const headers = new Headers(response.headers);
  if (html) {
    const csp = reviewedPagePolicy?.['Content-Security-Policy'];
    const script = /(?:^|;\s*)script-src\s+([^;]+)/.exec(csp ?? '');
    if (
      !script ||
      !script[1].split(/\s+/).includes("'self'") ||
      script[1].includes("'unsafe-inline'")
    )
      throw Error('Reviewed fallback page policy required');
    for (const [name, value] of Object.entries(reviewedPagePolicy)) {
      if (name.toLowerCase() === 'cache-control' && headers.has(name)) continue;
      headers.set(name, value);
    }
    const transfer =
      url.pathname === '/move-your-work' || url.pathname.startsWith('/move-your-work/');
    if (transfer) {
      headers.set('Content-Security-Policy', transferCSP);
      headers.set('Cache-Control', 'private, no-store, max-age=0');
      headers.set('CDN-Cache-Control', 'no-store');
      headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
      headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      headers.set('Referrer-Policy', 'no-referrer');
    } else if (response.status === 404) {
      headers.set('X-Robots-Tag', 'noindex');
    }
  }
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
