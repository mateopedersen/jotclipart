import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertOriginalImageDelivery } from '../scripts/delivery/original-image-gate.mjs';
test('a public preview rollback is rejected while actual originals and noindex tools are preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-original-gate-'));
  try {
    writeFileSync(
      join(dir, 'public.html'),
      '<img alt="sizes and srcset words remain valid" src="https://assets.ultraclipart.com/original.webp">',
    );
    writeFileSync(
      join(dir, 'editor.html'),
      '<meta name="robots" content="noindex,follow"><img src="/previews/p1/tool.webp">',
    );
    assert.equal(assertOriginalImageDelivery(dir), 1);
    writeFileSync(
      join(dir, 'public.html'),
      '<img src="https://assets.ultraclipart.com/original.webp" srcset="/previews/p1/small.webp 440w">',
    );
    assert.throws(() => assertOriginalImageDelivery(dir), /small catalog preview/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
