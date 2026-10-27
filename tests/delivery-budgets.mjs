import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertReleaseBudgets,
  PAGES_MAX_FILE_BYTES,
  WORKER_MAX_BYTES,
} from '../scripts/delivery/budgets.mjs';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uc-budget-'));
  writeFileSync(join(dir, '_routes.json'), JSON.stringify({ include: ['/*'], exclude: [] }));
  writeFileSync(join(dir, '_worker.js'), 'export default {}');
  return dir;
}
test('real deployment budgets separate control files, per-file size and Worker size', () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'index.html'), 'page');
    assert.equal(assertReleaseBudgets(dir).pagesFiles, 1);
    writeFileSync(join(dir, 'large.json'), '');
    truncateSync(join(dir, 'large.json'), PAGES_MAX_FILE_BYTES + 1);
    assert.throws(() => assertReleaseBudgets(dir), /25 MiB/);
    rmSync(join(dir, 'large.json'));
    truncateSync(join(dir, '_worker.js'), WORKER_MAX_BYTES + 1);
    assert.throws(() => assertReleaseBudgets(dir), /64 MiB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Studio growth fails before the provider hard file limit', () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'studio-catalog.json'), '');
    truncateSync(join(dir, 'studio-catalog.json'), 20 * 1024 * 1024 + 1);
    assert.throws(() => assertReleaseBudgets(dir), /shard metadata/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
