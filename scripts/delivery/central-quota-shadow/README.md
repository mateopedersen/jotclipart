# Private R2 capacity authority: local shadow

This directory is an isolated implementation and test fixture. It is **not installed in Cloudflare**, is not connected to the publisher, exposes no public route and never grants permission to write R2. Its results are not a replacement for the publisher's existing complete-account inventory, 45-second freshness rule, 10 TB operational limit or single-writer guard. The limit here is an owner-selected account budget, not an R2 platform limit.

## What is implemented

- `authority.mjs` is a named, account-scoped Durable Object with SQLite transactions for a baseline, capacity reservations, state transitions, commands and journal events. The public Worker returns 404. The authority requires the configured account name and default Durable Object jurisdiction. Helper methods are private rather than remotely callable RPC methods.
- `protocol.mjs` constrains input and authenticates short-lived HMAC commands under separate auditor, writer, verifier and viewer roles. Request payloads, identities and idempotency keys are checked. These roles and their keys are a design boundary; production-grade key distribution and isolation are **not** set up here.
- `shadow-verifier.mjs` is an independently invoked shadow verifier. It retrieves a selected R2 object through an injected bucket, reads its whole body up to 8 MB, verifies the expected SHA-256 and submits a separate verifier receipt. It does not authorize a transfer, prove that another writer cannot overwrite the object, or establish a physical-print or editorial result.
- `local-workerd.test.mjs` runs an isolated Cloudflare workerd, SQLite and, for one test, a local R2 fixture. The account ID, objects and role keys are synthetic. External requests are rejected; the only network use is local loopback for the fixture. No Cloudflare account credentials are read.

The state flow is `RESERVED → STARTED → COMMITTED` or `RESERVED → CANCELLED`. The full requested size is held before a hypothetical write. Once started, a reservation cannot be cancelled merely because an object is absent or a request timed out: a delayed write may still finish. Only a trusted independent verification can complete it. Actual committed bytes are added without credit for overwritten versions; deletion does not free capacity here. Replays report the reservation's current state, so replaying an old reservation request cannot revive a cancelled one. Transactions roll back partial operations. Balances and selected state invariants are checked at startup and on audit; a mismatch blocks the object.

These checks do not detect a complete database rollback that is internally consistent but no longer matches R2. An absent object also does not prove an in-flight write will never finish. Recovery must retain uncertain holds until a fenced reconciliation establishes both the object state and that no corresponding write can still complete. No automated timeout release is implemented.

## Run the isolated tests

From this repository, using the pinned dependencies and Node version required by `package.json`:

```sh
node --test scripts/delivery/central-quota-shadow/local-workerd.test.mjs
```

Local loopback must be available for workerd. The suite checks role separation, malformed and stale requests, fixed account identity, capacity under concurrent reservations, restart and replay, rollback after a forced SQLite error, integrity failures, key encoding, and whole-object readback with missing, oversized and wrong-content negatives. The test-only R2 fixture is not a real account, and the suite is not evidence about external clients, actual user traffic or live Cloudflare capacity.

## Conditions before any live design can replace the current guard

1. Enumerate and independently audit **all** account write paths, credentials, users, Worker and Pages bindings, S3 clients, multipart operations, bucket creation and relevant jurisdictions. Current observations include JotColoring and TemplateAtlas paths outside this publisher; token-scope metadata returned 403, so coverage is presently unknown.
2. Coordinate a real fence for those paths, settle in-flight writes and obtain a current complete all-jurisdiction baseline while the fence is active. The three baseline hashes accepted by this shadow are attestations, not evidence that a fence or complete inventory existed.
3. Design and test a real write gateway with role-isolated verifier credentials, bounded streaming, bucket/key/account checks and authoritative full-object readback. Prevent bypasses and account for multipart writes, overwrite/delete races and delayed completion. This directory has no write gateway or live R2 bindings.
4. Provide an independently protected monotonic checkpoint and recovery procedure for Durable Object rollback, restore, lost storage and uncertain outcomes, plus a tested bootstrap and periodic reconciliation. R2 event notifications can inform this process but do not independently prove a pre-write reservation or complete inventory.
5. Review operational cost and deployment settings, perform an isolated integration and adversarial failure tests, obtain the necessary coordinated authorization, and explicitly update the owner policy before considering any change to the current guard. Until then, retain the existing publisher workflow unchanged.

Cloudflare references: [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Durable Object IDs](https://developers.cloudflare.com/durable-objects/api/id/), and [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/).
