# Publisher preservation

Owner instruction, 2026-10-30: deleting a Codex chat or cleaning the Mac must not
delete the UltraClipart compiler/publisher. This is permanent application source,
not disposable build output.

Protected independent backup:

`/Users/melihozcan/Documents/UltraClipart-Publisher-KEEP`

It is deliberately outside Codex's chat, project, worktree and cache directories.
Completed snapshots receive the macOS user-immutable file flag. Keep that lock;
do not clear it merely to make general cleanup succeed. The root stays writable
so new versioned snapshots can be added without overwriting earlier ones.
Never include this directory in a general cleanup. An explicit instruction to
delete this particular backup would be a separate decision. The backup is local;
it does not protect against loss of the Mac or intentional deletion of Documents.

## What must survive

- The accepted publisher Git history, source code, pinned dependencies, catalog,
  publication manifest, source-bound editorial reviews and tests.
- Owner-supplied native assets and image review evidence. A checksum-verified
  remote copy does not automatically authorize deleting private native originals.
- The shared `.indexnow` accepted ledger and receipts. Never initialize a new
  ledger merely because a chat/worktree was removed.
- Current verified production records, delivery manifests/readback receipts and
  the last verified full rollback source. These are not arbitrary old builds.
- Current pending work and its continuation notes. An unfinished incremental
  publisher must not be represented as a completed installation.

Only recreateable caches, dependencies and unneeded build outputs are cleanup
candidates, after confirming that no active writer depends on them and that a
verified restore/rollback path remains. Never delete a worktree containing the
sole accepted source or rely on chat history as a backup.

## Refresh the independent backup

From the accepted repository, run its supported Node runtime with:

```sh
node scripts/delivery/backup.mjs /Users/melihozcan/Documents/UltraClipart-Publisher-KEEP
```

This is a local backup operation only: no deployment, credentials, remote upload,
inference or subscription change. It creates a new dated snapshot without
overwriting earlier snapshots and checks the source/ledger stayed unchanged
during copying. It includes a Git bundle, source archive, pending tracked patch,
standalone Node executable, allowlisted publication evidence and the shared
IndexNow ledger. It excludes `.env`, OAuth sessions, `.wrangler`, signing keys,
node_modules, dist and the large original binary library from the filesystem
copy. Git history is preserved as local owner data and must not be published.

Each snapshot contains independent verification and restoration instructions.
Restoration does not automatically publish anything. Restored approval records
are historical evidence, not new authorization to deploy. Check the actual live
revision and single-writer locks before resuming. Reauthenticate with Cloudflare
locally when required; credentials must never be written into this backup.

The local incremental installer passed the full-size isolated shadow, 100 unit
fixtures, 8 real-catalog Chromium/WebKit scenarios and both native workerd/R2
checks on 2026-10-30. Its exact software hash is bound by
`config/incremental-publisher.json`; see
`docs/delivery-incremental-verification-20261030.json` for measured scope and limits.
The test catalog was publication-blocked and made no remote writes. A successful
local installation is distinct from a successful website publication. Preserve
the current independent live receipt and never publish the shadow build.
