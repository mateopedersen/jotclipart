import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  statSync,
  realpathSync,
  copyFileSync,
  constants,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (file) => {
  const s = statSync(file, { bigint: true });
  if (!s.isFile()) throw Error('Verified source must be a regular file');
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
};

/** An authenticated local optimization, never an R2 receipt or an editorial
 * approval. Only bytes hashed by this verifier may create a cache entry. A file
 * replacement or write invalidates its inode/nanosecond change-time identity. */
function privateStateKey(root) {
  const directory = join(realpathSync(resolve(root)), '.asset-integrity');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory)
    throw Error('Source verification cache cannot be a symlink');
  const keyFile = join(directory, 'key');
  try {
    writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (
    !lstatSync(keyFile).isFile() ||
    lstatSync(keyFile).isSymbolicLink() ||
    (lstatSync(keyFile).mode & 0o077) !== 0
  )
    throw Error('Source verification key requires a private regular file');
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw Error('Invalid local source verification key');
  return { key, directory };
}

export function authenticateLocalState(root, payload) {
  const { key } = privateStateKey(root);
  return createHmac('sha256', key).update(payload).digest('hex');
}

export function verifyLocalState(root, payload, signature) {
  return (
    /^[a-f0-9]{64}$/.test(signature ?? '') &&
    timingSafeEqual(
      Buffer.from(authenticateLocalState(root, payload), 'hex'),
      Buffer.from(signature, 'hex'),
    )
  );
}

export function verifiedSourceCache(root) {
  const { key, directory } = privateStateKey(root),
    indexFile = join(directory, 'sources.json');
  let previous = {};
  try {
    if (lstatSync(indexFile).isSymbolicLink()) throw Error('Unsafe source cache index');
    const parsed = JSON.parse(readFileSync(indexFile, 'utf8'));
    if (parsed.schema === 1 && parsed.entries && typeof parsed.entries === 'object')
      previous = parsed.entries;
  } catch (error) {
    if (error.message === 'Unsafe source cache index') throw error;
    // Missing/corrupt caches are performance misses, never integrity approvals.
  }
  const entries = Object.create(null),
    stats = { hashed: 0, reused: 0, hashedBytes: 0 };
  const sign = (record) => createHmac('sha256', key).update(JSON.stringify(record)).digest('hex');
  function verify(file, expected) {
    const path = realpathSync(file),
      before = identity(path);
    const record = { path, sha256: expected.sha256, bytes: expected.bytes, identity: before };
    const signature = sign(record),
      saved = previous[path];
    if (
      saved &&
      typeof saved.signature === 'string' &&
      /^[a-f0-9]{64}$/.test(saved.signature) &&
      timingSafeEqual(Buffer.from(saved.signature, 'hex'), Buffer.from(signature, 'hex'))
    ) {
      entries[path] = { signature };
      stats.reused++;
      return;
    }
    const bytes = readFileSync(path);
    if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256)
      throw Error(`Source changed after verification: ${file}`);
    if (identity(path) !== before) throw Error(`Source changed during verification: ${file}`);
    entries[path] = { signature };
    stats.hashed++;
    stats.hashedBytes += bytes.length;
  }
  return {
    verify,
    stats,
    copy(source, target, expected) {
      verify(source, expected);
      const before = identity(source);
      if (existsSync(target)) throw Error('Verified inheritance cannot replace a rendered file');
      copyFileSync(source, target, constants.COPYFILE_FICLONE);
      if (identity(source) !== before || statSync(target).size !== expected.bytes)
        throw Error('Source changed during verified inheritance');
      const record = {
        path: realpathSync(target),
        sha256: expected.sha256,
        bytes: expected.bytes,
        identity: identity(target),
      };
      entries[record.path] = { signature: sign(record) };
    },
    save() {
      // Preserve unrelated accepted entries; replacing any source invalidates its
      // identity regardless of a retained record. A failed run never calls save.
      const output = Object.assign(Object.create(null), previous, entries);
      const temporary = `${indexFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temporary, JSON.stringify({ schema: 1, entries: output }), {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, indexFile);
    },
  };
}
