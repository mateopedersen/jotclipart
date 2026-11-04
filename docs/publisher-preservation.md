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

The local incremental installer was revalidated on 2026-11-02 against the
33,209-artwork production baseline. Its exact software and runtime are bound by
`config/incremental-publisher.json`; see
`docs/delivery-incremental-verification-20261102.json` and
`docs/delivery-incremental.md` for the actual measured scope and limits. The
test catalog was publication-blocked and made no remote writes. A successful
local installation is distinct from a successful website publication. Preserve
the current independent live receipt and never publish the shadow build.

The full private test evidence is independently preserved in the protected
`recert-evidence-3b234be-20261102` directory under KEEP and in the accepted
repository's matching private import directory. Both capsules have manifest
SHA-256 `ab6ab36b4428f6193bffe85a4d461d1636c38863de1449112a24b0a2798d02f9`.
The regular KEEP snapshot and a separate isolated restore verification remain
necessary after committing an installer change; the evidence capsule alone is
not a source backup or a replacement for native originals and rollback assets.

## Build-free runtime preservation, 2026-11-04

The installed template/runtime package is permanent publisher state. Do not
delete the current software directory named by `config/content-publisher.json`
just because it is under work/. Content-only publication uses it without rebuilding
the catalog. The live data epoch and software/control revision can differ.

The former ccb5 rollback's 71,418 expanded art/editor HTML copies were losslessly
packed, verified member by member against its remote byte-verified manifest and
sample-restored before removing only those redundant expanded copies. The exact
archive and restore guide remain in `work/delivery/ccb5c2c9804c863b00071ddb5f71df0d860857df/rollback-html-preserved/`
and in immutable `UltraClipart-Publisher-KEEP/rollback-ccb5-html-20261104`.
Restore art/edit from that archive before an intentionally requested legacy full
rollback. Non-HTML fallback assets, native art/PDFs and all receipts remain intact.

The installed ee55 runtime and complete small public package are independently
archived in `UltraClipart-Publisher-KEEP/installed-content-runtime-ee55-20261104`.
Read its manifest and restore guide. Credentials and the owner signing key are
not in that capsule. Preserve later installed-runtime capsules too. This is a
local independent backup, not an off-device backup. Restoration never publishes.

Archive-backed extraction cleanup also retains the complete private native ZIPs.
Every removed expanded source is mapped to its exact archive SHA-256, member
name, member SHA-256 and byte size in
`work/catalog-snapshot/disk-cleanup-archive-backed.jsonl`. Unmatched files were
kept. `scripts/catalog-snapshot/restore-extracted-source.py` can restore a single
member to a NEW protected work path after verifying both archive and source.
A real PDF and WebP were restored and compared before removing only those
disposable restored test copies. Preserve this journal and the private native
ZIP directory; a cleanup record is not permission to delete the archives.

## Verified first-visit runtime, 2026-11-05

The installed 7f4cd45 runtime and exact production package are protected in
`work/catalog-snapshot/preserved-installed-runtime-first-visit-20261105` and
`UltraClipart-Publisher-KEEP/installed-content-runtime-7f4cd45-20261105`.
All 11,746 archive members were SHA/byte verified locally and in the independent
copy; archive SHA256 is
`8465a0bbf34d5c2c9cf9be0f30076c37d6d3d506a884e2d0f6f41bda33a4a35d`.
The independent directory has the user-immutable flag. No private operator session,
credentials, environment file or signing key was copied. Restore only to a NEW
private directory after manifest verification, never over an active publisher.
Compiler source-input absolute paths require deliberate relocation/recompilation
from matching source; changing digests is not a valid restore. A separate dated
Git/source backup and its verification are recorded in the final proof directory's
`backup-verification.json`. The compact runtime archive does not replace native
originals, source-bound reviews, protected IndexNow, current/previous complete
rollback or the untouched 4755 owner-protected backup. Restoration never publishes.
