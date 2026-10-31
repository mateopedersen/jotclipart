import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Keep the public legacy URL working without publishing a large Pages asset.
 * Chunks are exact byte ranges, so UTF-8 boundaries, order, metadata and hashes
 * are preserved. The checked full source is never edited. */
export function shardStudioCatalog(target, expectedIds, {
  triggerBytes = 20 * 1024 * 1024,
  partBytes = 8 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(triggerBytes) || triggerBytes < 1 ||
      !Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > 8 * 1024 * 1024)
    throw Error('Invalid Studio shard size');
  const file = join(target, 'studio-catalog.json');
  if (!existsSync(file)) throw Error('Studio catalog is required');
  const bytes = readFileSync(file);
  if (bytes.length <= triggerBytes) return null;
  const catalog = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(catalog) || !Array.isArray(expectedIds))
    throw Error('Invalid Studio catalog');
  const ids = catalog.map((entry) => entry?.id).sort();
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length ||
      JSON.stringify(ids) !== JSON.stringify([...expectedIds].sort()))
    throw Error('Studio catalog does not match the reviewed raster catalog');
  const sha256 = hash(bytes), folder = join(target, 'studio-catalog-parts', sha256);
  if (existsSync(folder)) throw Error('Studio shard destination already exists');
  mkdirSync(folder, { recursive: true });
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += partBytes) {
    const chunk = bytes.subarray(offset, Math.min(offset + partBytes, bytes.length));
    const name = `${String(parts.length).padStart(5, '0')}.bin`;
    const path = `/studio-catalog-parts/${sha256}/${name}`;
    const destination = join(folder, name);
    writeFileSync(destination, chunk, { flag: 'wx' });
    if (hash(readFileSync(destination)) !== hash(chunk)) throw Error('Studio shard verification failed');
    parts.push({ path, bytes: chunk.length, sha256: hash(chunk) });
  }
  const restored = Buffer.concat(parts.map((part) => readFileSync(join(target, part.path))));
  if (!restored.equals(bytes) || hash(restored) !== sha256)
    throw Error('Studio shard reconstruction failed');
  rmSync(file);
  return { sha256, bytes: bytes.length, parts };
}
