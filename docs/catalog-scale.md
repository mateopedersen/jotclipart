# Catalog capacity and migration

UltraClipart upgraded to Cloudflare Pro on 2026-10-24. The project's upload-token
claim `max_file_count_allowed` was verified as 100,000 through the Cloudflare API.
The production project has `PAGES_WRANGLER_MAJOR_VERSION=4`; the manual deployment
also sets it explicitly. Production build checks enforce that verified ceiling.

Before card-chunk consolidation, the 6,200-illustration release used 19,396
Pages files before offloading (19,296 after Book offloading). Each illustration
generates a detail page and an editor page, plus search data. The 100,000-file
limit is per Pages project, not 100,000 illustrations. It does not make a five-million-item
catalog viable if one HTML file per item remains in the Pages deployment.

## Bounded search metadata

Search card metadata is stored in title-ordered chunks of eight records rather
than one static file per illustration. Ranked results already carry ordinals,
so normal browsing and query results go directly to the required chunks.
Only arbitrary saved IDs consult a small hashed ID-to-ordinal table. The
manifest does not embed all artwork metadata or ID locations.

Concurrent reads of the same chunk share a request only within the same
cancellation scope. A cancelled older search cannot cancel or cache over a
newer request. Every resolved card must still match its requested ID and
ordinal; malformed or cross-wired chunks fail closed. Content-versioned URLs
isolate the new format from existing browser caches.

The 5,500-item cold-browse fixture transfers 15,576 uncompressed JSON bytes
for its first eight cards, including the manifest and ranked ID page. Tests
compare all ranks and facets against the original scorer and verify file
headroom for a 7,700-artwork technology-completion scenario. These are bounded
tests, not a claim that the eventual multi-million-item architecture is done.

## First production stage: private HTML storage

The Book collection is a controlled migration. During a manual production
deployment, Astro renders both pages for each of its 50 reviewed items.
`scripts/catalog-pages/upload.mjs` uploads the 100 HTML files to the private
`ultraclipart-pages` R2 bucket under the release commit SHA, then downloads
each file to verify its SHA-256.
Only then does `scripts/catalog-pages/prune.mjs` remove those exact files from
the Pages bundle. The existing Pages Worker serves them from R2 at their
original `/art/{id}/` and `/edit/{id}/` URLs. Static artwork outside Book still
uses the old path. Missing and withdrawn items retain real 404 responses.

The offload manifest is intentionally local to the deployment. Every manual
deployment uploads the freshly rendered HTML to a new release prefix; the old
live Worker keeps reading the previous prefix until the new Pages deployment
activates. A failed deployment cannot change its live pages. Git-connected
builds do not set `CATALOG_OFFLOAD_COLLECTION`; they keep static fallback pages.
The manual deploy must finish after a Git-driven build.

## Next stages for 100,000 to 5,000,000 items

1. Split `data/art.json` and the search index into independently published
   batches. A single multi-million-record JSON import would overwhelm the
   build and Worker bundle even if HTML were moved to R2.
2. Store per-item metadata in indexed database shards, keep WebP/PDF masters
   in R2, and render or publish only the changed detail/editor pages per batch.
   Maintain a checked publication manifest and atomic activation pointer.
3. Move category listings, search, discovery, and the new-art feed to paginated
   data queries. Keep page-one HTML crawlable and cache common queries.
4. Generate a sitemap index with child sitemaps capped at 50,000 URLs, update
   only affected children, and preserve canonical URLs and structured data.
5. Add deletion/withdrawal propagation, performance budgets, and traffic-based
   Workers/R2 cost monitoring before broad routing is switched on.

The Book offload is the first working stage, not a claim that the remaining
static catalog can already hold five million entries. The site must complete
stages 1–5 before that target is supportable.

## Coordinated delivery migration — 2026-10-27

The verified 7ff19d7 production release contains 13,784 artworks but **95,739
Pages deployment files**. These numbers describe different resources. Its frozen,
audited full output is the rollback source. The rollback-source staging inventory contains 92,443 detail,
editor, responsive-preview and hashed runtime files (13,019,834,044 actual bytes)
in the existing private `ultraclipart-pages` bucket. Those are generated delivery
files; original downloadable artwork, accepted metadata, IDs and licenses remain
unchanged. Do not call this migration live until its successful final receipt and
canonical deployment have been checked.

The owner explicitly approved disabling automatic production deployments during
the transition. `source.config.production_deployments_enabled=false` was verified
through the project API. Do not turn it back on merely because a source commit
passes CI: Git builds have no authenticated R2 staging step. Manual publication
must use `node scripts/deploy.mjs`, not a raw upload of an old `dist` directory.
No new subscription, paid inference or indexing submission is authorized.

The normal publisher renders and runs source/editorial, media, SEO, CSP and unit
gates before staging. `UC_DELIVERY_PREPARE=1` marks an intermediate full build,
not a deployable artifact; only that preparation may exceed the raw Pages file
count. The final artifact is separately checked against the actual Pages and
Worker size budgets. Never remove a limit check from the final upload stage.

`delivery/stage.mjs` holds an account writer lock shared across local checkouts.
The existing original-media ingest now takes the same lock as well. Other
machines/operators must serialize account writes too; a local lock cannot prevent
an unrelated remote account administrator from uploading. A stale lock is never
automatically deleted. Confirm its process and private listener are gone first.

Each stage uses the existing account login, a complete fresh all-jurisdiction
inventory and the 10,000,000,000,000-byte ceiling. Inventory age stays limited to
45 seconds. A bounded private remote-development Worker can enumerate the same
actual bucket objects faster; every bucket roster and unsupported jurisdiction
still requires the original Cloudflare API proof. Enumeration failures, loops,
expired leases, missing bindings and unknown scopes stop writes. The private
Worker accepts only HMAC-authenticated inventory commands and Merkle proofs for
one fixed reviewed file set. It exposes no production administrative route.

Every object is conditionally created, then fetched and hashed independently.
Successful receipts are appended durably. A restart checks the exact current
manifest root and reuses only matching verified records; unverified work never
becomes active. An unavailable or mismatching published source can fall back only
to the exact locally hashed release bytes. Credentials, private preview tokens
and staging secrets stay out of source control and user-visible output.

`delivery/activate.mjs` requires the complete rendered catalog, exact revision,
manifest, byte counts and hashes before pruning a separate copy. The full build
stays available. Only the new Pages Worker activates the new R2 HTML prefix;
failed staging or uploading cannot switch the live prefix. Published URLs,
canonical and image schema remain intact. Editors retain noindex and their own
CSP. Unknown/withdrawn artwork keeps the existing real-404 policy; a verified
active file missing from R2 returns an uncacheable 503. Public caches are isolated
by release, and old hashed runtime assets are retained for cached older HTML.

The upload transport is process-local and pinned to the reviewed Wrangler source.
It renews sessions, checkpoints server-acknowledged uploads and checks the remote
cache before replaying. It never edits installed dependencies or treats an
ordinary permission-denied response as an expired session. A changed dependency
fingerprint stops publication for review.

A separate static-origin retry protects GET/HEAD against one transient
500/502/503/504. APIs, mutation methods and ordinary 4xx responses are not retried.
The emergency Studio presentation patch uses the exact committed shared CSS only
on successful editor/create HTML. It changes neither immutable asset bytes nor
user data. Rendered HTML revision and control revision must be reported separately
when this temporary patch is used. A fresh normal build with the same CSS needs
no patch.

The final capacity gate rejects Pages assets above 25 MiB, a Worker above the
current 64 MiB uncompressed limit, and a single Studio catalog above its 20 MiB
operational growth budget. It warns by failing closed before 85,000 Pages files.
The actual site currently has a roughly 14 MB Studio JSON; the next scale stage
must shard that catalog and versioned search data. Moving current delivery files
out of Pages does not complete the five-million-item database, incremental-build,
search, sitemap, CPU, request-quota or traffic-cost work listed above. Never claim
unlimited capacity or guaranteed unchanged speed.

Latest owner direction: the final public catalog must restore original R2 image sources. The 7ff HTML is rollback material only; never activate it as the final migration after the original-image restoration has been approved. Use the later clean, completely audited renderer revision. A build whose HTML text/alt audit fails is not a release candidate, even if its targeted unit tests passed.
