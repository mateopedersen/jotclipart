import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireAccountWriter, awaitAccountWriter } from '../scripts/delivery/account-lock.mjs';

test('a queued release cannot replace another writer and acquires only after release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-writer-'));
  const env = { UC_R2_LOCK_ROOT: root },
    path = join(root, '.ultraclipart-r2-writer.lock');
  let original = acquireAccountWriter(env),
    next;
  try {
    const before = readFileSync(path, 'utf8'),
      events = [];
    const pending = awaitAccountWriter(env, {
      timeoutMs: 2000,
      pollMs: 5,
      notify: (x) => events.push(x),
    });
    assert.deepEqual(events, [{ waitingForAccountWriter: true }]);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.throws(() => acquireAccountWriter(env), { code: 'EEXIST' });
    original();
    original = undefined;
    next = await pending;
    assert.equal(events.at(-1).writerAcquired, true);
    assert.ok(existsSync(path));
    assert.throws(() => acquireAccountWriter(env), { code: 'EEXIST' });
    next();
    next = undefined;
    assert.equal(existsSync(path), false);
  } finally {
    next?.();
    original?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bounded wait preserves an occupied or abandoned lock and propagates other failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-writer-'));
  const env = { UC_R2_LOCK_ROOT: root },
    path = join(root, '.ultraclipart-r2-writer.lock');
  const release = acquireAccountWriter(env),
    before = readFileSync(path, 'utf8');
  try {
    await assert.rejects(
      awaitAccountWriter(env, { timeoutMs: 15, pollMs: 5 }),
      /lock was preserved/,
    );
    assert.equal(readFileSync(path, 'utf8'), before);
    await assert.rejects(awaitAccountWriter({ UC_R2_LOCK_ROOT: join(root, 'missing') }), {
      code: 'ENOENT',
    });
    await assert.rejects(awaitAccountWriter(env, { timeoutMs: 0 }), /one hour/);
    await assert.rejects(awaitAccountWriter(env, { pollMs: 0 }), /polling/);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});
