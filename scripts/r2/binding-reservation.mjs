import { setTimeout as delay } from 'node:timers/promises';
/** A stale complete measurement can only trigger another complete read, never a lease. */
export async function freshBindingReservation(measure, { wait = delay, onStale = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await measure();
    } catch (error) {
      const stale =
        error.message === 'Fresh complete account inventory required' &&
        Array.isArray(error.readOnlyInventoryHints);
      // A failed capability proof is never accepted. A complete new census may
      // recover from a transient or delayed proof; malformed proofs still stop
      // publication after the same bounded three attempts.
      const rejectedCapability = error.message === 'Invalid disabled-jurisdiction capability proof';
      if (attempt >= 2 || (!stale && !rejectedCapability)) throw error;
      if (stale) onStale(error.readOnlyInventoryHints);
      await wait(1000 * (attempt + 1));
    }
  }
}
