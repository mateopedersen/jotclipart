import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  compileEditorPreviewRows,
  canonicalEditorPreviewJSON,
  checkEditorPreviewIndex,
  buildEditorPreviewIndex,
  EDITOR_PREVIEW_SOURCE,
  EDITOR_PREVIEW_CONFIG,
} from '../scripts/jotclipart/editor-preview-index.mjs';

const script = 'scripts/jotclipart/editor-preview-index.mjs';
const actualRoot = process.cwd(),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const row = {
  id: 'private-fixture-one',
  sourceSHA256: 'a'.repeat(64),
  path: '/previews/p1/' + 'b'.repeat(24) + '-960.webp',
  sha256: 'c'.repeat(64),
  bytes: 200,
  width: 960,
  height: 640,
};
function fixture(run) {
  mkdirSync('work', { recursive: true });
  const root = mkdtempSync(resolve('work/jot-editor-index-test-'));
  for (const path of [script, EDITOR_PREVIEW_SOURCE, EDITOR_PREVIEW_CONFIG]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(path, join(root, path));
  }
  const config = () => JSON.parse(readFileSync(join(root, EDITOR_PREVIEW_CONFIG)));
  const save = (value) => writeFileSync(join(root, EDITOR_PREVIEW_CONFIG), JSON.stringify(value));
  try {
    return run({ root, config, save });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('full reviewed35709-source build emits256 exact bounded metadata shards and copies no image bodies', () =>
  fixture(({ root }) => {
    const buildRoot = join(root, 'work/build'),
      result = buildEditorPreviewIndex({ root, buildRoot });
    assert.equal(result.records, 35709);
    assert.equal(result.outputs.length, 256);
    assert.equal(result.originalBodiesCopied, 0);
    assert.equal(result.previewBodiesCopied, 0);
    assert.equal(result.r2Writes, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(join(buildRoot, 'editor-previews/report.json'))),
      result,
    );
    assert.deepEqual(
      Object.keys(result.sourceInputs).sort(),
      [EDITOR_PREVIEW_SOURCE, EDITOR_PREVIEW_CONFIG, script].sort(),
    );
    const ids = new Set(),
      paths = new Set();
    let count = 0,
      bytes = 0,
      max = 0;
    for (const output of result.outputs) {
      assert(output.path.startsWith('/__editor-preview-index/' + result.rootSHA256 + '/'));
      assert(output.path.endsWith('.json') && output.bytes <= 128 * 1024);
      const body = readFileSync(output.file),
        data = JSON.parse(body);
      assert.equal(body.length, output.bytes);
      assert.equal(sha(body), output.sha256);
      assert.equal(body.toString(), canonicalEditorPreviewJSON(data));
      assert.deepEqual(Object.keys(data).sort(), ['files', 'schema']);
      assert.equal(data.schema, 1);
      for (const record of data.files) {
        assert(!ids.has(record.id) && !paths.has(record.path));
        ids.add(record.id);
        paths.add(record.path);
        assert.deepEqual(Object.keys(record).sort(), [
          'bytes',
          'height',
          'id',
          'path',
          'sha256',
          'sourceSHA256',
          'width',
        ]);
        count++;
        bytes += record.bytes;
        max = Math.max(max, record.bytes);
      }
    }
    assert.equal(count, 35709);
    assert.equal(bytes, 4334635064);
    assert.equal(max, 528444);
    const checked = checkEditorPreviewIndex({ root, buildRoot });
    assert.equal(checked.generatedShardsVerified, true);
    assert.equal(
      checked.rows.find((r) => r.id === 'classic-white-volleyball-realistic-clipart').bytes,
      54756,
    );
    assert.equal(checked.rows.find((r) => r.id === 'brocade-crown-firework-clipart').bytes, 528444);
  }));
test('canonical grouping is deterministic regardless of input object order and cannot combine duplicate identities', () => {
  const other = {
    ...row,
    id: 'private-fixture-two',
    path: '/previews/p1/' + 'd'.repeat(24) + '-960.webp',
  };
  const first = compileEditorPreviewRows([row, other]),
    second = compileEditorPreviewRows([
      Object.fromEntries(Object.entries(other).reverse()),
      Object.fromEntries(Object.entries(row).reverse()),
    ]);
  assert.deepEqual(first.shards, second.shards);
  for (const [prefix, body] of first.bodies) assert.deepEqual(body, second.bodies.get(prefix));
  assert.throws(() => compileEditorPreviewRows([row, { ...other, id: row.id }]), /Duplicate/);
  assert.throws(() => compileEditorPreviewRows([row, { ...other, path: row.path }]), /Duplicate/);
});
test('unknown fields, foreign/nonWebP paths, bad source SHA, IDs, byte and pixel bounds fail closed', () => {
  for (const changed of [
    { ...row, mime: 'image/webp' },
    { ...row, schema: 1 },
    { ...row, id: '../private-secret' },
    { ...row, sourceSHA256: 'unverified' },
    { ...row, sha256: '0'.repeat(63) },
    { ...row, path: 'https://ultraclipart.com' + row.path },
    { ...row, path: row.path.replace('.webp', '.pdf') },
    { ...row, path: row.path + '?source=old' },
    { ...row, bytes: 0 },
    { ...row, bytes: 1024 * 1024 + 1 },
    { ...row, width: 961 },
    { ...row, height: 0 },
  ])
    assert.throws(() => compileEditorPreviewRows([changed]));
});
test('a deliberately concentrated prefix cannot produce an unbounded shard', () => {
  const rows = Array.from({ length: 900 }, (_, i) => ({
    ...row,
    id: 'private-fixture-' + i,
    path: '/previews/p1/00' + i.toString(16).padStart(22, '0') + '-960.webp',
  }));
  assert.throws(() => compileEditorPreviewRows(rows), /128KiB/);
});
test('compressed source bytes and deterministic gzip headers are pinned', () =>
  fixture(({ root, config, save }) => {
    const path = join(root, EDITOR_PREVIEW_SOURCE),
      original = readFileSync(path),
      broken = Buffer.from(original);
    broken[broken.length - 1] ^= 1;
    writeFileSync(path, broken);
    assert.throws(() => checkEditorPreviewIndex({ root }), /compressed source pin/);
    const raw = gunzipSync(original),
      repeated = gzipSync(raw, { level: 9 });
    repeated[9] = 255;
    assert.deepEqual(repeated, original);
    const withTime = Buffer.from(original);
    withTime[4] = 1;
    const c = config();
    c.source.sha256 = sha(withTime);
    save(c);
    writeFileSync(path, withTime);
    assert.throws(() => checkEditorPreviewIndex({ root }), /deterministic/);
  }));
test('schema, provenance, whole-source counts and path overrides cannot be weakened through config edits', () =>
  fixture(({ root, config, save }) => {
    const original = config();
    for (const change of [
      { ...original, schema: 2 },
      { ...original, records: 35708 },
      { ...original, totalPreviewBytes: original.totalPreviewBytes - 1 },
      { ...original, maxPreviewBytes: 1 },
      { ...original, source: { ...original.source, catalogRoot: '0'.repeat(64) } },
      { ...original, source: { ...original.source, manifestRoot: '0'.repeat(64) } },
      { ...original, source: { ...original.source, file: '../../.wrangler/config/default.toml' } },
    ]) {
      save(change);
      assert.throws(() => checkEditorPreviewIndex({ root }));
    }
  }));
test('shard hash/length/count and Merkle-directory root pins are rederived rather than trusted', () =>
  fixture(({ root, config, save }) => {
    const original = config();
    for (const field of ['sha256', 'bytes', 'records']) {
      const changed = structuredClone(original);
      changed.shards['00'][field] =
        field === 'sha256' ? '0'.repeat(64) : changed.shards['00'][field] + 1;
      save(changed);
      assert.throws(() => checkEditorPreviewIndex({ root }), /shard pin/);
    }
    save({ ...original, rootSHA256: '0'.repeat(64) });
    assert.throws(() => checkEditorPreviewIndex({ root }), /index root/);
  }));
test('changing a generated public shard is detected without touching or restoring original artwork', () =>
  fixture(({ root }) => {
    const buildRoot = join(root, 'work/build'),
      result = buildEditorPreviewIndex({ root, buildRoot });
    const file = result.outputs[0].file,
      changed = readFileSync(file);
    changed[changed.length - 1] ^= 1;
    writeFileSync(file, changed);
    assert.throws(
      () => checkEditorPreviewIndex({ root, buildRoot }),
      /Generated preview shard pin/,
    );
    assert.equal(
      sha(readFileSync(join(root, EDITOR_PREVIEW_SOURCE))),
      result.sourceInputs[EDITOR_PREVIEW_SOURCE],
    );
  }));
test('repo input symlinks cannot make a clean build depend on an old checkout or private path', () =>
  fixture(({ root }) => {
    const file = join(root, EDITOR_PREVIEW_SOURCE);
    unlinkSync(file);
    symlinkSync(join(actualRoot, EDITOR_PREVIEW_SOURCE), file);
    assert.throws(() => checkEditorPreviewIndex({ root }), /symlink/);
  }));
