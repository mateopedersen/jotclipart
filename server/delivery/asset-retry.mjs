const retryable = new Set([500, 502, 503, 504]);

/** Read-only static delivery: one bounded retry for a transient asset-origin 5xx.
 * The caller must pass its ASSETS binding, never an API or other mutable handler.
 * A failed second response remains a failure; no empty success or stale fallback.
 */
export async function fetchAssetWithRetry(
  request,
  assets,
  { delayMs = 250, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1000)
    throw new RangeError('Static asset retry delay must be between 0 and 1,000 ms');
  const canRetry = request.method === 'GET' || request.method === 'HEAD';
  const retryRequest = canRetry ? request.clone() : null;
  const first = await assets.fetch(request);
  if (!canRetry || !retryable.has(first.status) || request.signal.aborted) return first;
  // Release the first origin stream before another request can start.
  await first.body?.cancel();
  await wait(delayMs);
  if (request.signal.aborted)
    throw request.signal.reason ?? new DOMException('The request was aborted', 'AbortError');
  return assets.fetch(retryRequest);
}
