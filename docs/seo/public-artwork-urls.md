# Public artwork URLs and separated sitemaps

Owner authorized the finite migration on 8 November 2026. Artwork IDs, accepted
copy, editorial fingerprints, original R2 files and personal saved IDs do not change.
`artworkRoot.publicRoutes` is a signed source-bound address projection, using
bounded hash maps. Its ID map persists the initial canonical slug; its path map
reserves both canonical and historical paths. New imports allocate a readable
address from the accepted title, resolving collisions without reusing any old path.
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
