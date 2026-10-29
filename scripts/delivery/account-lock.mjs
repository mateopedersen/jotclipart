import { openSync, writeFileSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
/** All local checkouts use the same account writer lock. Other machines must
 * serialize against this operator too; a local lock cannot govern remote users. */
export function acquireAccountWriter(env = process.env) {
  const directory = resolve(env.UC_R2_LOCK_ROOT ?? join(homedir(), 'Documents', 'Codex'));
  if (!statSync(directory).isDirectory()) throw Error('Shared R2 lock directory required');
  const path = join(directory, '.ultraclipart-r2-writer.lock');
  const fd = openSync(path, 'wx', 0o600);
  writeFileSync(
    fd,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      scope: 'ultraclipart-account-writes',
    }) + '\n',
  );
  return () => {
    closeSync(fd);
    unlinkSync(path);
  };
}

/** Wait for the existing writer, preserving the same exclusive lock. Never
 * remove another writer's lock, including an abandoned one. All inventory and
 * reservation work must start only after acquisition. */
export async function awaitAccountWriter(
  env = process.env,
  { timeoutMs = 3_600_000, pollMs = 250, notify = () => {} } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
    throw Error('Writer wait must be between 1 ms and one hour');
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 30_000)
    throw Error('Invalid writer polling interval');
  const started = Date.now();
  let waiting = false;
  while (true) {
    try {
      const release = acquireAccountWriter(env);
      if (waiting) {
        try {
          notify({ writerAcquired: true, waitedMs: Date.now() - started });
        } catch (error) {
          release();
          throw error;
        }
      }
      return release;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!waiting) {
        waiting = true;
        notify({ waitingForAccountWriter: true });
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0)
        throw Error('R2 writer is still occupied; its lock was preserved', { cause: error });
      await wait(Math.min(pollMs, remaining));
    }
  }
}
