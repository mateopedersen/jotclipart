import { merkle } from '../../scripts/delivery/manifest.mjs';
import { OWNER_MANAGED_STORAGE_POLICY } from '../../scripts/delivery/release-write-authorization.mjs';
import { waveFor, date } from './publication.mjs';

/** A complete release, not an account inventory or publication approval. */
export function releaseFixture(groups) {
  const waves = groups.map((items, index) => ({ ...waveFor(items), number: index + 1 }));
  const source = waves.flatMap((wave) =>
    wave.batch.map((object) => ({
      path: object.path.slice('public'.length),
      key: object.key,
      bytes: object.bytes,
      sha256: object.sha256,
      assetId: object.assetId,
      kind: object.kind,
      wave: wave.number,
    })),
  );
  const tree = merkle(source);
  const job = {
    storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
    accountId: 'a'.repeat(32),
    bucket: 'ultraclipart',
    root: tree.root,
    revision: 'b'.repeat(40),
    authorizedBytes: source.reduce((sum, row) => sum + row.bytes, 0),
  };
  const records = source.map((record, index) => ({ record, proof: tree.proof(index) }));
  const done = new Map(
    source.map((record) => [
      record.path,
      {
        path: record.path,
        key: record.key,
        bytes: record.bytes,
        sha256: record.sha256,
        root: job.root,
        accountId: job.accountId,
        bucket: job.bucket,
        jurisdiction: 'default',
      },
    ]),
  );
  return {
    records,
    waves,
    done,
    job,
    missing: new Set([source.at(-1).path]),
    startedAt: date,
    completedAt: date,
    now: Date.parse(date),
  };
}
