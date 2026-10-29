import { setTimeout as delay } from 'node:timers/promises';
/** A stale complete measurement can only trigger another complete read, never a lease. */
export async function freshBindingReservation(measure, { wait = delay, onStale = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await measure();
    } catch (error) {
      if (
        attempt >= 2 ||
        error.message !== 'Fresh complete account inventory required' ||
        !Array.isArray(error.readOnlyInventoryHints)
      )
        throw error;
      onStale(error.readOnlyInventoryHints);
      await wait(1000 * (attempt + 1));
    }
  }
}
