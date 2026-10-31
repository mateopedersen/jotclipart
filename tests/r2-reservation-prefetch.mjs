import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReservationPrefetch } from '../scripts/r2/reservation-prefetch.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ refresh } = {}) {
  let time = 10_000, lease = { observedAt: time }, enabled = true, calls = 0, errors = 0;
  const timers = new Map();
  let next = 0;
  const scheduler = createReservationPrefetch({
    now: () => time,
    current: () => lease,
    canPrefetch: () => enabled,
    scheduleTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    refresh: async () => { calls++; await refresh?.(); lease = { observedAt: time }; },
    onError: () => { errors++; },
  });
  return {
    scheduler, timers, get calls() { return calls; }, get errors() { return errors; },
    disable() { enabled = false; },
    advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } },
  };
}

test('speculative census starts once while the old reservation is still fresh', async () => {
  const f = fixture();
  f.scheduler.schedule(); f.scheduler.schedule();
  assert.equal(f.timers.size, 1);
  f.advance(19_999); await tick(); assert.equal(f.calls, 0);
  f.advance(1); await tick(); assert.equal(f.calls, 1);
  assert.equal(f.timers.size, 1, 'successful census schedules the next cycle');
  await f.scheduler.stop(); assert.equal(f.timers.size, 0);
});

test('a slow prefetch never starts a second measurement', async () => {
  let finish;
  const f = fixture({ refresh: () => new Promise((resolve) => { finish = resolve; }) });
  f.scheduler.schedule(); f.advance(20_000); await tick();
  f.scheduler.schedule(); f.advance(50_000); await tick();
  assert.equal(f.calls, 1); assert.equal(f.timers.size, 0);
  finish(); await tick(); await f.scheduler.stop();
});

test('failed speculative reads do not create a lease or spin retries', async () => {
  const f = fixture({ refresh: async () => { throw Error('unavailable'); } });
  f.scheduler.schedule(); f.advance(20_000); await tick();
  assert.equal(f.calls, 1); assert.equal(f.errors, 1); assert.equal(f.timers.size, 0);
  f.scheduler.schedule(); assert.equal(f.timers.size, 1, 'normal writer may schedule a later retry');
  await f.scheduler.stop();
});

test('stopping waits for in-flight census before final post-transfer measurement', async () => {
  let finish, stopped = false;
  const f = fixture({ refresh: () => new Promise((resolve) => { finish = resolve; }) });
  f.scheduler.schedule(); f.advance(20_000); await tick();
  const done = f.scheduler.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  finish(); await done; await tick(); assert.equal(stopped, true); assert.equal(f.timers.size, 0);
  f.scheduler.schedule(); assert.equal(f.timers.size, 0);
});

test('no work means no speculative account measurement', async () => {
  const f = fixture(); f.disable(); f.scheduler.schedule(); f.advance(100_000); await tick();
  assert.equal(f.calls, 0); await f.scheduler.stop();
});
