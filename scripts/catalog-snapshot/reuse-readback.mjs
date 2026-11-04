// Rebase-only migration helper. A signed immutable readback anchor can reuse
// exact unchanged objects; it never proves a new source, graph or publication.
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { sha256 } from './stage-manifest.mjs';
export async function verifyImmutableReadbackAnchor({
  snapshotBytes,
  graphBytes,
  remoteBytes,
  verifier,
}) {
  const snapshot = JSON.parse(snapshotBytes),
    graph = JSON.parse(graphBytes),
    remote = JSON.parse(remoteBytes),
    context = await captureProductionSnapshot(
      {
        get: async (key) =>
          key === 'catalog/active.json'
            ? { size: snapshotBytes.length, json: async () => snapshot }
            : null,
      },
      verifier,
    );
  if (
    sha256(graphBytes) !== snapshot.authorization.graphReceiptSHA256 ||
    graph.status !== 'SOURCE_MEDIA_GRAPH_AND_REMOTE_READBACK_VERIFIED' ||
    graph.revision !== snapshot.revision ||
    graph.manifestRoot !== snapshot.authorization.manifestRoot ||
    graph.sourceReceiptSHA256 !== snapshot.authorization.sourceReceiptSHA256 ||
    graph.mediaReceiptSHA256 !== snapshot.authorization.mediaReceiptSHA256 ||
    graph.softwareABI !== snapshot.authorization.abiSHA256 ||
    sha256(remoteBytes) !== graph.remoteReceiptSHA256 ||
    remote.status !== 'REMOTE_METADATA_BYTES_SHA_MIME_VERIFIED_NOT_ACTIVATED' ||
    remote.revision !== snapshot.revision ||
    remote.root !== graph.manifestRoot ||
    remote.accountId !== verifier.accountId ||
    remote.bucket !== verifier.bucketName ||
    remote.sourceReceiptSHA256 !== graph.sourceReceiptSHA256 ||
    !Array.isArray(remote.files) ||
    remote.objects !== remote.files.length ||
    graph.objects !== remote.files.length
  )
    throw Error('Signed immutable readback anchor differs');
  const files = new Map();
  let bytes = 0;
  for (const r of remote.files) {
    if (
      !/^catalog\/objects\/(artworks|collections|search|recent|related|counts|sitemaps)\/[a-f0-9]{64}\.json$/.test(
        r.key ?? '',
      ) ||
      r.key.split('/').at(-1) !== r.sha256 + '.json' ||
      r.path !== '/catalog-snapshot/' + r.key.slice('catalog/objects/'.length) ||
      !Number.isSafeInteger(r.bytes) ||
      r.bytes < 1 ||
      r.bytes > 1048576 ||
      typeof r.etag !== 'string' ||
      !r.etag ||
      files.has(r.key)
    )
      throw Error('Invalid anchored immutable readback');
    files.set(r.key, r);
    bytes += r.bytes;
  }
  if (bytes !== remote.bytes) throw Error('Readback anchor byte total differs');
  return {
    files,
    snapshotSHA256: context.rootSHA256,
    graphReceiptSHA256: sha256(graphBytes),
    remoteReceiptSHA256: sha256(remoteBytes),
    accountId: verifier.accountId,
    bucket: verifier.bucketName,
  };
}
export function splitImmutableReadbackPlan(records, anchor) {
  const fresh = [],
    reused = [];
  for (const r of records) {
    const old = anchor?.files.get(r.key);
    if (old) {
      if (
        ['key', 'path', 'bytes', 'sha256'].some((k) => r[k] !== old[k]) ||
        r.mime !== 'application/json'
      )
        throw Error('Reused immutable descriptor changed');
      reused.push({
        ...old,
        verification: 'PRIOR_SIGNED_IMMUTABLE_READBACK',
        anchorSnapshotSHA256: anchor.snapshotSHA256,
        anchorRemoteReceiptSHA256: anchor.remoteReceiptSHA256,
      });
    } else fresh.push(r);
  }
  return {
    fresh,
    reused,
    freshBytes: fresh.reduce((n, r) => n + r.bytes, 0),
    reusedBytes: reused.reduce((n, r) => n + r.bytes, 0),
  };
}
