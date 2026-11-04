# Incremental discovery metadata

This module stages **private immutable metadata**. It neither approves source artwork nor signs a snapshot, uploads media, changes Cloudflare settings, changes an active pointer, or authorizes publication. The existing single publisher, source/editorial/media receipts, graph verification and signed compare-and-swap activation remain mandatory. No full catalog HTML build is required for content-only changes.

## First installation

Use the complete, source-verified public resolver records in the same source order used by `bootstrapRecent`. Do not substitute raw `art.json` records or gallery/created-date order. Read `topics` from the verified discovery shell; these records preserve source planning metadata while carrying the reviewed public `cluster` and `sourceCluster`.

```js
import { facetStore } from '../../server/catalog-collections/store.mjs';
import {
  bootstrapProjectionFacts,
  collectionStore,
} from '../../server/catalog-projections/facts.mjs';

const facet = facetStore(privateStagingBucket, { writable: true });
const discoveryProjection = await bootstrapProjectionFacts(
  collectionStore(facet),
  sourceOrderedPublicRecords,
  verifiedShellTopics,
  {
    artworkRootSHA256: candidate.indexes.artworks.sha256,
    recentLedgerSHA256: verifiedRecentDirectory.ledger.sha256,
  },
);
// Attach only to the private candidate's collections root. Recompute the
// reachable graph, remote receipts, source binding and signed envelope normally.
```

Bootstrap groups the verified source once. Each topic gets a source-order roster plus compact keyword, cover, category, monochrome, style/color, first-32 source picks and top-500 raster Studio facts. It does not duplicate full artwork records or original media. The ledger is bound to the exact artwork facet and recent ordinal ledger. Existing immutable media and unchanged metadata receipts can be reused only when the normal publisher proves exact hashes and bytes.

The actual 3505467 source comparison used 37,937 public artworks and 674 topics: all ten shell fields and all four UI data areas matched the accepted baseline after stable UI tie ordering. Bootstrap staged 1,366 private collections objects / 8,946,374 bytes in that experiment. This is an offline metadata comparison, not an image review or live publication.

## Content-only batches

Pass `refreshDiscoveryViews` as the `refreshViews` adapter to the bounded catalog delta composer. Contract:

```js
await refreshDiscoveryViews({
  bucket, parentContext, context, changes, topicChanges,
  searchStore, searchDataDescriptor,
  beforeTopic, afterTopic, readArtwork, sourceReceiptSHA256,
});
// Returns {collections, search, sourceReceiptSHA256, metrics,
//          publicationVerified:false}.
```

`topicChanges` carries `{slug, expectedRecordSha256, record, artworkIds}` from the normal validated collection writer. `record:null` withdraws a topic. Include both origin and destination of a moved artwork. `changes` includes each changed artwork's previous and next canonical public record. `beforeTopic` and `afterTopic` resolve the exact full collection records in their respective candidate contexts; `readArtwork(id, context)` returns a full current canonical public record (or `{rootSHA256,artwork}`). The updated recent ordinal map must already have been composed. Its source checksum, topic and stable ordinal are verified against every affected artwork. The adapter never treats copied card descriptions as the canonical artwork source.

Only affected topics resolve full artwork records, with four concurrent lookups at most. All bounded compact topic facts may be read to derive global category counts, keywords, previews, cluster picks, site-search rows, monochrome topics/kinds and the exact existing round-robin 500-item Studio algorithm. New topics need no addition to compiled source lists. Runtime template membership uses the reviewed snapshot `topic.cluster`; a stale compiled category override must not supersede it.

The adapter updates the source-order `catalogPreviewDirectory` roster for each changed topic and retains the existing directory codec's exact bytes, conditional creation and independent readback. Unchanged source ordinals survive an edit or move; new records get the recent ledger's new ordinals. Removal refills covers and Studio picks from the remaining canonical records of that affected topic. Missing bootstrap, stale roots/checksums, incomplete moves, invalid membership, conflicting totals, oversized metadata, or unsupported static-feature withdrawal fail closed. They never silently fall back to a full artwork scan.

Current explicit bounds are 10,000 topics, 4,096 artworks per changed topic, 64 changed topics and 16,384 canonical artwork lookups per batch, 128 categories/pages per field, 1,000 unregistered directory IDs, and the existing 500 Studio featured items. These finite bounds are not a claim of a million-topic Studio architecture. Registered-topic publication remains required; unrelated software/static content changes use their existing reviewed software release path. Static template features cannot be silently withdrawn. A cap failure requires a smaller bounded batch or an explicitly reviewed protocol change, not disabled validation.

## Child-page reuse and compatibility

Legacy shell pages contain a field and local offset; legacy UI pages also have offset descriptors. A new root explicitly declares `paging:'stable-v2'` / `source-bound-search-ui-v2`. Under that protocol, a byte-identical old child page may retain its original local offset after another page is inserted before it. New changed slices have a `-stable-v2` type and no offsets. Field identity, counts, row IDs, total bounds and immutable descriptors stay checked. This prevents an insertion from rewriting every later page. Legacy roots keep strict contiguous-offset validation; mixed v2 children are never accepted under a v1 root. Excessive fragmentation fails closed at the page cap.

## Permanent checks

- `node --test tests/discovery-projections.mjs`: immutable page reuse, edit/move/append/withdraw sequence, source/checksum/root/omitted-topic/static-feature guards. Fixtures are deliberately fictional and never content approvals.
- `node tests/e2e/discovery-projections-native.mjs`: the same metadata staging/readers execute through actual local native workerd and R2 for append, edit, move and final-topic withdrawal, compared with the Node implementation. No external requests or active production pointer are used. The installed local binary supports the test compatibility date 2026-10-23; this test changes no production/preview compatibility setting.
- The first-install source comparison and the final publisher must separately verify the actual baseline/source receipts, complete reachable graph and exact final candidate, then check real public URLs. A private fixture or an HTTP 200 on a stale public release is not live verification.
