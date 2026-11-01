import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/r2/ingest.mjs', import.meta.url));

test('legacy uploader fails before reading sources or running either transport', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ultraclipart-legacy-ingest-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const marker = join(dir, 'aws-was-run');
    const journal = join(dir, 'r2-ingest-journal.json');
    const original = '{"status":"keep-existing-proof"}\n';
    writeFileSync(journal, original);
    writeFileSync(join(bin, 'aws'), '#!/bin/sh\n: > "$FAKE_AWS_MARKER"\n', { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
      CLOUDFLARE_API_TOKEN: 'private-test-token-never-print',
      FAKE_AWS_MARKER: marker,
      UC_R2_LOCK_ROOT: dir,
      UC_INGEST_JOURNAL: journal,
    };
    for (const flags of [
      ['missing.json'],
      ['missing.json', '--apply'],
      ['missing.json', '--apply', '--transport', 'cloudflare-api'],
      ['missing.json', '--apply', '--inventory', 'missing.json'],
      ['missing.json', '--apply', '--max-account-bytes', '1'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /legacy S3\/REST uploader is disabled/i);
      assert.match(result.stderr, /scripts\/r2\/binding-ingest\.mjs/);
      assert.doesNotMatch(result.stderr + result.stdout, /private-test-token-never-print/);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(dir, '.r2-ingest.lock')), false);
      assert.equal(readFileSync(journal, 'utf8'), original);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy uploader help identifies the reviewed replacement without side effects', () => {
  const result = spawnSync(process.execPath, [script, '--help'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /scripts\/r2\/binding-ingest\.mjs/);
  assert.equal(result.stderr, '');
});
