import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifiedLiveArtworkRedirects } from '../scripts/catalog-snapshot/verify-content-live.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function fixture(directory, location = 'https://jotclipart.com/art/natural-title/') {
  const packet = { changes: [{ id: 'stable-original-id', record: {} }] },
    packetBytes = Buffer.from(JSON.stringify(packet));
  const native = {
    revision: 'a'.repeat(40),
    softwareABI: 'b'.repeat(64),
    packetSHA256: hash(packetBytes),
    productionWrites: 0,
    routes: [
      {
        path: '/art/stable-original-id/',
        source: 'changed-artwork-stable-id-redirect',
        status: 301,
        expectedLocation: location,
      },
    ],
  };
  const nativeBytes = Buffer.from(JSON.stringify(native)),
    graphBytes = Buffer.from(JSON.stringify({ nativeIntegrationSHA256: hash(nativeBytes) }));
  for (const [name, bytes] of [
    ['packet.json', packetBytes],
    ['native-integration-report.json', nativeBytes],
    ['graph-verified-receipt.json', graphBytes],
  ])
    writeFileSync(join(directory, name), bytes);
  return {
    packet,
    sealed: {
      snapshot: {
        revision: native.revision,
        authorization: { abiSHA256: native.softwareABI, graphReceiptSHA256: hash(graphBytes) },
      },
    },
  };
}
test('live canonical aliases require the exact source-bound native target', () => {
  const d = mkdtempSync(join(tmpdir(), 'jot-live-alias-'));
  try {
    const { packet, sealed } = fixture(d);
    assert.equal(
      verifiedLiveArtworkRedirects(d, packet, sealed).get('/art/stable-original-id/'),
      'https://jotclipart.com/art/natural-title/',
    );
    writeFileSync(join(d, 'native-integration-report.json'), '{}');
    assert.throws(() => verifiedLiveArtworkRedirects(d, packet, sealed), /native route proof/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
test('a modified graph, packet or foreign-origin redirect cannot be followed', () => {
  const d = mkdtempSync(join(tmpdir(), 'jot-live-alias-'));
  try {
    let f = fixture(d);
    f.sealed.snapshot.authorization.graphReceiptSHA256 = 'c'.repeat(64);
    assert.throws(() => verifiedLiveArtworkRedirects(d, f.packet, f.sealed), /Signed source graph/);
    f = fixture(d);
    writeFileSync(join(d, 'packet.json'), '{}');
    assert.throws(() => verifiedLiveArtworkRedirects(d, f.packet, f.sealed));
    f = fixture(d, 'https://foreign.invalid/art/natural-title/');
    assert.throws(() => verifiedLiveArtworkRedirects(d, f.packet, f.sealed));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
