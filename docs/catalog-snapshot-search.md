# Source-bound snapshot search integration

This serving interface accompanies the coordinated seven-facet catalog migration.
It is not a production signer, upload authorization, publication approval or a new
visual review. The sole publisher must supply a complete authenticated snapshot.
Private fixture roots are rejected by default; local test opt-in must never be
wired into a production route. Preserve original R2 media and existing URLs.

## Shared serving contract

`server/catalog-search/api.mjs` exposes a factory. Inject the canonical
`captureAuthorizedSnapshot` and its private R2 binding. The context uses the exact
captured `rootSHA256`, `snapshot.indexes.search`, and
`authorizationVerified: true` from that verifier. The factory never generates
that approval. The canonical source, graph, media, ABI and signed account/bucket
scope gates remain required before activation.

Serve `manifest()` at `/search-data/manifest.json`, `post()` at
`/catalog-search.json`, `studioManifest()` at `/studio-manifest.json`, and
`studioCatalog()` at `/studio-featured.json`. Responses are private/no-store.
POST requests carry the full 64-character root, not a truncated revision.
Personal favorite IDs are in bounded POST bodies, never public cache keys.
Foreign browser origins, bodies over 32 KiB and more than 128 IDs are rejected.

The API captures once per request and shares a four-connection budget through
body consumption across search and directory providers. Combined reads stop at
8,000 objects / 128 MiB. Immutable metadata is independently length/SHA checked.
Corruption returns 503, root changes return 409, absent provider capabilities
return 501, and only genuinely absent or withdrawn IDs return null. No partial
result is relabeled as a valid empty search or deleted favorite.

`SearchRepository` detects the optional `snapshot-search-v1` manifest transport.
Without it, existing static `/search-data/` behavior remains. Conflict recovery
refreshes once. The shared directory alignment helper prevents old site entries
being combined with new artwork after a retry. B&W retains 24 results; the main
Studio library keeps its 4/6-card page; the composer has 24-item pages. Studio
selection pins the result's root and resolves original URL/size/SHA facts again;
a changed source rejects the add without substituting a different file.

## Source compiler and normal imports

`index.mjs` and `store.mjs` are the stable-number incremental search writer and
bounded immutable structures. `runtime.mjs` is the Web API reader. Writer imports
resolve from `server/catalog-search/` to `../../src/lib/`; these canonical files
are independent of the ignored experiment's old relative paths. The shared
language, card facts, publication comparator and schema are ABI inputs. Rebuild
and hash the actual canonical files and browser entry points when integrating;
never copy a historical bundled renderer over newer source.

The writer currently emits the explicitly private research protocol and
`PRIVATE_UNPUBLISHABLE` marker. Those records and private seven-facet fixtures
cannot be activated by stripping markers. The normal authorized publisher must
construct and independently verify its production output under its source/ABI
contract. This package does not certify that final integration or activation.

The document ledger carries source-bound Studio representations and exact
monochrome-kind/raster/style facets. `ui-metadata.mjs` attaches site entries,
monochrome directory, categories and featured IDs to the exact bare search data
root. Use the actual shared site-search/category/monochrome/Studio helpers against
the checksum-verified public resolver; raw incoming metadata is not equivalent.
Each incremental data update drops old UI bindings and reports
`uiRefreshRequired`. Regenerate those small directory inputs and reattach before
publishing. Missing or mismatched bindings fail closed. No full catalog is loaded
into a request Worker. A once-only 37,937-record bootstrap is not a normal import
path and is not evidence for a five-million-record Studio.

Search page seed/version and color/style controls must come from the captured
root and its facet names in the combined renderer. Its bounded private SSR test
fixtures are deliberately not deployable website renderers. `/new` uses the same
publication comparator and newest search order; do not replace original media
with thumbnails on indexable pages.

## Executed checks and boundaries

Permanent transport/source/directory/favorites tests cover legacy compatibility,
root conflicts, cancellation, ID order, real missing IDs, bad endpoints and source
policy. `tests/catalog-snapshot-api.mjs` performs 11 private in-memory protocol
cases using 32 catalog records; its fake trusted context is not an authorization
receipt. Complete local R2 tests, the source provenance manifest, 95 semantic
comparisons and seven actual corruption/restore cases are in the coordinated
handoff. Chromium and WebKit cover real source Search/Favorites/B&W pages and
explicit minimal Studio library/composer DOM fixtures. Canvas, exports, final
remote CPU/latency, complete production graph receipts and live verification
remain separate checks owned by the combined publisher.

Do not submit Search Console, Bing or IndexNow as part of this migration.
