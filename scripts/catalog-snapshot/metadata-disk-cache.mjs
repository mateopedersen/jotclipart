// Optional bounded cache of verified immutable JSON bytes, never active.json.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const keyOK =
  /^catalog\/objects\/(artworks|collections|search|recent|related|counts|sitemaps)\/([a-f0-9]{64})\.json$/;
export function metadataDiskCache({
  directory,
  accountId,
  bucketName,
  maxBytes = 64 * 1024 * 1024,
  maxObjects = 4096,
}) {
  directory = resolve(directory);
  if (
    !directory.startsWith(resolve('work') + '/') ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    !/^[a-z0-9-]+$/.test(bucketName) ||
    maxBytes > 64 * 1024 * 1024 ||
    maxObjects > 4096
  )
    throw Error('Bounded private metadata cache required');
  mkdirSync(directory, { recursive: true });
  const indexPath = join(directory, 'index.json'),
    rows = new Map();
  let bytes = 0;
  if (existsSync(indexPath)) {
    const old = JSON.parse(readFileSync(indexPath));
    if (old.accountId !== accountId || old.bucketName !== bucketName)
      throw Error('Metadata cache account scope differs');
    for (const r of old.rows ?? []) {
      if (!keyOK.test(r.key) || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || r.bytes > 1048576)
        throw Error('Invalid cached metadata index');
      rows.set(r.key, r);
      bytes += r.bytes;
    }
  }
  const file = (key) => join(directory, key.replaceAll('/', '_'));
  function drop(key) {
    const row = rows.get(key);
    if (row) {
      rows.delete(key);
      bytes -= row.bytes;
      try {
        unlinkSync(file(key));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  return {
    get(key) {
      if (!keyOK.test(key) || !rows.has(key)) return null;
      const row = rows.get(key);
      let b;
      try {
        b = readFileSync(file(key));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        drop(key);
        return null;
      }
      if (
        b.length !== row.bytes ||
        createHash('sha256').update(b).digest('hex') !== keyOK.exec(key)[2]
      ) {
        drop(key);
        return null;
      }
      rows.delete(key);
      rows.set(key, row);
      return b;
    },
    put(key, b) {
      if (
        !keyOK.test(key) ||
        !b.length ||
        b.length > 1048576 ||
        createHash('sha256').update(b).digest('hex') !== keyOK.exec(key)[2]
      )
        throw Error('Invalid immutable cache insertion');
      if (rows.has(key)) return;
      while (rows.size >= maxObjects || bytes + b.length > maxBytes) drop(rows.keys().next().value);
      const temp = file(key) + '.' + randomBytes(8).toString('hex') + '.tmp';
      writeFileSync(temp, b, { flag: 'wx', mode: 0o600 });
      renameSync(temp, file(key));
      rows.set(key, { key, bytes: b.length });
      bytes += b.length;
    },
    close() {
      writeFileSync(
        indexPath,
        JSON.stringify({ schema: 1, accountId, bucketName, rows: [...rows.values()] }),
      );
    },
    metrics: () => ({ objects: rows.size, bytes, maxBytes, maxObjects }),
  };
}
