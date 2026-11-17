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

const base = resolve('work/jotclipart-pdf-compat-fendi-batch-source-20261117'),
  output = resolve('work/jotclipart-pdf-compat-fendi-batch-plan-20261117');
const results = JSON.parse(readFileSync(join(base, 'results.json')));
assert.equal(results.length, 25);
assert(results.every((r) => r.status === 'NATIVE_AND_PDFIUM_REPAIR_CHECKED_NOT_PUBLISHED'));
mkdirSync(output, { recursive: true, mode: 0o700 });
const packets = [];
for (const r of results) {
  const dir = join(output, r.id);
  if (!existsSync(join(dir, 'packet-plan.json')))
    execFileSync(
      process.execPath,
      ['scripts/jotclipart/prepare-pdf-repair.mjs', r.id, r.pdf, r.receipt, dir],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 },
    );
  packets.push(JSON.parse(readFileSync(join(dir, 'packet-plan.json'))));
}
const packet = structuredClone(packets[0]);
packet.campaign = 'jotclipart-fendi-confirmed-native-pdf-repairs-20261117';
for (const key of ['changes', 'artworkRows', 'sourceFiles'])
  packet[key] = packets.flatMap((p) => p[key]);
packet.sourceMediaByURL = Object.assign({}, ...packets.map((p) => p.sourceMediaByURL));
packet.incomingMediaManifest.files = packets.flatMap((p) => p.incomingMediaManifest.files);
packet.incomingMediaManifest.bytes = packet.incomingMediaManifest.files.reduce(
  (n, f) => n + f.bytes,
  0,
);
packet.incomingMediaManifest.plannedAt = new Date().toISOString();
// The first independently verified single-item publication is deliberately
// retained in the topic inventory; this packet neither reverts nor republishes it.
const first = JSON.parse(
  readFileSync('data/catalog-batches/jotclipart-pdf-compat-fendi-071-v3-20261117.json'),
);
const rawById = new Map([...first.artworkRows, ...packet.artworkRows].map((r) => [r.id, r.raw]));
const recordById = new Map([...first.changes, ...packet.changes].map((r) => [r.id, r.record]));
const topicRow = packet.topicRows[0];
topicRow.rawItems = topicRow.rawItems.map((r) => rawById.get(r.id) ?? r);
topicRow.resolvedItems = topicRow.resolvedItems.map((r) => recordById.get(r.id) ?? r);
incomingMediaFiles(packet.incomingMediaManifest);
const v = createReviewedDeltaValidators({
  ...packet,
  phase: 'local-preflight',
  mediaPlanSHA256: incomingManifestSHA256(packet.incomingMediaManifest),
});
await v.validateSourceTopic({
  change: packet.topicChanges[0],
  oldRecord: packet.topicChanges[0].record,
  resolveAfterArtwork: async (id) => topicRow.resolvedItems.find((r) => r.id === id),
});
const path = 'data/catalog-batches/jotclipart-pdf-compat-fendi-rest-20261117.json';
assert(!existsSync(path));
writeFileSync(path, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' });
writeFileSync(
  join(output, 'summary.json'),
  JSON.stringify(
    {
      path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      artworks: packet.changes.length,
      topics: 1,
      files: packet.incomingMediaManifest.files.length,
      bytes: packet.incomingMediaManifest.bytes,
      status: 'LOCAL_SOURCE_AND_FORMAT_GATES_PASSED_NOT_PUBLISHED',
    },
    null,
    2,
  ) + '\n',
);
console.log(readFileSync(join(output, 'summary.json'), 'utf8'));
