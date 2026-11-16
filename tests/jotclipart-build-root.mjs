import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRoot } from '../scripts/jotclipart/build-root.mjs';

test('selected build output is deterministic and rejects escapes, aliases and unsafe paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jotclipart-build-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(buildRoot('work/jotclipart-build', root), 'work/jotclipart-build');
  assert.equal(buildRoot('work/jotclipart-release-abcdef', root), 'work/jotclipart-release-abcdef');
  for (const input of [
    '',
    'work',
    '/tmp/out',
    'work/../dist',
    'work//x',
    'work/./x',
    '../work/x',
    'work/x/',
    'work/.private',
    'work/a\nb',
  ])
    assert.throws(() => buildRoot(input, root));
  mkdirSync(join(root, 'work'));
  writeFileSync(join(root, 'work/file'), 'not a directory');
  assert.throws(() => buildRoot('work/file/nested', root), /non-directory/);
  symlinkSync(tmpdir(), join(root, 'work/link'));
  assert.throws(() => buildRoot('work/link/nested', root), /symlink/);
});
