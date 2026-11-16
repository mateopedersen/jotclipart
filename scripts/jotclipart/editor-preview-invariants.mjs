import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { checkEditorPreviewIndex } from './editor-preview-index.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Bind the compiled reader, public metadata and preserved source to one exact index. */
export function verifyEditorPreviewBuild({ root = process.cwd(), buildDirectory }) {
  root = realpathSync(root);
  const build = realpathSync(resolve(root, buildDirectory));
  assert(build.startsWith(root + sep), 'Editor preview build escaped the new repository');
  const read = (file, expected) => {
    const stat = lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Preview input must be a normal file');
    assert(realpathSync(file).startsWith(root + sep), 'Preview input escaped the new repository');
    const bytes = readFileSync(file);
    if (expected) {
      assert.equal(bytes.length, expected.bytes);
      assert.equal(sha(bytes), expected.sha256);
    }
    return bytes;
  };
  const checked = checkEditorPreviewIndex({ root, buildRoot: build });
  const reportFile = join(build, 'editor-previews/report.json');
  const reportBytes = read(reportFile);
  const report = JSON.parse(reportBytes);
  const code = JSON.parse(read(join(build, 'runtime/software-report.json')));
  const pack = JSON.parse(read(join(build, 'package-report.json')));
  for (const value of [report, code.editorPreviewIndex, pack.editorPreviewIndex]) {
    assert.equal(value?.rootSHA256, checked.rootSHA256);
    assert.equal(value?.records, checked.records);
  }
  assert.deepEqual(report.sourceInputs, checked.sourceInputs);
  assert.equal(report.originalBodiesCopied, 0);
  assert.equal(report.previewBodiesCopied, 0);
  assert.equal(report.r2Writes, 0);
  assert.equal(pack.editorPreviewIndex.originalsCopied, 0);
  assert.equal(pack.editorPreviewIndex.previewBodiesCopied, 0);
  assert.equal(pack.editorPreviewIndex.shards, 256);
  assert.equal(code.sourceInputs[reportFile], sha(reportBytes), 'Compiled ABI lost preview report');
  for (const [file, digest] of Object.entries(checked.sourceInputs)) {
    assert.equal(sha(read(resolve(root, file))), digest);
    assert.equal(code.sourceInputs[file], digest, 'Compiled ABI lost preview source');
  }
  assert.equal(report.outputs.length, 256);
  assert.deepEqual(code.editorPreviewIndex.outputs, report.outputs);
  const expectedPaths = Object.keys(checked.config.shards).map(
    (prefix) => `/__editor-preview-index/${checked.rootSHA256}/${prefix}.json`,
  );
  assert.deepEqual(report.outputs.map((entry) => entry.path).sort(), expectedPaths.sort());
  const inventory = pack.inventory.filter((entry) =>
    entry.path.startsWith('__editor-preview-index/'),
  );
  assert.equal(inventory.length, 256, 'Packaged preview metadata is incomplete');
  for (const entry of report.outputs) {
    const prefix = entry.path.split('/').at(-1).slice(0, 2);
    const pin = checked.config.shards[prefix];
    assert.equal(entry.file, join(build, 'editor-previews/public', entry.path));
    assert.equal(entry.bytes, pin.bytes);
    assert.equal(entry.sha256, pin.sha256);
    read(entry.file, entry);
    const packed = inventory.find((item) => '/' + item.path === entry.path);
    assert(packed, 'Preview shard absent from deployed package');
    assert.equal(packed.bytes, entry.bytes);
    assert.equal(packed.sha256, entry.sha256);
    read(join(root, 'dist', packed.path), packed);
  }
  assert(
    !pack.inventory.some((entry) => /^previews\/p1\//.test(entry.path)),
    'Existing preview bodies must remain in the single shared R2 archive',
  );
  return {
    status: 'EDITOR_PREVIEW_SOURCE_ABI_AND_DEPLOYED_METADATA_VERIFIED',
    rootSHA256: checked.rootSHA256,
    records: checked.records,
    shards: report.outputs.length,
    sourceFiles: Object.keys(checked.sourceInputs).length,
    existingR2Prefix: 'delivery/previews/p1/',
    originalBodiesCopied: 0,
    previewBodiesCopied: 0,
    r2Writes: 0,
  };
}
