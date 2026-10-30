import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { awaitAccountWriter } from './account-lock.mjs';

// Serialize the whole build/activation operation separately from the shorter
// R2 writer lock. The child stager can acquire its normal account lock without
// deadlocking on its own parent's publication lock.
export async function awaitPublicationWriter(env = process.env, options = {}) {
  const directory = join(
    resolve(env.UC_R2_LOCK_ROOT ?? join(homedir(), 'Documents', 'Codex')),
    '.ultraclipart-publication',
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return awaitAccountWriter({ ...env, UC_R2_LOCK_ROOT: directory }, options);
}
