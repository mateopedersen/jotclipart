import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
/** Read-only retries decrease work per edge invocation, keeping the exact same
 * account coverage and hard freshness window. Permission failures never retry. */
export function createSignedInventoryFetch({
  secret,
  fetcher = fetch,
  wait = sleep,
  now = Date.now,
}) {
  return async (command) => {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      const payload = { ...command, limit: [1000, 500, 250][attempt], action: 'list', at: now() };
      const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(JSON.stringify(payload))
        .digest('hex');
      try {
        const response = await fetcher('http://127.0.0.1:8899/inventory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: payload, signature }),
          signal: AbortSignal.timeout(15000),
        });
        if (![500, 502, 503, 504].includes(response.status)) {
          if (!response.ok)
            throw Object.assign(Error(`Bound inventory refused: ${response.status}`), {
              permanent: true,
            });
          // A connection can close after headers, while the body is being read.
          // Await here so the same bounded read-only retry covers that failure.
          return await response.json();
        }
        await response.body?.cancel();
        last = Error(`Bound inventory unavailable: ${response.status}`);
      } catch (error) {
        if (error.permanent) throw error;
        last = error;
      }
      if (attempt < 2) await wait(250 * (attempt + 1));
    }
    throw last;
  };
}
