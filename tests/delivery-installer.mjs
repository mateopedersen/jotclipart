import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { publicationSoftwareHash, incrementalInstalled } from '../scripts/delivery/installer.mjs';
import { awaitPublicationWriter } from '../scripts/delivery/publication-lock.mjs';
import { acquireAccountWriter } from '../scripts/delivery/account-lock.mjs';

test('missing, disabled, failed and stale installation proof always retains the full publisher', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-installer-'));
  const put = (path, text) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  try {
    assert.equal(incrementalInstalled(root), false);
    const paths = [
      'scripts/deploy.mjs',
      'scripts/verified-source-cache.mjs',
      'scripts/publication-policy.mjs',
      'scripts/restore-assets.mjs',
      'scripts/production-public-assets.mjs',
      'scripts/seo/indexnow-release.mjs',
      'scripts/performance/serve.mjs',
      'src/lib/delivery-build-scope.ts',
      'src/pages/art/[id].astro',
      'src/pages/edit/[id].astro',
      'astro.config.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'scripts/delivery/installer.mjs',
      'server/delivery/public-files.mjs',
    ];
    for (const path of paths) put(path, 'fixed software fixture');
    const certificate = {
      schema: 1,
      enabled: true,
      softwareHash: publicationSoftwareHash(root),
      checks: {
        unitFailed: 0,
        unitPassed: 1,
        shadowBuildVerified: true,
        relatedNativeVerified: true,
      },
    };
    put('config/incremental-publisher.json', JSON.stringify(certificate));
    assert.equal(incrementalInstalled(root), true);
    put('scripts/deploy.mjs', 'modified software');
    assert.equal(incrementalInstalled(root), false);
    put('scripts/deploy.mjs', 'fixed software fixture');
    put('config/incremental-publisher.json', JSON.stringify({ ...certificate, enabled: false }));
    assert.equal(incrementalInstalled(root), false);
    put(
      'config/incremental-publisher.json',
      JSON.stringify({
        ...certificate,
        checks: { ...certificate.checks, relatedNativeVerified: false },
      }),
    );
    assert.equal(incrementalInstalled(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whole-publication serialization does not deadlock the child R2 writer or remove another publisher lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uc-publisher-lock-')),
    env = { UC_R2_LOCK_ROOT: directory };
  let first, r2;
  try {
    first = await awaitPublicationWriter(env);
    r2 = acquireAccountWriter(env);
    const publicationLock = join(
      directory,
      '.ultraclipart-publication/.ultraclipart-r2-writer.lock',
    );
    const before = readFileSync(publicationLock, 'utf8');
    await assert.rejects(awaitPublicationWriter(env, { timeoutMs: 10, pollMs: 1 }), /preserved/);
    assert.equal(readFileSync(publicationLock, 'utf8'), before);
    r2();
    r2 = null;
    first();
    first = null;
    const next = await awaitPublicationWriter(env, { timeoutMs: 100, pollMs: 1 });
    next();
    assert.equal(existsSync(publicationLock), false);
  } finally {
    r2?.();
    first?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
