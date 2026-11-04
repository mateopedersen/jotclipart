# Incremental collection/count metadata and canonical artwork references

This module stages immutable metadata only. It never writes an active pointer,
signs authorization, approves artwork, fabricates editorial reviews or activates
a release. The coordinated publisher owns source/media/graph/ABI verification,
remote staging, conditional activation, rollback and actual live verification.
Private fixtures and private editorial test markers remain unpublishable.

## Two view protocols

Keep the existing `collection-context-v1` reader for old snapshots. New collection
roots use `viewProtocol: collection-references-v2` and the request-scoped
`server/catalog-collections/reader.mjs`. Bind protocol support into the exact code
ABI before activating such a root. Do not send a v2 root to a v1-only reader.
A one-time switch does not rewrite all 674 existing topic records or blocks.

V2 accepts existing `collection-topic` / full-DTO page blocks as ID sources and
new `collection-topic-references` / `collection-page-ids` blocks. Duplicated
`relatedContext`, related counts/covers, gallery DTO fields and shared feature
DTOs are obsolete data in this protocol. They are never used as current metadata.
Membership and page ID order must agree. The current target topic record supplies
its own heading, paragraph source, canonical address and cover ID; the same root's
count facet supplies its current count. A withdrawn related target is omitted.
The graph/content verifier must apply these protocol semantics, while still
checking immutable bytes and the current topic's source-bound editorial record.

The reader receives one captured context with `getFacet`, `read`, `snapshot` and
`rootSHA256`. Its `resolveArtwork(id, context)` callback returns
`{ rootSHA256, artwork }` from that exact context's artwork facet. Different-root
results are rejected. Gallery, related covers, shared features and Surprise IDs
are deduplicated and resolved through this callback with at most four pending
lookups. Every public image stays at its original stable R2 URL. No full catalog
or global topic count map is loaded. `referenceCountValues` returns only up to
64 requested count keys; unknown keys are zero unless strict mode is selected.

The reader's default gallery ceiling is 1,000 (current largest topic: 149).
This is a bounded implementation for the accepted catalog, not a test of millions
of artworks in one gallery. A normal publisher must reject an unsupported larger
view before activation or introduce and verify pagination under a new ABI.
The captured context must independently enforce shared read/concurrency/byte
budgets and actual publication authorization. This reader does not create them.

## Changed-topic writer

`applyCollectionBatch(store, {collections, counts}, changes, options)` requires
exact parent hashes and at most 64 distinct topics. Each change includes its old
record hash (null for new), the complete accepted topic record (null for removal)
and ordered artwork IDs. Resolve old/new artwork facts through the respective
captured source roots. Do not read raw filename-derived metadata as public text.

`validateSourceTopic({change, oldRecord, oldIds})` is mandatory. The normal caller
must run the existing complete source-bound collection editorial/import gates,
including unique short paragraphs, current inventory/example checksums and
real image reviews where changed visual claims require them. Return the exact
`oldRecordSha256` and `newRecordSha256` of the checked input record. These hashes
bind the callback result; they are not a content-approval certificate. A callback
that returns nothing, an old source, invalid count text or mismatched editorial
copy stops before any collection/count puts. Tests use explicitly private records
and mock source validators; those must never enter the production content path.

The writer checks all changes before staging. It verifies existing scoped counts,
old membership, eligible new records and audited monochrome facts. Cross-topic
moves require both affected topics; eligible records cannot silently disappear
from a gallery. New/removal paths update only relevant hashed directory branches.
An absent hash branch is created without scanning or rewriting its siblings.

Membership chunks are at most 256 IDs; gallery blocks are at most 32 IDs.
Unchanged chunks retain their exact descriptor, including a legacy full-DTO block
whose ID order remains valid. Changed chunks become ID-only records. Counts use
the canonical primary category, matching `topicInCluster`, rather than counting
secondary display links as category memberships. Global totals and printable
counts use old/new canonical source facts. A new count version depends on the
updated count tree and values; old roots remain readable and untouched.

`facetStore` verifies descriptor scope, bytes and SHA, conditionally creates
content-addressed objects and independently reads them back. Its `written` map
means distinct staged descriptors, which can include already-existing objects;
it is not an actual PUT count. `metrics().puts` counts successful creations,
`reused` counts existing objects, and get/readback network calls must be measured
separately. Nothing here chooses a pointer, and interrupted staging cannot select
part of a release.

## Evidence and integration boundary

The local native workerd/R2 audit compared all 674 old/new topic HTML responses
byte for byte. Actual R2 delta tests cover append, cover/order/title/media updates,
new topic, final-item withdrawal, restoration, cross-topic move, unchanged sibling
and block reuse, source conflict, missing binding, corrupt metadata/canonical
cover, different-root resolver and old-root retention. Real imported sources and
synthetic private transition data are reported separately. Permanent tests live
in `tests/collection-reference-deltas.mjs`; these are private in-memory protocol
fixtures, not image review or Cloudflare deployment evidence.

After integrating with the normal publisher, repeat complete combined-facet,
source/ABI/authorization, native browser, remote transfer and live URL checks.
Do not submit Search Console, Bing or IndexNow for this work.
