// Coalesce only simultaneous public HTML renders in the same existing cache.
// Identity includes the authenticated root and renderer; no R2 data is written.
const pendingByCache = new WeakMap();
export async function renderSingleFlight(cache, key, render) {
  if (!cache) return render();
  let pending = pendingByCache.get(cache);
  if (!pending) pendingByCache.set(cache, (pending = new Map()));
  const previous = pending.get(key);
  if (previous) {
    const result = await previous;
    return result ? new Response(result.bytes, result.options) : render();
  }
  if (pending.size >= 32) return render();
  let resolve, reject;
  const result = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  result.catch(() => {});
  pending.set(key, result);
  try {
    const response = await render();
    if (
      !(response instanceof Response) ||
      response.status !== 200 ||
      response.headers.has('set-cookie') ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')
    ) {
      resolve(null);
      return response;
    }
    const bytes = await response.arrayBuffer();
    const options = { status: response.status, headers: [...response.headers] };
    resolve(bytes.byteLength <= 2 * 1024 * 1024 ? { bytes, options } : null);
    return new Response(bytes, options);
  } catch (error) {
    reject(error);
    throw error;
  } finally {
    pending.delete(key);
  }
}
