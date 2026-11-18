import { createHash } from 'node:crypto';
import { reviewContextSignature, validateEditorialReview } from '../artwork-editorial.mjs';

export function publicationRevision({
  sourceCommit,
  sourceCapsuleSHA256,
  parentSnapshotSHA256,
  publicationStartedAt,
}) {
  const fields = [
    'catalog-content-v2',
    sourceCommit,
    sourceCapsuleSHA256,
    parentSnapshotSHA256,
    publicationStartedAt,
  ];
  return createHash('sha256').update(fields.join('\n')).digest('hex').slice(0, 40);
}

// Production publication supplies the date, independently of creation dates
// retained from the incoming illustration and its original review.
export function stampFirstPublication(capsule, publicationStartedAt) {
  if (publicationStartedAt === undefined) return capsule;
  if (
    typeof publicationStartedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(publicationStartedAt) ||
    !Number.isFinite(Date.parse(publicationStartedAt)) ||
    new Date(publicationStartedAt).toISOString() !== publicationStartedAt
  )
    throw Error('Invalid catalog publication timestamp');
  if (Object.hasOwn(capsule, 'publicationStartedAt'))
    throw Error('Publication timestamp belongs to the publisher');

  const dates = new Set(
    capsule.changes
      .filter(
        (change) =>
          change.record &&
          change.expectedPublicSHA256 === null &&
          change.record.firstPublishedAt === undefined,
      )
      .map((change) => change.id),
  );
  if (!dates.size) return capsule;

  const stamp = (record) => ({ ...record, firstPublishedAt: publicationStartedAt });
  const changes = capsule.changes.map((change) =>
    dates.has(change.id) ? { ...change, record: stamp(change.record) } : change,
  );
  const artworkRows = capsule.artworkRows.map((row) => {
    if (!dates.has(row.id)) return row;
    validateEditorialReview(row.raw, row.review);
    if (row.raw.firstPublishedAt !== undefined)
      throw Error('Submitted and resolved publication dates differ');
    const raw = stamp(row.raw);
    return {
      ...row,
      raw,
      review: { ...row.review, inputContextSha256: reviewContextSignature(raw) },
    };
  });
  const stampRows = (rows) => rows.map((row) => (dates.has(row.id) ? stamp(row) : row));
  const topicRows = capsule.topicRows.map((row) => ({
    ...row,
    rawItems: stampRows(row.rawItems),
    resolvedItems: stampRows(row.resolvedItems),
  }));
  return { ...capsule, changes, artworkRows, topicRows };
}

export function verifyRecentDiscovery(html, path, packet) {
  if (!packet.publicationStartedAt) return;
  const incoming = new Set(
    packet.changes
      .filter(
        (change) =>
          change.expectedPublicSHA256 === null &&
          change.record?.firstPublishedAt === packet.publicationStartedAt,
      )
      .map((change) => change.id),
  );
  if (!incoming.size) return;
  const marker =
    path === '/'
      ? /<section\b[^>]*aria-labelledby="home-recent-title"[^>]*>/
      : /<section\b[^>]*\bdata-new-artwork(?=[\s=>])[^>]*>/;
  const after = html.split(marker)[1]?.split('</section>')[0] ?? '';
  const ids = [...after.matchAll(/<article\b[^>]*\bdata-id="([^"]+)"/g)].map((m) => m[1]);
  if (!ids.some((id) => incoming.has(id)))
    throw Error('Newly published artwork absent from the recent grid on ' + path);
}
