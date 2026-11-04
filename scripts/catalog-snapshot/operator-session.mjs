// Short-lived operator transport. Never a durable route or public admin API.
import { mkdirSync, openSync, writeFileSync, fchmodSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { awaitAccountWriter } from '../delivery/account-lock.mjs';
import { stopPrivateSession } from '../delivery/private-session.mjs';
const modules = {
  benchmark: ['private-benchmark-worker.mjs', 'privateBenchmarkWorker'],
  reader: ['private-read-worker.mjs', 'privateCatalogReader'],
  publisher: ['private-publish-worker.mjs', 'privateSnapshotPublisher'],
  stager: ['../../scripts/delivery/staging-worker.mjs', 'stagingWorker'],
};
export async function withPrivateCatalogSession({ directory, kind, job }, operate) {
  if (
    !modules[kind] ||
    !directory.startsWith(resolve('work') + '/') ||
    typeof operate !== 'function'
  )
    throw Error('Private operator session scope required');
  const release = await awaitAccountWriter(),
    secret = randomBytes(32).toString('hex'),
    [file, exported] = modules[kind],
    entry = join(directory, 'entry.mjs');
  let child,
    output,
    stopped = false;
  try {
    mkdirSync(directory, { recursive: true });
    const fd = openSync(entry, 'w', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(
        fd,
        `import{${exported}}from${JSON.stringify(resolve('server/catalog-snapshot', file))};export default ${exported}(${JSON.stringify({ ...job, secret })});`,
      );
    } finally {
      closeSync(fd);
    }
    writeFileSync(
      join(directory, 'wrangler.json'),
      JSON.stringify({
        name: 'ultraclipart-private-content-' + kind,
        main: 'entry.mjs',
        account_id: job.verifier.accountId,
        compatibility_date: '2026-10-23',
        r2_buckets: [
          {
            binding: 'TARGET',
            bucket_name: job.verifier.bucketName,
            preview_bucket_name: job.verifier.bucketName,
          },
        ],
      }),
    );
    output = openSync(join(directory, 'session.log'), 'a', 0o600);
    fchmodSync(output, 0o600);
    child = spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--remote',
        '--ip',
        '127.0.0.1',
        '--port',
        '8899',
        '--config',
        join(directory, 'wrangler.json'),
        '--show-interactive-dev-session=false',
      ],
      {
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
        stdio: ['ignore', output, output],
      },
    );
    let error;
    child.on('error', (e) => (error = e));
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (error || child.exitCode !== null) throw Error('Private content session exited');
      try {
        const r = await fetch('http://127.0.0.1:8899/health', {
            signal: AbortSignal.timeout(2000),
          }),
          h = await r.json();
        if (
          ['stager', 'benchmark'].includes(kind)
            ? h.root === job.root
            : h.parentSnapshotSHA256 === job.parentSnapshotSHA256 &&
              (!job.snapshotSHA256 || h.snapshotSHA256 === job.snapshotSHA256)
        ) {
          ready = true;
          break;
        }
      } catch {}
      await wait(1000);
    }
    if (!ready) throw Error('Private content session unavailable');
    return await operate({ secret });
  } finally {
    try {
      await stopPrivateSession(child);
      stopped = true;
    } finally {
      if (output !== undefined) closeSync(output);
      if (stopped) {
        try {
          unlinkSync(entry);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        release();
      }
    }
  }
}
