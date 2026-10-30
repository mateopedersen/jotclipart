import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifiedSourceCache } from '../scripts/verified-source-cache.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'uc-verified-source-')),
    file = join(root, 'source.webp'),
    bytes = Buffer.from('original pixels');
  writeFileSync(file, bytes);
  return { root, file, bytes, expected: { bytes: bytes.length, sha256: hash(bytes) } };
}

test('only independently hashed bytes create a reusable, private source record', () => {
  const f = setup();
  try {
    const cold = verifiedSourceCache(f.root);
    cold.verify(f.file, f.expected);
    assert.deepEqual(cold.stats, { hashed: 1, reused: 0, hashedBytes: f.bytes.length });
    cold.save();
    const warm = verifiedSourceCache(f.root);
    warm.verify(f.file, f.expected);
    assert.deepEqual(warm.stats, { hashed: 0, reused: 1, hashedBytes: 0 });
    assert.equal(statSync(join(f.root, '.asset-integrity/key')).mode & 0o077, 0);
    assert.equal(statSync(join(f.root, '.asset-integrity/sources.json')).mode & 0o077, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('same-length edits with restored modification times invalidate the change-time identity', () => {
  const f = setup();
  try {
    const before = statSync(f.file),
      cold = verifiedSourceCache(f.root);
    cold.verify(f.file, f.expected);
    cold.save();
    writeFileSync(f.file, Buffer.alloc(f.bytes.length, 1));
    utimesSync(f.file, before.atime, before.mtime);
    assert.throws(() => verifiedSourceCache(f.root).verify(f.file, f.expected), /Source changed/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('replacement, changed expected hashes and corrupted or forged caches cannot approve bytes', () => {
  const f = setup();
  try {
    const cold = verifiedSourceCache(f.root);
    cold.verify(f.file, f.expected);
    cold.save();
    const next = join(f.root, 'replacement');
    writeFileSync(next, Buffer.alloc(f.bytes.length, 2));
    renameSync(next, f.file);
    assert.throws(() => verifiedSourceCache(f.root).verify(f.file, f.expected), /Source changed/);
    const index = join(f.root, '.asset-integrity/sources.json');
    const saved = JSON.parse(readFileSync(index, 'utf8'));
    Object.values(saved.entries).forEach((row) => (row.signature = 'a'.repeat(64)));
    writeFileSync(index, JSON.stringify(saved));
    assert.throws(() => verifiedSourceCache(f.root).verify(f.file, f.expected), /Source changed/);
    writeFileSync(index, '{invalid');
    assert.throws(() => verifiedSourceCache(f.root).verify(f.file, f.expected), /Source changed/);
    writeFileSync(f.file, f.bytes);
    assert.throws(
      () => verifiedSourceCache(f.root).verify(f.file, { ...f.expected, sha256: '0'.repeat(64) }),
      /Source changed/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('removing the private cache or rotating its key requires a fresh hash', () => {
  const f = setup();
  try {
    const cold = verifiedSourceCache(f.root);
    cold.verify(f.file, f.expected);
    cold.save();
    writeFileSync(join(f.root, '.asset-integrity/key'), Buffer.alloc(32));
    const rotated = verifiedSourceCache(f.root);
    rotated.verify(f.file, f.expected);
    assert.equal(rotated.stats.hashed, 1);
    rmSync(join(f.root, '.asset-integrity'), { recursive: true });
    const cleared = verifiedSourceCache(f.root);
    cleared.verify(f.file, f.expected);
    assert.equal(cleared.stats.hashed, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a new appended source is hashed without rereading existing accepted bytes', () => {
  const f = setup();
  try {
    const cold = verifiedSourceCache(f.root);
    cold.verify(f.file, f.expected);
    cold.save();
    const newFile = join(f.root, 'new.pdf'),
      newBytes = Buffer.from('new matching document');
    writeFileSync(newFile, newBytes);
    const next = verifiedSourceCache(f.root);
    next.verify(f.file, f.expected);
    next.verify(newFile, { bytes: newBytes.length, sha256: hash(newBytes) });
    assert.deepEqual(next.stats, { hashed: 1, reused: 1, hashedBytes: newBytes.length });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('private key and index symlinks cannot redirect verification cache writes', () => {
  const f = setup();
  try {
    verifiedSourceCache(f.root);
    const key = join(f.root, '.asset-integrity/key');
    rmSync(key);
    symlinkSync(f.file, key);
    assert.throws(() => verifiedSourceCache(f.root), /private regular file/);
    rmSync(key);
    writeFileSync(key, Buffer.alloc(32), { mode: 0o600 });
    symlinkSync(f.file, join(f.root, '.asset-integrity/sources.json'));
    assert.throws(() => verifiedSourceCache(f.root), /Unsafe source cache index/);
    assert.deepEqual(readFileSync(f.file), f.bytes);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
