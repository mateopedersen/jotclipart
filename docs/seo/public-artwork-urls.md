# Public artwork URLs and separated sitemaps

Owner authorized the finite migration on 8 November 2026. Artwork IDs, accepted
copy, editorial fingerprints, original R2 files and personal saved IDs do not change.
`artworkRoot.publicRoutes` is a signed source-bound address projection, using
bounded hash maps. Its ID map persists the initial canonical slug; its path map
reserves both canonical and historical paths. New imports allocate a readable
address from the accepted image-specific title. A collision rejects the import
until the visible distinction has been reviewed and naturally named. Never append
automatic dates, package/sequence numbers or `-2`/`-3` collision counters. Meaningful
subject numbers such as Airbus A380, B-2 Spirit and Number 100 remain. Do not reuse
any old path.
Subsequent title corrections retain the initial canonical URL.

Use `artworkPath` / `artworkURL` for page links and image schema. Search resolves
addresses through the same captured root. `/edit/{stable-id}/` and saved IDs retain
the stable identity. A historical `/art/` address returns a server 301 to its new
canonical URL. Unrecognized artwork is a real 404. Do not rename IDs to make URLs
look nicer, regenerate editorial approvals, alter original media or replace the
source catalog with the local legacy JSON.

The canonical `/sitemap.xml` advertises one family each for fixed pages, topic
pages, collections, artwork and images. Each child has at most 10,000 URL records
and respects the 24 MiB hosting budget. Artwork and image families start at `-1`.
A regular canonical URL appears once across fixed/topic/collection/art families.
An image sitemap legitimately repeats its landing page with the original R2
`image:loc`; that is not a duplicate page sitemap. Incremental imports update the
same separated ledger and append a bounded part when needed.

`build-url-migration` validates every inherited source record, the committed plan,
all old sitemap entries and complete new membership before preparing the new
graph. Independent replay, native Worker tests, immutable remote readback, normal
signing and conditional single-writer activation remain required. Preparation is
not deployment. The finite migration is not a fresh visual review. Search Console
and Bing submissions follow live verification and the owner's explicit direction.

References: Google sitemap creation, image sitemaps and permanent redirects:
https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps
https://developers.google.com/search/docs/crawling-indexing/301-redirects

## Worker invocation isolation

The shared immutable metadata cache stores only fully consumed, SHA verified
bytes. Pending reads and HTML render promises must never be shared across Worker
invocations. Request scoped snapshot reads still deduplicate within their own
invocation; completed public HTML remains in the root and renderer bound Cache
API. A departed invocation was reproduced stranding a later request in workerd
with the previous pending caches. The permanent native lifecycle regression is
`tests/catalog-worker-request-isolation.mjs`; do not replace it with Node only
Promise tests or weaken compatibility flags.

Reference: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#handle-cross-request-promise-resolution

## Owner scope clarification, 8 November 2026

Only machine-only date/serial suffixes and bare topic/serial paths enter the
finite migration. Existing descriptive addresses, including older flag names
with a package serial followed by meaningful scene words, stay canonical at
their current URL. The current source inventory identifies 12,700 broken paths
and preserves 33,658 existing artwork URLs. In particular
`/art/pumpkin-hot-air-balloon/` is not redirected.

## Expanded owner scope, 10 November 2026 — pending source work

The owner now explicitly requests removal of artificial package ordinals even
when the existing URL also has scene words. This supersedes the earlier scope
exception for such historical scene URLs, including the Election Day suffixes
and flag package ordinals. Meaningful subject/model numbers remain unchanged.
The new finite plan is source-bound to the current signed root and accepted
artwork titles. It does not authorize changing original artwork, metadata,
stable IDs, reviews or licenses. All historical URLs must point directly with
301 to the final canonical route; retain every reservation. Reject collisions
rather than adding automatic counters. Source preparation is not live delivery.

The shared Surprise Me selection must carry stable `id` and root-derived
`publicSlug` separately. SSR anchors, client choices and warm navigation use
the canonical slug; recent-item tracking and source identity use the stable ID.
