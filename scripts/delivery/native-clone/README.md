# Native independent copies

On macOS arm64, `independent-copy.mjs` uses the pinned Node-API 8 module in
this directory to call `fclonefileat` with open file and directory descriptors.
Each clone has a distinct inode. The caller's existing manifest or authenticated
source cache remains responsible for content verification. A clone is not a
publication, source approval or a hard link.

The module, C source, local build recipe and the vendored Node 24.19.0 Node-API
headers and their license are part of the publisher source and software hash.
The loader verifies their recorded SHA-256 values before loading the binary from
its already opened file descriptor. Do not replace an attested binary silently.

To check whether an existing macOS arm64 Apple Command Line Tools installation
reproduces the binary, run `build-private.sh` with an existing **absolute,
canonical and empty output directory**. The recipe uses only local files; it
refuses an existing output and requires the resulting binary to match the pinned
digest. A changed toolchain may produce different bytes, in which case stop and
review/re-attest the new build. Keep this source and the binary in the protected
Git-backed independent publisher backup.

The shared copier defaults to no physical fallback on macOS. Its optional
fallback is limited by both the requested cumulative budget and measured free
space, with a five-GiB default reserve checked at each copy. The Linux backend
uses descriptor-anchored `/proc/self/fd` paths and tries an exclusive reflink
before a bounded physical copy; its platform-specific test must run on Linux
before asserting Linux deployment coverage.

A future incremental certificate must record the tested platform, architecture,
Node-API level, copy backend and (on macOS) native binary SHA-256. Its evidence
also needs the independent-copy probe; on macOS the probe must include a real
compressed-file round trip. Run that fixture on a permitted macOS host with
`UC_ALLOW_HFS_COMPRESSION_FIXTURE=1` when collecting the evidence. None of this
enables the current older certificate or substitutes for a guarded full build.
