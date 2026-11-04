# Content-only operator workflow

New incoming media starts as an honest `PLANNED_INCOMING_MEDIA` schema-2 plan,
with `plannedAt` and per-file `expectedCorsOrigin`. Do not label a local file as
CDN verified before transport. Local admission returns `mediaPlanSHA256` only;
graph composition requires actual complete R2 and streamed CDN byte/hash/MIME/CORS
receipts. Independent sealing replays source/CDN evidence and requires a fresh
read-only R2 verification, sequentially outside the metadata reader lock. The
strict legacy publication-manifest validator remains unchanged.

Native route checks preserve the bounded composition disk-cache working set:
they may read valid cached objects but do not admit new disk entries during that
scope. Every read still checks its hash; mutable active pointers stay uncached.
Object/byte bounds, authorization, independent replay and activation are unchanged.

The changed-artwork transport field is `expectedPublicSHA256`; its source review
row separately uses `expectedOldPublicSHA256`. Both are `null` for a genuinely
new artwork. Existing artwork/topic hashes always come from the captured signed
parent, not a filename or a source checkout's assumed live state.

The operator's immutable metadata cache retains up to 8,192 small objects while
preserving the 64 MiB payload ceiling. The original 4,096-object ceiling evicted
part of a measured multi-phase working set, causing unnecessary signed point
reads during independent replay. A 5,000-object restart test covers retention;
byte bounds, account/bucket isolation, per-read SHA verification, corruption
recovery and uncached mutable production pointers remain enforced. This is a
local operator change, not a website release or an end-to-end speed guarantee.

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

## Subject first intake review — owner direction, 2026-11-04

Before freezing a capsule, inspect the actual incoming source pixels and compare
each title, alt and description with the image. Begin descriptions with the main
subject and visible action, or the identity and arrangement of a static object.
Clothing, tools and background are secondary details. A natural action title is
useful when it distinguishes the scene; preserve existing meaningful titles and
good descriptions. Follow `content/artwork-editorial.md` and the official product
identity workflow without adding unsupported model years, specifications or claims.

A model's semantic approval requires the actual pixels, exact source checksums
and concrete observations. A filename, prompt, regular expression or text gate is
not image evidence. Automated checks may verify binding, counts, duplication and
copy consistency, but cannot supply the missing visual judgment. No paid inference
is implicitly authorized by this policy.

Changing title, alt, description, topic or product identity invalidates the old
review fingerprint or token even if media hashes still match. Recheck affected
source pixels and final copy, then validate a newly bound review before admitting
the capsule. Preserve stable IDs, native media, accepted memberships and licenses.
Do not mutate a frozen capsule or the inputs of an active packet. A correction
after publication is a separate reviewed metadata delta against a freshly captured
signed parent, with the ordinary at most 256 changed artwork limit and all normal
activation and public verification gates.

Every affected topic needs two short, distinct paragraphs totaling 50 to 200 words.
The first sentence opens on that topic's actual visual character without a count.
Exactly one `{{artworkCount}}` in the inventory paragraph renders the accepted live
count; use the final resulting membership for append and merge checks. Describe
real available drawing types and differences, without invented classroom, craft
or packaging uses or a repeated generic opening. Refresh topic source and paragraph
review signatures when their bound metadata or wording changes. A catalog grounded
topic check is not a fresh visual review of all historical artwork.

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

Topic source/prose and complete search/category identity checks run before binary
transport too. An append must preserve all accepted categories and keywords unless
the complete affected member delta is explicitly supplied and reviewed. The same
gate remains in final graph composition; an accidental secondary-category omission
cannot silently alter discovery.

If a local process stops after all incoming media were uploaded but before a
prepared graph exists, use a NEW output directory and the normal operator with
`--reuse-incoming-receipt work/.../incoming-files-receipt.json`. The historical
receipt must cover the exact same account, bucket, Merkle root and every native
file path/key/byte/hash. It is only admission to the existing read-only verifier:
fresh scoped signed requests GET and hash every R2 object, check MIME and PDF
disposition, and reject missing or changed objects without PUT fallback. Normal
public CDN byte/MIME/CORS checks, native HTML checks, independent sealing and
conditional activation still follow. This avoids re-uploading identical binaries;
it does not trust old leases, skip current reads, enumerate the account or resume
an already activated release. Inspect the real active pointer before recovery.

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

## Recovering an already staged content packet

For a packet whose complete media and metadata receipts were saved but whose
independent sealing read failed before activation, run:

```sh
node --import ./scripts/catalog-snapshot/register-ts.mjs scripts/catalog-snapshot/resume-content.mjs STAGED_OUTPUT INSTALLED_SOFTWARE PUBLIC_CONFIG
```

The resumer revalidates the committed capsule and every native source, installed
software and exact production parent. It requires a complete remote receipt,
independently replays source and graph checks, and only then performs the ordinary
conditional activation and public page/media verification. It never uploads media
or metadata again. Completed output and private test packets are rejected before
network work. This is staged-before-activation recovery, not an instruction to
repeat an already activated transaction.

Only idempotent pinned metadata reads retry transient transport or HTTP
429/500/502/503/504 failures, at most three attempts with 200/400 ms backoff. Every
attempt receives a fresh exact scoped signature. Parent conflicts, authorization
failures and corrupted successful payloads fail closed without retries. The
mutable production pointer is never served from the immutable cache.
