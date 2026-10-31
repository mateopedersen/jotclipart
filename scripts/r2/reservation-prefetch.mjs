/**
 * Start the next complete, guarded account measurement while a still-fresh
 * reservation permits writes. This helper never issues or extends a lease.
 * A failed speculative read is retried by the ordinary write path when needed.
 */
export function createReservationPrefetch({
  refresh,
  current,
  canPrefetch,
  now = Date.now,
  scheduleTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
  warmAfterMs = 20_000,
}) {
  if (!Number.isSafeInteger(warmAfterMs) || warmAfterMs < 0 || warmAfterMs >= 40_000)
    throw Error('Invalid reservation prefetch age');
  let timer, pending, stopped = false;
  function schedule() {
    const lease = current();
    if (stopped || timer !== undefined || pending || !canPrefetch() || !lease) return;
    if (!Number.isSafeInteger(lease.observedAt)) throw Error('Invalid reservation observation');
    const delay = Math.max(0, lease.observedAt + warmAfterMs - now());
    timer = scheduleTimer(() => {
      timer = undefined;
      if (stopped || !canPrefetch()) return;
      pending = Promise.resolve().then(refresh);
      pending.then(
        () => {
          pending = undefined;
          schedule();
        },
        (error) => {
          pending = undefined;
          onError(error);
        },
      );
    }, delay);
    timer?.unref?.();
  }
  async function stop() {
    stopped = true;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    if (pending) await pending.catch(() => {});
  }
  return { schedule, stop };
}
