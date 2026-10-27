import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// The worker independently checks each source against its Merkle proof, SHA-256
// and readback. Bound the raw files as well as the decompressed request body.
export function encodeLocalBatch(dist, body) {
  if (!Array.isArray(body.records) || !body.records.length || body.records.length > 8)
    throw Error('Local batch requires one to eight records');
  const blobs = Object.create(null);
  let bytes = 0;
  for (const { record } of body.records) {
    if (!record?.path?.startsWith('/') || record.path.includes('..') || blobs[record.path])
      throw Error('Invalid or duplicate local source');
    const data = readFileSync(join(dist, record.path));
    if (data.length !== record.bytes) throw Error('Local source size changed');
    bytes += data.length;
    if (bytes > (body.records.length === 1 ? 8_000_000 : 4_000_000))
      throw Error('Local batch exceeds byte bound');
    blobs[record.path] = data.toString('base64');
  }
  const payload = Buffer.from(JSON.stringify({ ...body, blobs }));
  if (payload.length > 12_000_000) throw Error('Local request exceeds worker bound');
  return gzipSync(payload);
}
