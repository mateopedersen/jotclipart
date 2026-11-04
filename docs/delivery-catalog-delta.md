# Build-free catalog publisher

## State and ownership

This is the canonical source for the build-free publisher in this repository.
It remains **not installed and not fully end-to-end verified** until the first
successful production activation and public byte/page checks are recorded.
The source, Git history, original artwork, source-bound review receipts, protected
IndexNow ledger and independent `UltraClipart-Publisher-KEEP` backup must survive
chat and cache cleanup. Never preserve private signing keys in a source backup.

The initial software installation compiles thirteen existing templates rather
than rendering every artwork/editor page. Later content batches must not call
Astro, the template compiler or the full legacy deployment. Existing URLs, file
names, source hashes, licenses, accepted artwork and editor behavior remain the
public contract. Every server-rendered page captures one authenticated catalog
snapshot; its headings, image schema, related cards and counters use that root.
The old Worker remains the fallback for unrelated routes and old browser clients.

## Content-only transaction

The bounded composition entry point is
`scripts/catalog-snapshot/build-delta.mjs`. It accepts at most 256 changed artworks
and 64 affected topics, the authenticated predecessor and exact source validators.
There is no R2 listing, complete account census or full-catalog artwork loop.

1. Review the actual incoming images. Preserve originals, inspect identity and
   source-specific text, validate image/PDF composition and repair confirmed
   faults. The publisher validates those receipts; it does not infer image
   acceptance from a filename or silently enable paid inference.
2. Read only the predecessor paths needed by the batch through the private,
   root-pinned reader. Its cache is bounded to 512 objects and four outstanding
   requests. Verify every returned hash and byte length.
3. Compose changed artwork paths, exact topic memberships/counts, search postings,
   Studio/discovery views, recent/home order, related postings, cute selections
   and sitemap slots. A topic keyword/category change requires its complete scoped
   member delta so old search words cannot remain. Preserve older related
   candidates behind the visible top 96 so removals refill correctly.
4. Verify the changed graph. Reuse old descendants only through descriptors
   actually reached from the authenticated predecessor; reject arbitrary orphan
   hashes. Stage only the new descriptors reachable from the final graph, leaving
   private intermediate search nodes out of the upload.
5. Keep the normal single-writer lock, fresh 45-second signed exact write scope,
   conditional immutable creation and complete changed-object byte/MIME readback.
   The owner's former local 10 TB allowance and additional cushion are removed;
   provider limits and charges still apply.
6. Independently validate source/media/graph and native changed-route tests before
   issuing a new signed production envelope. Activate with an ETag conditional
   swap only if the authenticated live parent is unchanged. A collision is a
   stopped transaction, never a successful publish.
7. Verify public category, artwork, editor, original Image/PDF bytes, sitemap,
   search, related cards, counts and Surprise before reporting the batch live.
   A successful staging response is not publication.

The private reader and publisher are short-lived operator sessions. They must
never become public administration endpoints or expose persistent credentials.
No user input, query text, mutable pointer or personalized response may enter a
shared HTML cache. The HTML cache includes the software ABI and catalog root;
unchanged old cache entries need no global purge and cannot mix with the new root.

## One-time migration reuse

The initial 3505467 candidate metadata was actually staged and read back, but not
activated. A later reviewed source may reuse exact immutable objects from that
signed receipt using `reuse-readback.mjs`. Its signature, receipt hashes, scope,
keys, sizes, checksums and ETags must match. The stager uploads only new objects;
the issuer independently verifies the reuse anchor. This helper does not approve
new content or eliminate the native/live gates.

## Verification limits

Focused private reader, CAS, source-canonicalization, graph, related-tail and
identifier tests pass. The full bounded cross-facet dark run and final native
browser/public checks remain necessary. The first-install native report covered
76,136 local R2 objects and 26 managed routes; it is not a live production test.
The legacy full test command still contains tests requiring a compiled `dist`;
those failures cannot be described as passed merely because no static build is
performed. Track replacement runtime coverage explicitly.

Do not promise a five-minute or percentage speed gain without measuring a real
reviewed batch, including media transfer, activation and public verification.
Keep local working files limited to the incoming batch and small metadata delta;
never delete the sole native source or required rollback evidence to save space.
