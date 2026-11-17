import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installedSourceRoot,
  installedSourcePath,
} from '../scripts/catalog-snapshot/installed-source-paths.mjs';
test('installed relative dependencies resolve in their own checkout from a different caller', () => {
  const root = mkdtempSync(join(tmpdir(), 'jot-installed-source-'));
  try {
    const release = join(root, 'work', 'exact-release');
    mkdirSync(join(release, 'art-ssr', 'compiled'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(release, 'art-ssr', 'compiled', 'renderer.mjs'), 'pinned compiled source');
    writeFileSync(join(root, 'src', 'input.mjs'), 'pinned source');
    assert.equal(installedSourceRoot(release), realpathSync(root));
    assert.equal(
      readFileSync(
        installedSourcePath(release, 'work/exact-release/art-ssr/compiled/renderer.mjs'),
        'utf8',
      ),
      'pinned compiled source',
    );
    assert.equal(
      readFileSync(installedSourcePath(release, 'src/input.mjs'), 'utf8'),
      'pinned source',
    );
    const absolute = join(root, 'src', 'input.mjs');
    assert.equal(installedSourcePath(release, absolute), absolute);
    assert.throws(
      () => installedSourcePath(release, '../foreign.mjs'),
      /Canonical installed source/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
