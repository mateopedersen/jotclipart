import { readFileSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { merkle } from './manifest.mjs';

// This reuses byte-verification evidence, not an editorial review. Source SHA,
// key, size, MIME and prior Merkle root must all agree. The Worker still checks
// the current R2 object validator directly, bypassing public/CDN caches.
export async function verifiedReuse(root, currentRecords, productionRecord) {
  const empty = { count: 0, attach: (row) => row };
  let production, manifest;
  try {
    production =
      productionRecord ??
      JSON.parse(
        readFileSync(
          resolve(root, '../ultraclipart/work/remaining-cloudflare-production-report.json'),
          'utf8',
        ),
      );
    const revision = production.liveDelivery?.renderedRevision;
    if (!/^[a-f0-9]{40}$/.test(revision ?? '')) return empty;
    const directory = join(root, 'work/delivery', revision);
    manifest = JSON.parse(readFileSync(join(directory, 'verified-manifest.json'), 'utf8'));
    if (
      manifest.status !== 'remote-byte-verified' ||
      manifest.revision !== revision ||
      manifest.bucket !== 'ultraclipart-pages' ||
      !Array.isArray(manifest.files) ||
      manifest.verified !== manifest.files.length ||
      manifest.root !== production.liveDelivery.verifiedRoot ||
      merkle(manifest.files).root !== manifest.root
    )
      return empty;
    const old = new Map(manifest.files.map((record) => [record.path, record]));
    const eligible = new Map(
      currentRecords
        .filter(({ record }) => {
          const prior = old.get(record.path);
          return (
            prior &&
            JSON.stringify(prior) === JSON.stringify(record) &&
            (record.path.startsWith('/previews/p1/') ||
              record.path.startsWith('/_astro/') ||
              /^\/(art|edit)\//.test(record.path))
          );
        })
        .map(({ record }) => [record.path, record]),
    );
    if (!eligible.size) return empty;
    const receipts = new Map();
    const input = createReadStream(join(directory, 'verified.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let streamError;
    input.on('error', (error) => {
      streamError = error;
      lines.close();
    });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line),
          record = eligible.get(row.path);
        if (
          record &&
          row.root === manifest.root &&
          row.key === record.key &&
          row.sha256 === record.sha256 &&
          row.bytes === record.bytes &&
          typeof row.etag === 'string' &&
          row.etag.length > 0 &&
          row.etag.length <= 256
        )
          receipts.set(row.path, { ...record, previousRoot: manifest.root, etag: row.etag });
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (streamError || !receipts.size) return empty;
    const records = [...receipts.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const tree = merkle(records),
      positions = new Map(records.map((r, i) => [r.path, i]));
    return {
      count: records.length,
      root: tree.root,
      attach(row) {
        const index = positions.get(row.record.path);
        if (index === undefined) return row;
        const prior = records[index];
        return {
          ...row,
          prior: { etag: prior.etag, previousRoot: prior.previousRoot, proof: tree.proof(index) },
        };
      },
    };
  } catch {
    // Unavailable/corrupt historical evidence can only cause a full byte read.
    // It never creates a reusable proof or silently approves a missing object.
    return empty;
  }
}
