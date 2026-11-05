// Per-batch source gates reuse the established editorial/publication validators.
// This validates evidence already produced after inspecting actual pixels; it
// cannot itself claim a new visual review or silently invoke paid inference.
import assert from 'node:assert/strict';
import { assertKnownTopicDisplaySpelling } from './display-spelling-guard.mjs';
import { assertCollectionVisitorCopy } from './collection-visitor-copy.mjs';
import { validateEditorialReview } from '../artwork-editorial.mjs';
import { verifyCollectionEditorial } from '../collection-editorial.mjs';
import { validateManifest, catalogFiles } from '../publication-policy.mjs';
import {
  incomingMediaFiles,
  isIncomingMediaPlan,
  incomingManifestSHA256,
  assertIncomingCDNReceipt,
} from './incoming-media-plan.mjs';
import { canonical, digest } from '../../server/catalog-search/store.mjs';
import { bytesOf, digest as collectionDigest } from '../../server/catalog-collections/store.mjs';
import { validateEditorSource } from '../../src/lib/artwork-source.ts';
const h = (x) => digest(JSON.stringify(canonical(x))),
  hex = /^[a-f0-9]{64}$/;
export function createReviewedDeltaValidators({
  artworkRows,
  topicRows,
  incomingMediaManifest,
  mediaReceiptSHA256,
  mediaReceipt,
  mediaPlanSHA256,
  phase = 'verified-media',
}) {
  const preflight = phase === 'local-preflight';
  if (!['local-preflight', 'verified-media'].includes(phase))
    throw Error('Unknown media validation phase');
  if (
    !Array.isArray(artworkRows) ||
    artworkRows.length > 256 ||
    new Set(artworkRows.map((r) => r.id)).size !== artworkRows.length ||
    !Array.isArray(topicRows) ||
    topicRows.length > 64 ||
    new Set(topicRows.map((r) => r.slug)).size !== topicRows.length ||
    !hex.test((preflight ? mediaPlanSHA256 : mediaReceiptSHA256) ?? '')
  )
    throw Error('Bounded exact source batches and media receipt required');
  if (
    preflight &&
    (mediaReceiptSHA256 !== undefined ||
      mediaReceipt !== undefined ||
      mediaPlanSHA256 !== incomingManifestSHA256(incomingMediaManifest))
  )
    throw Error('Local preflight needs an exact media plan hash, never a remote receipt');
  const planned = isIncomingMediaPlan(incomingMediaManifest);
  if (!preflight && planned)
    assertIncomingCDNReceipt(incomingMediaManifest, mediaReceipt, mediaReceiptSHA256);
  const evidence = preflight ? { mediaPlanSHA256 } : { mediaReceiptSHA256 };
  const media =
      preflight || planned
        ? incomingMediaFiles(incomingMediaManifest)
        : validateManifest(incomingMediaManifest),
    art = new Map(artworkRows.map((r) => [r.id, r])),
    topics = new Map(topicRows.map((r) => [r.slug, r]));
  return {
    async validateSourceChange({ change, oldRecord }) {
      const row = art.get(change.id);
      if (!row) throw Error('Missing source/editorial record');
      assert.equal(row.expectedOldPublicSHA256, oldRecord ? await h(oldRecord) : null);
      if (change.record === null) {
        if (
          row.decision !== 'OWNER_AUTHORIZED_WITHDRAWAL' ||
          typeof row.reason !== 'string' ||
          row.reason.trim().length < 12 ||
          !hex.test(row.ownerApprovalReceiptSHA256 ?? '')
        )
          throw Error('Source-bound withdrawal authorization required');
        return {
          oldPublicSHA256: await h(oldRecord),
          newPublicSHA256: null,
          reviewReceiptSHA256: await h(row),
          ...evidence,
        };
      }
      const a = change.record,
        raw = row.raw;
      if (raw?.id !== change.id || !raw.published || !raw.indexable || !a.published || !a.indexable)
        throw Error('Reviewed eligible raw source required');
      assertKnownTopicDisplaySpelling(a.topic, a, 'Changed artwork ' + change.id);
      const copy = validateEditorialReview(raw, row.review);
      for (const k of ['title', 'alt', 'description']) assert.equal(a[k], copy[k], k);
      for (const k of ['id', 'topic', 'width', 'height', 'alpha', 'sourceType', 'license'])
        assert.deepEqual(a[k], raw[k], k);
      if (oldRecord) {
        assert.equal(a.id, oldRecord.id);
        assert.deepEqual(a.license, oldRecord.license);
      }
      assert.equal(a.thumb, a.webp, 'public thumbnails use the accepted original');
      assert.equal(typeof a.monochrome, 'boolean');
      if (
        row.monochromeReceipt?.sourceSHA256 !== raw.files?.thumb?.sha256 ||
        row.monochromeReceipt.monochrome !== a.monochrome ||
        !hex.test(row.monochromeReceipt.receiptSHA256 ?? '')
      )
        throw Error('Source-bound monochrome measurement required');
      const files = catalogFiles([raw]),
        urls = {};
      let reused = true;
      for (const f of files) {
        const priorURL = f.kind === 'thumb' ? oldRecord?.originalThumb : oldRecord?.[f.kind],
          prior = oldRecord?.files?.[f.kind];
        if (!priorURL || prior?.sha256 !== f.sha256 || prior?.bytes !== f.bytes) {
          reused = false;
          const actual = media.get(f.assetId + '/' + f.kind);
          assert(actual, 'missing incoming original/media proof');
          for (const k of ['path', 'bytes', 'sha256']) assert.equal(actual[k], f[k]);
          urls[f.kind] = actual.url;
        } else urls[f.kind] = priorURL;
      }
      if (
        !reused &&
        (![
          'MATCHED_SOURCE_PIXELS',
          'REPAIRED_AND_MATCHED_SOURCE_PIXELS',
          'OWNER_ACCEPTED_VALID_SUPPLIED_PRINT',
        ].includes(row.pairReceipt?.status) ||
          row.pairReceipt.imageSHA256 !== raw.files.webp.sha256 ||
          row.pairReceipt.pdfSHA256 !== raw.files.pdf.sha256 ||
          !hex.test(row.pairReceipt.receiptSHA256 ?? ''))
      )
        throw Error('Image/PDF composition receipt required');
      const expected = {
        ...raw,
        ...copy,
        monochrome: a.monochrome,
        monochromeKind: row.monochromeReceipt.kind ?? null,
        editable: true,
        layered: validateEditorSource(raw) === 'layered',
        svg: raw.sourceType === 'raster' ? null : urls.svg,
        webp: urls.webp,
        pdf: urls.pdf,
        originalThumb: urls.thumb,
        thumb: urls.webp,
        thumbWidth: raw.width,
        preview: urls.webp,
        previewWidth: raw.width,
        previewHeight: raw.height,
      };
      assert.deepEqual(
        canonical(a),
        canonical(JSON.parse(JSON.stringify(expected))),
        'public fields must come from the exact canonical source resolver',
      );
      return {
        oldPublicSHA256: oldRecord ? await h(oldRecord) : null,
        newPublicSHA256: await h(a),
        imageSHA256: a.files.webp.sha256,
        reviewReceiptSHA256: await h({
          raw,
          review: row.review,
          monochrome: row.monochromeReceipt,
          pair: row.pairReceipt ?? null,
        }),
        ...evidence,
      };
    },
    async validateSourceTopic({ change, oldRecord, resolveAfterArtwork }) {
      const row = topics.get(change.slug);
      if (!row) throw Error('Missing changed-topic source');
      if (change.record === null) {
        if (
          row.decision !== 'OWNER_AUTHORIZED_EMPTY_TOPIC_WITHDRAWAL' ||
          !hex.test(row.ownerApprovalReceiptSHA256 ?? '')
        )
          throw Error('Topic withdrawal review required');
        return {
          oldRecordSha256: oldRecord ? await collectionDigest(bytesOf(oldRecord)) : null,
          newRecordSha256: null,
        };
      }
      assertKnownTopicDisplaySpelling(change.slug, change.record, 'Changed topic ' + change.slug);
      assertKnownTopicDisplaySpelling(change.slug, row.editorial, 'Changed topic editorial ' + change.slug);
      if (!oldRecord || oldRecord.summary !== change.record.summary ||
          JSON.stringify(oldRecord.paragraphs) !== JSON.stringify(change.record.paragraphs)) {
        assertCollectionVisitorCopy(change.slug, row.editorial);
      }
      if (
        !Array.isArray(row.rawItems) ||
        !row.rawItems.length ||
        row.rawItems.length > 10000 ||
        !Array.isArray(row.resolvedItems) ||
        new Set(row.rawItems.map((a) => a.id)).size !== row.rawItems.length ||
        row.rawItems.some((a) => a.topic !== change.slug) ||
        row.resolvedItems.some((a) => a.topic !== change.slug)
      )
        throw Error('Exact scoped topic inventory required');
      if (typeof resolveAfterArtwork !== 'function')
        throw Error('Captured after-source resolver required');
      assert.deepEqual(
        row.rawItems.map((a) => a.id).sort(),
        row.resolvedItems.map((a) => a.id).sort(),
      );
      for (const a of row.resolvedItems)
        assert.equal(
          await h(await resolveAfterArtwork(a.id)),
          await h(a),
          'collection prose must bind the actual post-delta source',
        );
      verifyCollectionEditorial(
        row.rawItems,
        { schema: 1, topics: { [change.slug]: row.editorial } },
        row.resolvedItems,
      );
      assert.deepEqual(change.record.editorial, row.editorial);
      assert.equal(change.record.summary, row.editorial.intro);
      assert.deepEqual(change.record.paragraphs, row.editorial.paragraphs);
      assert.deepEqual([...change.artworkIds].sort(), row.resolvedItems.map((a) => a.id).sort());
      return {
        oldRecordSha256: oldRecord ? await collectionDigest(bytesOf(oldRecord)) : null,
        newRecordSha256: await collectionDigest(bytesOf(change.record)),
      };
    },
  };
}
