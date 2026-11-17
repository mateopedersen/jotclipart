import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReviewedDeltaValidators } from '../catalog-snapshot/validate-delta-source.mjs';
import {
  incomingManifestSHA256,
  incomingMediaFiles,
} from '../catalog-snapshot/incoming-media-plan.mjs';
import { contentPresentationOptions } from '../catalog-snapshot/content-presentation-options.mjs';
const [baseArg, outputArg, capsulePath] = process.argv.slice(2);
assert(baseArg && outputArg && /^data\/catalog-batches\/[a-z0-9-]+\.json$/.test(capsulePath ?? ''));
const base = resolve(baseArg),
  output = resolve(outputArg);
assert(
  base.startsWith(resolve('work') + '/') &&
    output.startsWith(resolve('work') + '/') &&
    !existsSync(capsulePath),
);
const results = JSON.parse(readFileSync(join(base, 'results.json')));
assert(results.length > 0 && results.length <= 256);
assert(results.every((r) => r.status === 'NATIVE_AND_PDFIUM_REPAIR_CHECKED_NOT_PUBLISHED'));
mkdirSync(output, { recursive: true, mode: 0o700 });
const preparedIds = [],
  failures = [],
  topics = new Map(),
  merged = { changes: [], artworkRows: [], sourceFiles: [], sourceMediaByURL: {}, files: [] };
let firstPacket;
for (const r of results) {
  const dir = join(output, r.id);
  try {
    if (!existsSync(join(dir, 'packet-plan.json')))
      execFileSync(
        process.execPath,
        ['scripts/jotclipart/prepare-pdf-repair.mjs', r.id, r.pdf, r.receipt, dir, r.sourceImage],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 },
      );
    const p = JSON.parse(readFileSync(join(dir, 'packet-plan.json')));
    if (!firstPacket) firstPacket = structuredClone(p);
    preparedIds.push(p.changes[0].id);
    for (const key of ['changes', 'artworkRows', 'sourceFiles']) merged[key].push(...p[key]);
    Object.assign(merged.sourceMediaByURL, p.sourceMediaByURL);
    merged.files.push(...p.incomingMediaManifest.files);
    if (!topics.has(p.topicRows[0].slug))
      topics.set(p.topicRows[0].slug, { row: p.topicRows[0], change: p.topicChanges[0] });
  } catch (e) {
    failures.push({ id: r.id, error: (e.stderr?.toString() ?? String(e)).slice(-1600) });
  }
  if ((preparedIds.length + failures.length) % 10 === 0)
    console.log(
      JSON.stringify({
        prepared: preparedIds.length,
        held: failures.length,
        total: results.length,
      }),
    );
}
writeFileSync(
  join(output, 'source-preparation-results.json'),
  JSON.stringify({ prepared: preparedIds, failures }, null, 2) + '\n',
);
if (failures.length)
  throw Error('Source reconciliation holds must be resolved; no partial capsule written');
const packet = firstPacket;
packet.campaign = capsulePath
  .split('/')
  .at(-1)
  .replace(/\.json$/, '');
for (const key of ['changes', 'artworkRows', 'sourceFiles']) packet[key] = merged[key];
packet.sourceMediaByURL = merged.sourceMediaByURL;
packet.incomingMediaManifest.files = merged.files;
packet.incomingMediaManifest.bytes = packet.incomingMediaManifest.files.reduce(
  (n, f) => n + f.bytes,
  0,
);
packet.incomingMediaManifest.plannedAt = new Date().toISOString();
const rawById = new Map(packet.artworkRows.map((r) => [r.id, r.raw])),
  recordById = new Map(packet.changes.map((c) => [c.id, c.record]));
packet.topicRows = [];
packet.topicChanges = [];
for (const { row, change } of topics.values()) {
  row.rawItems = row.rawItems.map((r) => rawById.get(r.id) ?? r);
  row.resolvedItems = row.resolvedItems.map((r) => recordById.get(r.id) ?? r);
  packet.topicRows.push(row);
  packet.topicChanges.push(change);
}
packet.presentationPreparation = {
  maxRoutes: Math.max(
    64,
    Math.ceil((10 + packet.changes.length + packet.topicChanges.length) / 32) * 32,
  ),
  maxOutputBytes: 64 * 1024 * 1024,
};
contentPresentationOptions(packet);
incomingMediaFiles(packet.incomingMediaManifest);
const validators = createReviewedDeltaValidators({
  ...packet,
  phase: 'local-preflight',
  mediaPlanSHA256: incomingManifestSHA256(packet.incomingMediaManifest),
});
for (const row of packet.topicRows) {
  const change = packet.topicChanges.find((c) => c.slug === row.slug);
  await validators.validateSourceTopic({
    change,
    oldRecord: change.record,
    resolveAfterArtwork: async (id) => row.resolvedItems.find((r) => r.id === id),
  });
}
writeFileSync(capsulePath, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' });
const summary = {
  capsulePath,
  sha256: createHash('sha256').update(readFileSync(capsulePath)).digest('hex'),
  artworks: packet.changes.length,
  topics: packet.topicChanges.length,
  files: packet.incomingMediaManifest.files.length,
  bytes: packet.incomingMediaManifest.bytes,
  presentationPreparation: packet.presentationPreparation,
  status: 'SOURCE_RECONCILED_AND_NATIVE_REPAIRED_NOT_PUBLISHED',
};
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
