import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectDeliveryFiles,
  deliveryKey,
  merkle,
  verifyDeliveryManifest,
  pruneDeliveryFiles,
} from '../scripts/delivery/manifest.mjs';
const revision = 'a'.repeat(40);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uc-delivery-'));
  for (const path of [
    'art/item/index.html',
    'edit/item/index.html',
    'previews/p1/' + 'b'.repeat(24) + '-440.webp',
    '_astro/a.123.js',
  ]) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(
      join(dir, path),
      path.endsWith('.html') ? `<meta name="build-revision" content="${revision}">` : path,
    );
  }
  const files = collectDeliveryFiles(dir, revision),
    manifest = {
      schema: 1,
      status: 'remote-byte-verified',
      revision,
      bucket: 'ultraclipart-pages',
      root: merkle(files).root,
      verified: files.length,
      files,
    };
  return { dir, manifest };
}
test('a verified complete release is pruned only after every file passes', () => {
  const { dir, manifest } = fixture();
  try {
    assert.equal(verifyDeliveryManifest(dir, manifest, revision).length, 4);
    assert.equal(pruneDeliveryFiles(dir, manifest, revision), 4);
    assert(!existsSync(join(dir, 'art/item/index.html')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('a changed, missing or foreign file blocks the whole prune atomically', () => {
  for (const kind of ['changed', 'missing', 'revision', 'receipt']) {
    const { dir, manifest } = fixture();
    try {
      if (kind === 'changed') writeFileSync(join(dir, '_astro/a.123.js'), 'changed');
      if (kind === 'missing') rmSync(join(dir, '_astro/a.123.js'));
      if (kind === 'revision') manifest.revision = 'c'.repeat(40);
      if (kind === 'receipt') manifest.verified = 3;
      assert.throws(() => pruneDeliveryFiles(dir, manifest, revision));
      assert(existsSync(join(dir, 'art/item/index.html')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test('path traversal, unknown types, symlinks and mixed HTML revisions fail closed', () => {
  assert.throws(() => deliveryKey('/art/../../secret', revision));
  assert.throws(() => deliveryKey('/api/ai/run', revision));
  const { dir } = fixture();
  try {
    writeFileSync(join(dir, 'art/item/index.html'), '<meta name="build-revision" content="wrong">');
    assert.throws(() => collectDeliveryFiles(dir, revision), /Mixed HTML/);
    symlinkSync('/etc/hosts', join(dir, '_astro/b.js'));
    assert.throws(() => collectDeliveryFiles(dir, revision));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
