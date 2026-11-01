# Owner direction: storage budget for UltraClipart publication

Recorded 2026-11-02. The owner has removed the publisher's self-imposed 10 TB
aggregate storage ceiling and the proposed additional 1 TB safety reserve for
this and future uploads. Do not introduce a replacement aggregate storage quota
or require a complete account-wide inventory solely to grant a storage-budget
reservation. The earlier 10 TB plus 1 TB v2 proposal is superseded and must not
be activated.

The publisher implements this policy through a manifest-bound, fresh signed
release authorization rather than a storage occupancy estimate. Local focused
regressions and the real workerd/R2 test exercise writes, conditional collisions,
full-body readback and source corruption without external requests. Production
transfer and live activation remain separate evidence; these tests do not certify
that the 75 collections are live. The current guide is `docs/r2-ingestion.md`;
its older quota sections are explicitly historical.

## What this decision does and does not mean

- An account usage value that has not been measured is **unknown**. Do not
  report it as zero, below a former limit, or verified unlimited. Do not use a
  stale or partial roster as evidence that an object or bucket is absent.
- Removing an application budget does not change Cloudflare's service limits,
  billing, availability or account settings. Per-object size, request and
  upload limits still apply. R2 storage and operations may incur charges. The
  current provider documentation is the authority for [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
  and [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- The owner's decision concerns the publisher's aggregate storage-budget gate.
  It does not authorize disabling unrelated Pages, Worker, request-body,
  per-file or PDF quality/size limits, adjusting subscriptions, deleting data,
  loosening editorial review or bypassing release verification.

## Required protections for subsequent releases

Keep the single coordinated account writer lock and its existing fail-closed
behavior. The local lock cannot serialize an independent writer on another
machine; coordinate such writers and do not claim it provides global exclusion.

Preserve source-bound visual and editorial review, exact source-image identity,
the applicable image/PDF pairing and repair decisions, stable IDs and URLs,
immutable content-addressed keys, manifest/Merkle checks, source size and full
SHA-256 checks, authorized signed release requests, bounded concurrency,
independent remote readback and full hash verification. Existing reviewed
exceptions must remain accurately labeled: an unperformed PDF comparison is
not a passed comparison. A targeted object-existence check or readback remains
necessary where required for collision protection; absence of an account-wide
census is not permission to overwrite an unknown object.

Retain the normal build, security and integration tests, current production
baseline and rollback evidence. Verify successful Cloudflare production,
collection and artwork pages, and representative or release-required
image/PDF downloads before calling a publication live. Keep IndexNow state,
publisher backups, credentials and native sources protected according to the
existing preservation policy.

Any new signed release-authorization path must bind the reviewed account,
target, release and exact manifest/request to its trusted signer, reject stale
or altered requests, and fail closed. Validate replay/race behavior, concurrent
writers, resume and readback in isolation before use. This note does not by
itself certify such an implementation.
