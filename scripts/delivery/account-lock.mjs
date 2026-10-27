import { openSync, writeFileSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
