# Build-free catalogue publisher

Implementation is being integrated; a local commit or private test is not proof
of production installation. Consult the current production receipt and actual
`/delivery-release.json` before selecting this path. Never publish a private
snapshot or turn a fixture into production merely by deleting its marker.

The site keeps the existing addresses, Astro templates, public original Image
and PDF URLs and browser editor. One captured, authenticated metadata snapshot
supplies artworks, collections, search, recent discoveries, related results,
counts and sitemaps. Catalogue HTML is rendered on request and cached by the
complete snapshot plus software ABI. Search and Studio requests pin one snapshot
and retry a changed version once. A missing or corrupt record is not an empty
catalogue or a reason to resurrect an older artwork.

Runtime lives under `server/catalog-snapshot`, `server/catalog-search` and
`server/catalog-collections`, protected source directories rather than disposable
chat output. Unit tests live under `tests/catalog-snapshot` and its root runner.
Software compilation lives under `scripts/catalog-snapshot`; it compiles thirteen
page templates and browser entry points, not one file per catalogue artwork.
Content-only publication must not run that compiler. Compiler outputs are
reproducible work artifacts and do not constitute source or live verification.

A first installation needs a complete source-verified metadata bootstrap and a
small software/control deployment. Later approved batches update changed hash
paths, posting ranges, topic blocks and sitemap parts. Immutable predecessor
objects are reused. Exact source/image review, PDF exceptions, metadata readback,
scoped fresh signing, one publisher, conditional creation, atomic activation,
rollback and actual live checks remain mandatory. There is no aggregate account
census or 10 TB application allowance. Provider limits, actual disk space and
usage charges remain real; do not claim literally unlimited Cloudflare storage.

Before activation the issuer must verify actual source/editorial records, current
approved file URLs/bytes/checksums, every newly created graph object and cross-facet
semantics. Only then can it issue an Ed25519-signed snapshot binding the account,
bucket, software ABI, source, media and graph receipts, exact immutable manifest
and predecessor. The public Worker contains a verification key, never its private
signing key or an administrative upload endpoint. A successful unit test or a
caller-supplied status is not a source, media or deployment receipt.

A future topic must not depend on the topic names compiled into an old Worker.
Related ranking accepts the source-bound subject context from the same snapshot,
with the existing curated semantic rules retained. Collection v2 resolves current
covers, counts and card text from canonical captured records; it does not trust
obsolete duplicated DTO fields. Search UI metadata and discovery projections
must be refreshed with the batch. The publication graph must verify their
membership, counts and source identities before switching the active snapshot.

Current explicit runtime bounds include 1,000 artworks per topic gallery (the
reader supports a separately reviewed maximum up to 10,000), 4,096 preview roster
members, 500 Studio features and finite per-request object/byte budgets. These
are not evidence of a five-million-topic or billion-object benchmark. Maintain
bounded directory views/pagination as the catalogue grows. Do not promise a
five-minute end-to-end time without measuring a real authorized package,
including the source review and actual media transfer.

Keep accepted Git history, source-bound reviews, native sources, shared IndexNow
state, current and rollback receipts and the independent protected publisher
backup. Never include signing secrets or live API credentials in that backup.
A restored or compiled candidate must never activate itself.
