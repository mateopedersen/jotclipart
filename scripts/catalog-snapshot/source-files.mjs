// Stream only the submitted batch; native paths must remain inside protected work.
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export async function verifySourceFile(f, { sourceRoot = resolve('work') } = {}) {
  const path = resolve(f?.path ?? ''),
    base = realpathSync(sourceRoot) + '/',
    s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    !s.isFile() ||
    !realpathSync(path).startsWith(base) ||
    !Number.isSafeInteger(f.bytes) ||
    f.bytes < 1 ||
    s.size !== f.bytes ||
    !/^[a-f0-9]{64}$/.test(f.sha256 ?? '')
  )
    throw Error('Protected regular source file required');
  const h = createHash('sha256');
  let bytes = 0;
  for await (const b of createReadStream(path)) {
    bytes += b.length;
    h.update(b);
  }
  if (bytes !== f.bytes || h.digest('hex') !== f.sha256) throw Error('Native batch source changed');
  return path;
}
export function verifySourceCapsule(packet) {
  const { sourceCommit, sourceCapsule, ...fields } = packet;
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit ?? '') ||
    !/^data\/catalog-batches\/[a-z0-9][a-z0-9-]*\.json$/.test(sourceCapsule?.path ?? '') ||
    !/^[a-f0-9]{64}$/.test(sourceCapsule?.sha256 ?? '')
  )
    throw Error('Committed reviewed source capsule required');
  const bytes = execFileSync('git', ['show', sourceCommit + ':' + sourceCapsule.path], {
      maxBuffer: 32 * 1024 * 1024,
    }),
    hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== sourceCapsule.sha256) throw Error('Source capsule changed');
  delete fields.revision;
  delete fields.parentSnapshotSHA256;
  const canonical = (x) =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, canonical(x[k])]),
          )
        : x;
  if (JSON.stringify(canonical(JSON.parse(bytes))) !== JSON.stringify(canonical(fields)))
    throw Error('Transport differs from committed source capsule');
  return { sourceCommit, path: sourceCapsule.path, sha256: hash };
}
