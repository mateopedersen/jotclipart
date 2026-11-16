import { handleCookieRegion } from '../cookies/region.mjs';

/** Only local immutable UI/software assets. No old project/host proxy exists. */
export async function fallbackFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/cookie-region.json') return handleCookieRegion(request);
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  if (!env.ASSETS?.fetch) throw Error('Independent Pages asset binding required');
  return env.ASSETS.fetch(request);
}
