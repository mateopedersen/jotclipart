import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentBranch } from '../scripts/jotclipart/deployment-branch.mjs';

test('normal production and shared preview destinations remain unchanged', () => {
  assert.equal(deploymentBranch('production'), 'main');
  assert.equal(deploymentBranch('preview'), 'migration-preview');
});
test('an isolated preview has its own bounded Pages label', () => {
  assert.equal(deploymentBranch('preview', 'ci-native-20261117-f978'), 'ci-native-20261117-f978');
});
test('an isolated preview option never changes a production destination', () => {
  assert.throws(() => deploymentBranch('production', 'ci-safe-name'), /only for preview/);
});
test('reserved aliases, hosts, paths and shell-like labels cannot be preview destinations', () => {
  for (const value of [
    'main',
    'migration-preview',
    'preview',
    '',
    'ci-',
    'ci-A',
    'ci-a/b',
    'ci-a.b',
    'ci-a:443',
    'ci-a b',
    'ci-a\n',
    'ci-$(id)',
    'ci-a;id',
    'ci-ā',
    'ci-' + 'a'.repeat(46),
    null,
    1,
  ])
    assert.throws(() => deploymentBranch('preview', value));
});
test('an unknown environment never falls through to either deployment destination', () => {
  for (const value of [undefined, null, '', 'prod', 'staging'])
    assert.throws(() => deploymentBranch(value), /explicitly/);
});
