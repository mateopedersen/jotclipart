# Missed historical artwork URL repair

The complete public sitemap scan on 9 November 2026 found 150 canonical routes
that the finite 8 November migration missed. Their immutable package prefixes
were `300`, `powerpoint` and `tesla-brand`, but their current topics were
`300-movie`, `presentation` and `tesla`. Comparing a stable ID only with today's
mutable topic name therefore failed to identify these bare serial addresses.

The owner requests correction of bad numeric/package addresses only. Existing
keyword rich scene addresses and meaningful subject/model numbers stay unchanged.
The full scan classified every sitemap entry, then fetched all 370 suspicious
pages. The 150 repair rows use the already accepted image-specific source title;
170 meaningful number subjects and 50 descriptive Election Day scene URLs are
preserved. No new pixel review, caption rewrite or model identification is implied.

`build-url-repair` is a separate, finite, source-bound operation over an installed
route projection. The committed plan fixes the exact parent root, stable IDs,
accepted titles, topics, original image addresses and canonical record checksums.
The three historical topic-prefix relationships are explicitly bounded. The
builder rejects stale records, already descriptive canonicals, numeric-only new
addresses and collisions with any canonical or historical reserved path. It
updates every affected alias directly to the new canonical address, keeps all
old paths reserved and compares every other ID/path with its predecessor.

Only the public route projection and corresponding artwork/image sitemap
entries change. Source artwork records, R2 originals, immutable IDs, editor links,
search records, saved IDs, accepted reviews and topics stay intact. Unrelated
sitemap entries are compared byte for byte; families remain distinct, original
R2 image membership remains complete and each child stays below 10,001 entries.
Current installed renderers regenerate the root-bound public discovery HTML.
The operator requires native testing, immutable remote readback, independent
source replay, normal signing and conditional activation against the exact parent.
Preparation and staging are not live publication.

For subsequent content imports, keep `extendPublicArtworkRoutes` as the sole
allocator. It derives a new public address from the accepted image-specific title
regardless of package ID or topic name. Do not use the immutable ID as a public
canonical address, append timestamps/sequences/collision counters, or rename an
accepted URL after a caption/topic correction. A collision requires a reviewed,
visible distinguishing title. The permanent regression tests include all three
renamed-topic failures, future title-based allocation, stable URLs after later
copy changes, meaningful numbers and atomic collision rejection.

Use `scripts/catalog-snapshot/publish-url-repair.mjs` only with the committed
plan, current accepted parent and installed runtime. Observe the shared account
publication queue; never race another publisher or bypass its lock.

Google references:
- https://developers.google.com/search/docs/crawling-indexing/301-redirects
- https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
