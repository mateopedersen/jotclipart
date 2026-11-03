# Collection snapshot adapter

`scripts/collection-snapshots.mjs` prepares local, content-addressed collection
records for the coordinated incremental publisher. It does not build HTML,
upload, change caches, approve images, activate a release or prove a live result.
It calls the existing collection and artwork review gates. No paid inference or
network call is involved.

## Contract

`readCollectionSnapshotSource(root)` reads the accepted catalog, resolved public
metadata, editorial registries, topic definitions, categories, featured order
and reviewed relationships. `compileCollectionSnapshots(source)` returns:

- `index`, `indexBytes`, `indexSha256`: canonical UTF-8 JSON, schema 1,
  `type: collection-index`, public topic/artwork totals and topic descriptors.
- `objects`: `{key, bytes, sha256, body}` for every topic and membership object.
  Keys are relative to the caller's immutable snapshot namespace. No mutable
  production path or active release is included.
- Each `collection-topic` preserves the stable path/canonical, title, primary
  and secondary category links, concise schema/search summary, visible paragraphs,
  complete checked editorial record, actual artwork count, first gallery artwork,
  membership descriptors and up to six existing reviewed collection links.
- Each `collection-members` object contains the slug, zero-based offset and
  ordered artwork IDs. At most 256 IDs per object; smaller chunks are supported.
  This is internal storage segmentation, not a change to public gallery URLs.

Topic index order is alphabetical for deterministic serialization. Artwork
membership retains the existing stable featured-first page order. Related covers
follow the existing first-available featured artwork rule. Original image URLs,
image metadata and native files remain owned by the source-bound artwork records;
this adapter does not duplicate or replace them.

The adapter rejects unknown public topics, unsafe slugs, duplicate/missing
artwork identity, changed source checksums and stale paragraph approvals.
Objects are capped at 256 KiB and the root index at 1 MiB; exceeding the index
limit requires further partitioning rather than silently shipping a large file.
This does not claim the deferred million-item Studio work is complete.

## Publisher responsibilities

Stage the bytes in a revision-scoped private namespace, independently verify
SHA-256/size/readback, and bind the index to the same authorized release as
artwork/search/recent/related/count/sitemap indexes. Render escaped complete
server HTML using the accepted page components/styles. Check parity with existing
HTML, original R2 images, canonical/schema and user interactions before activation.
Keep counts and paragraph count tokens on the same snapshot revision. Globally
invalidate affected mutable URLs using the coordinated publisher's supported
mechanism. The adapter's in-memory output is not an activation receipt.

Validation: `node --test tests/collection-snapshots.mjs`. The catalog-wide case
compares every actual public topic, paragraph, editorial binding, gallery member,
category link and related cover against the current source/page rules.
