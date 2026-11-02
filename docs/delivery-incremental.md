# Incremental owner-package publication

The guarded entry point remains `node scripts/deploy.mjs`. No new subscription,
public administrative endpoint or paid inference provider is involved.

## What can be reused

An append-only package may render only its new artwork/editor pairs. Home,
collections, browse/search data, counts, Studio manifests and sitemaps are built
from the complete current catalog. A metadata dependency comparison also
rerenders every existing pair whose complete Related/More like this snapshot
changes. It checks all cards, order, groups, copy, category and filter data,
including results beyond the initially visible thumbnails.

The production planner compares every previous metadata snapshot against the
current index, using the previous revision's taxonomy/card-summary data for the
previous index. This is a bounded metadata pass, not recompilation or rereading
all image/PDF bytes. New rules or a new review on an existing ID require the full
path, including when that ID previously had no override.

Reuse requires the accepted production report, its complete matching Merkle
manifest, an unchanged shared renderer/dependency inventory, unchanged accepted
artwork/identity/license records, and preserved image/download publication URLs.
Changing an existing artwork, template, style, server API, dependency, topic
identity or existing editorial dependency selects the normal full publication.
Unknown or missing evidence also selects full publication. An environment variable
cannot silently narrow the guarded publisher's scope.

The only normalized renderer differences are the exact server-only scope wrapper
on the two artwork templates and the inheritance integration. Other template
differences invalidate reuse. The current software and catalog state are bound to
the plan and rechecked before artifact verification and activation.

## Filesystem verification

`.asset-integrity/` is private, ignored local state. Its records are authenticated
with a local 0600 key and bind the expected SHA-256 and byte count to the canonical
path, filesystem device, inode, size, and nanosecond modification/change times.
A missing, corrupted, unauthenticated or invalidated record requires a full byte
hash. Restoring modification time alone cannot approve an edit. A replacement
image or changed expected hash invalidates the record. This is not an editorial
review and never invents image observations.

The first incremental operation seals the previous verified full output in
`work/delivery/<revision>/full-source/`. Copy-on-write copies preserve the rollback
build without hard-linking mutable candidate HTML to it. The copy operation checks
the verified source before and after copying, and records the resulting identity.
Missing or altered baseline files stop inheritance. Preserve this full source,
its manifest, journal and marker during cleanup; deleting the optimization cache
is safe but makes the next verification slower. Do not publish or disclose the
local cache key. The cache never goes in `public/`, Pages or R2.

Later sealed snapshots may share unchanged, read-only files with a prior frozen
snapshot after exact hash/size/MIME verification. Only frozen rollback trees can
share these inodes. A mutable build always receives a separate writable copy.
New/changed files remain independent; a full logical rollback tree is retained
without duplicating the entire unchanged binary library at every upload.

## Remote verification and release write authorization

Latest owner decision, 2026-11-02: the local 10 TB operational storage budget and
extra capacity allowance have been removed for this and future UltraClipart
uploads. A complete-account storage census is no longer a write prerequisite.
This is a local publisher policy; it does not change Cloudflare technical limits
or usage billing. See `docs/delivery-storage-owner-unlimited.md`.

Every private write is authenticated by a fresh HMAC authorization, valid for at
most 45 seconds. It binds the account, target bucket, exact reviewed Merkle root,
revision and complete release byte total. The session exposes only the target
bucket binding. It cannot write arbitrary content or another release. Actor,
request-body, per-file and PDF byte bounds remain in effect. No account occupancy
is inferred: current receipts explicitly record `accountUsageMeasured: false`.
Historical schema-2 account-inventory receipts remain historical evidence; new
media receipts use schema 3 with exact per-object independent readback evidence.
The old S3/REST ingest command is disabled and directs callers to the reviewed
binding path, avoiding an ambiguous existence/overwrite check.

New HTML defaults to the exact local compressed payload instead of first asking
the still-live predecessor for different page bytes. Merkle, native checksum,
conditional creation and independent R2 readback still verify every file.
`UC_DELIVERY_LOCAL_HTML=0` retains the earlier source preference when needed.

The private `/verify` endpoint cannot PUT, delete, fetch public fallback sources
or authorize writes. It accepts only fresh signed read commands for the
fixed release and per-record Merkle proofs. Previous byte-readback receipts must
match the accepted predecessor's manifest/root, exact source hash, size, MIME and
key. Their validators are pinned into a second fixed Merkle root for the session.

An authorized conditional R2 GET can reuse a previous byte proof only when R2
returns the exact same current ETag without a body, with matching size and MIME.
It uses direct bucket bindings, never CDN metadata or a custom `sha256` label.
An absent/changed validator requires an actual full body hash. Missing objects
join the ordinary write queue; corrupt bodies/metadata or malformed proofs stop
publication. Receipts distinguish inherited byte evidence from a fresh body hash.

Only files needing writes enter release-scoped staging. The single account
writer, conditional creation, native R2 SHA-256 validation and independent
post-write body readback remain mandatory. Existing read-only checks do not
measure total account capacity. A failed or incomplete object verification stops
publication; removing the storage budget does not approve content or activate a
partially staged release.

## Complete activation, honest revisions and recovery

The complete current manifest contains both exact inherited objects and verified
new objects. The publisher still requires every current art/editor pair, original
image policy, source/editorial gates, complete SEO/link audits, unit tests, security
headers and final Pages/Worker budgets. No staged file is called live.

The newly activated Worker owns one atomic release. It maps each unchanged ID to
its proven artifact revision and each new pair to the new revision. Cache isolation
uses the active release; `X-UC-Delivery` reports the actual artifact revision.
Withdrawn/unknown artwork retains real 404 behavior, missing active objects return
uncacheable 503, and editor noindex/CSP remain intact. Existing immutable runtime
assets are retained for inherited pages. Rendered artifact metadata must not be
rewritten merely to manufacture a new revision.

The unchanged recommendation snapshot's global catalog marker is refreshed only
in its HTTP representation, with a bounded native HTMLRewriter. Card contents,
order, descriptions and the immutable R2 source bytes stay exact. Representation
ETags/cache isolation, HEAD and conditional requests reflect this version. The
same transformation is modeled in local preview and tested against real workerd,
including browsers with no Referer. This prevents the existing client from hiding
valid old recommendations after a global catalog update. A signed plan binds
new/affected IDs, source state and related version; test/shadow plans cannot activate.

Schema attachment reuses the already-attached metadata of exact inherited HTML,
after its signed plan and local source identity are verified. A changed inherited
file is rejected. Only new/affected and global pages need schema attachment again;
the full current image, link-graph and core SEO audits still run. Reports separate
reused pages from freshly parsed pages and do not invent old image-instance counts.

IndexNow reuses an unchanged page's meaningful-content fingerprint only from the
matching predecessor snapshot/root. It checks new/changed pages normally. Missing
snapshot evidence causes a local byte read, never an unverified notification.
The accepted `.indexnow` ledger and notification-only retry policy are unchanged.

Set `UC_DELIVERY_INCREMENTAL=0` for a normal full build. Set
`UC_DELIVERY_VERIFY_EXISTING=0` to verify existing objects through staging instead of the dedicated read path.
Either fallback retains the same source, integrity and release-authorization gates. No automatic production build
is re-enabled. This work does not make the site ready for five million artworks;
catalog/search/Studio database and shard budgets still apply.

The installer defaults to full publication until a successful shadow/test
certificate matches the exact publisher software hash. Changing that software
invalidates automatic incremental activation. A separate whole-publication lock
serializes builds and activation across local checkouts without deadlocking the
shorter child R2 writer lock; neither lock deletes an occupied/stale lock.

## Validation

`tests/delivery-incremental.mjs` covers append-only eligibility, renderer/identity
invalidation, complete byte inheritance, rollback isolation, routing, cache
separation and withdrawals. `tests/verified-source-cache.mjs` covers edited,
replaced, timestamp-restored and forged cache cases. The verification/reuse tests
cover bad proofs, stale scope, missing/corrupt objects and incomplete receipts.
`node tests/e2e/delivery-staging-local.mjs` exercises the actual workerd engine
with isolated local R2, including conditional reuse, fresh release-authorized upload and
native checksum rejection. It uses no Cloudflare account or external request.

A full-size local shadow build and complete checks are required before declaring
this installer ready. A local/shadow check is not production publication or an
end-to-end network speed guarantee; measure a future authorized package separately.

The Surprise me update changes a shared browser runtime, so its first software
release deliberately takes the full-render path. After the verified new baseline
is sealed and the installation proof passes, append-only content packages can
use incremental compilation. Source/software/template changes still invalidate
reuse. Local publisher installation is separate from the website's public Worker
and runtime deployment.

## Schema-2 local verification — 2026-11-02

The local installer is bound to publisher software SHA-256
`dab4d206b1ccab18e9a23eb1aeadb31eff872c19166b3cd920b3ff55f8bc5555` and
the runtime and native copy backend recorded in
`config/incremental-publisher.json`. Its accepted evidence is
`docs/delivery-incremental-verification-20261102.json`, SHA-256
`ac18fce62bcfff84c69b99836044d2658337226d9406e3a673a78c1dc8dae2b4`.
Changed publisher software, runtime, native binary, test sources or missing
evidence disable this installation and select the normal guarded full path.

Against the verified 33,209-artwork production baseline `118c9ae`, the held
local shadow selected 50 artworks, rendered 100 art/editor pages and verified
66,318 inherited art/editor pages. It passed 272 focused tests, two local
workerd/R2 checks, eight Chromium/WebKit scenarios and complete image, link and
core SEO audits of 67,096 pages. The shadow was publication-blocked and made no
production writes. These results are not a website deployment, a future upload
time guarantee or proof that the site already scales to five million artworks.

The detailed, hash-verified evidence capsule is preserved at
`work/imports/owner-75-combined-20261101/private-installer-s-bind-20261102/schema2-evidence-3b234be-20261102`
and independently at
`/Users/melihozcan/Documents/UltraClipart-Publisher-KEEP/recert-evidence-3b234be-20261102`;
both have manifest SHA-256
`ab6ab36b4428f6193bffe85a4d461d1636c38863de1449112a24b0a2798d02f9`.
The copied clone journal is archival evidence and was not itself bound by the
original shadow report. Normal source review, owner approval, single-writer,
exact-byte, staging, readback and activation checks remain mandatory.

Primary references checked 2026-10-30:

- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/workers/platform/limits/
