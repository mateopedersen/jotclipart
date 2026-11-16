# JotClipart social cover sources and reproducible checks

The 26 existing 1200 × 630 SVG compositions keep their layout, Inter font bytes,
accepted artwork and page-specific purpose. Site branding uses JotClipart,
`#52B788` and the approved green action/text/surface palette. Catalog cover titles
receive one Free prefix. Artwork colors and the Studio example color choices are
preserved. The New Clipart cover alone selects six current subject winners from
the signed catalog's recent ledger; it does not treat the historical static
`data/art.json` catalog as the complete live catalog.

`data/social-source-artworks.json` records each required original's exact ID,
logical input path, immutable `assets.jotclipart.com` address, bytes, MIME and full
SHA-256. Its embedded production snapshot is Ed25519 signed by the configured
public catalog key. Source preparation reads only the captured checksum-addressed
metadata and validates the signature and source graph before recording references:

```sh
node scripts/social/capture-sources.mjs ../captured-catalog
pnpm social:build
pnpm social:check
node scripts/social/test-verified-covers.mjs
```

Use the project's supported Node and lockfile. A regeneration fetches a missing
approved original only from the new immutable asset host, checks HTTP/MIME, size,
WebP magic and full SHA-256, and caches it under ignored
`.astro/social-images/originals`. Reused cache bytes receive the same mandatory
full checks. Catalog original files are unchanged; only cover-sized PNG composition derivatives are rendered. No original is put into Git, copied back into
`public/catalog`, or uploaded to R2. Network failures have bounded retries;
checksum, format or metadata failures remain hard failures.

Clean checkout CI verifies the already reviewed PNGs without downloading the
art archive or re-rendering host-dependent font output. The verifier checks the
signed source snapshot, source-manifest/renderer hash binding, unchanged font
hashes, output PNG bytes/dimensions, source hashes and text bounds. It also checks
an original directly if that original happens to exist locally. The isolated
negative checks reject a changed PNG, a changed font and a forged catalog
signature even after recomputing local root/renderer hashes. These checks are
artifact checks, not a new catalog-wide visual review.

The guide cover uses the exact actual JotClipart native Studio capture at
`public/social/jotclipart-studio-native-20261116.jpg`. It is a local preview
capture, not an invented UI or a claim that production was tested. The old
UltraClipart capture remains unchanged. Existing Gmail contact details remain
literal because no replacement mailbox has been verified. The old generated
cover PNGs are retained as migration rollback evidence; regeneration does not
silently remove them.
