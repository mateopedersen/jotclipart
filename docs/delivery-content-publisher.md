# Content-only operator workflow

This path separates content data from software installation. The initial build-free
runtime is already live; new templates or client code still need a small software
release. An ordinary reviewed content batch does not run Astro, compile templates,
walk the old media library, enumerate the account, or render old detail pages.

Use Node 24 and `npm run content:publish -- prepare|publish CAPSULE SOFTWARE CONFIG OUTPUT`.
The immutable reviewed capsule must be committed under `data/catalog-batches/`.
It contains at most 256 changed artworks, 64 affected topics, exact source-bound
artwork/topic reviews, image/PDF pairing decisions, immutable media facts, protected
native file references and the URL-to-native-file mapping. It is NOT a prompt or
an archive filename expanded into captions. Actual pixel review and source/brand
identification happen before admission; the publisher never fabricates them.
No inference service or paid model is enabled by this command.

`intakeArchive` in `scripts/catalog-snapshot/intake-archive.mjs` first preserves a
complete checksum-verified private ZIP and reads every ZIP member for CRC. APFS
clone support saves physical duplication; no full library/build is copied. Read
members from that private archive; repair only confirmed faults, retaining lineage.
The operator streams native hashes and stages at most four binary objects at a
time. An object is admitted only under its exact immutable manifest Merkle proof,
with a fresh 45-second scoped authorization, conditional creation and complete
remote bytes/hash/MIME readback. The former internal account-size quota is absent;
provider product limits, billing and the owner's local free-space floor remain.

The transaction captures the signed production parent, validates canonical source
and reviews, stages only submitted files, verifies their real public CDN bytes,
composes changed metadata and tests changed HTML in native workerd. Categories,
search, recent/home discovery, related postings and their refill tails, Studio,
counts, Surprise and sitemaps all use the same new graph. The compact opening
registry prevents repeated topic openings without reading old artwork files.
The issuer independently replays the source/graph and checks exact native and
remote receipts before signing. The activation swaps one R2 pointer only if the
parent and ETag still match. A collision stops; it never overwrites a newer release.

`prepare` does not activate. `publish` activates only after those gates, then checks
changed public topic/art/editor pages and complete incoming original media bytes.
It records a shared accepted data-only source ledger. A full legacy deployment is
blocked until that newer source is deliberately materialized, preventing another
checkout from erasing accepted imports. Source capsules, Git history, original
native assets, receipts and the independent KEEP backup are protected application
state. The current installed runtime/template package and rollback remain protected
as well. Temporary failed experiments and obsolete copied build packages may be
cleaned only after their references/processes and independent backup are checked.

A twenty-topic, 2,000-artwork campaign is divided into complete-topic packets, for
example ten packets of two 100-artwork topics. Each packet captures the preceding
verified root. Do not split incomplete topic memberships or silently skip a held
item. Package size, uplink throughput, image-specific review and actual repairs
vary: the owner's <=60-minute target is measured, not a universal guarantee.
The two private full-size technical tests reuse accepted unique media payloads;
they are not new visual approvals or proof that arbitrary faulty incoming images
can be reviewed and repaired in a fixed time. No test content is published.
