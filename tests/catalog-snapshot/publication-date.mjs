import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  publicationRevision,
  stampFirstPublication,
  verifyRecentDiscovery,
} from '../../scripts/catalog-snapshot/publication-date.mjs';
import { validateEditorialReview } from '../../scripts/artwork-editorial.mjs';
import { publicationTime } from '../../src/lib/publication-order.ts';

const batch = JSON.parse(
  readFileSync('data/catalog-batches/owner-watercraft-20-20261105-02-v2.json'),
);
const date = '2026-11-18T11:42:00.000Z';

test('new imports use the publisher date and keep the original artwork and review', () => {
  const first = batch.changes[0];
  assert.equal(first.expectedPublicSHA256, null);
  assert.equal(first.record.firstPublishedAt, undefined);
  const checked = stampFirstPublication(batch, date);
  const change = checked.changes[0];
  assert.equal(publicationTime(change.record), Date.parse(date));
  assert.deepEqual(change.record, { ...first.record, firstPublishedAt: date });
  const originalReview = batch.artworkRows.find(({ id }) => id === first.id);
  const row = checked.artworkRows.find(({ id }) => id === first.id);
  assert.equal(row.review.sourceSha256, originalReview.review.sourceSha256);
  assert.equal(row.raw.createdAt, originalReview.raw.createdAt);
  assert.deepEqual(validateEditorialReview(row.raw, row.review), originalReview.review.copy);
  assert.equal(
    checked.topicRows.flatMap((topic) => topic.resolvedItems).find(({ id }) => id === first.id)
      .firstPublishedAt,
    date,
  );
  assert.equal(first.record.firstPublishedAt, undefined);
  const edit = {
    ...batch,
    changes: batch.changes.map((change) => ({
      ...change,
      expectedPublicSHA256: 'a'.repeat(64),
    })),
  };
  assert.equal(stampFirstPublication(edit, date), edit);
  assert.throws(() => stampFirstPublication(batch, '2026-02-31T00:00:00.000Z'), /timestamp/);
  const revisionFields = {
    sourceCommit: 'a'.repeat(40),
    sourceCapsuleSHA256: 'b'.repeat(64),
    parentSnapshotSHA256: 'c'.repeat(64),
    publicationStartedAt: date,
  };
  assert.notEqual(
    publicationRevision(revisionFields),
    publicationRevision({
      ...revisionFields,
      publicationStartedAt: '2026-11-18T11:43:00.000Z',
    }),
  );
});

test('the publication guard reads visible grids and rejects a card found solely in navigation', () => {
  const checked = { ...stampFirstPublication(batch, date), publicationStartedAt: date };
  const id = checked.changes[0].id;
  for (const [path, marker] of [
    ['/', 'class="home-recent" aria-labelledby="home-recent-title"'],
    ['/new/', 'data-new-artwork aria-label="Latest published clipart"'],
  ]) {
    const card = '<article class="art-card" data-id="' + id + '"></article>';
    const elsewhere = '<nav>' + card + '</nav>';
    assert.doesNotThrow(() =>
      verifyRecentDiscovery('<section ' + marker + '>' + card + '</section>', path, checked),
    );
    assert.throws(
      () => verifyRecentDiscovery(elsewhere + '<section ' + marker + '></section>', path, checked),
      /absent/,
    );
  }
});
