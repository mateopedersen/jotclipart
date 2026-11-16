# Browser-origin work transfer

`public/move-your-work/` is a standalone, noindex transfer page. It does not load
Astro, call an API, post to a cloud service, read cookies, use sessionStorage, or
put work in query parameters. Its Inter font is embedded. The old origin must
serve this page temporarily for the user's original browser/profile to read its
own saved work. A new origin cannot read the old origin's private storage.

The source enforces exact localStorage names and bounded editor/checkpoint
patterns from the existing application code. IndexedDB scope is only
`ultraclipart-studio/projects` and `ultraclipart-ai-history/images`. Temporary AI
handoffs/leases are excluded. Public-share removal keys in `uc-public-shares-v1`
require a separate unchecked-by-default choice for both export and restoration.
These capabilities are not cookies or server session secrets; they must be kept
private. Only the validated share URL field is adapted to JotClipart, retaining
share IDs, titles and deletion capabilities.

A user button starts each read or write. The exported JSON has a SHA-256 over its canonical metadata/payload envelope
(excluding the checksum field itself), plus per-binary hashes. The graph codec preserves Blob/File bytes and
metadata, ArrayBuffer/typed-view offsets and identity, sparse arrays, dates,
undefined, big integers, Map/Set values and cyclic references. Identical bytes
are deduplicated in the file without aliasing independent buffers on restore.
Limits are 128 MiB of decoded source data, 192 MiB file size, 32 MiB per binary,
12,000 records and 200,000 graph nodes. A limit or unsupported storage key stops
the operation; it never silently drops a project. The JSON is not encrypted.

Import validates the whole envelope, binary hashes and scope before restoring.
Favorites and safe unique board entries merge by stable ID. Existing notes,
projects, ownership keys and AI images are not blindly replaced. Conflicting
incoming versions are retained in a separate local conflict database, checked
by reading them back; this is downloadable through the page. Editor records
also use the existing `validateDocument` predicate. Application SVG/raster/source
validation still applies when Studio opens a project. Unknown/unsupported
project records are preserved separately instead of being activated.

IDB writes use add-only transactions, so another tab's newly created record
cannot be overwritten. Added data and conflict archives receive checksum
read-back. Local writes compare the destination immediately before writing and
read the value back afterward. A stopped partial import leaves original data
and the user's original backup file intact; repeating it deduplicates identical
records. No store is cleared and no existing record is deleted. Expiry dates and
recovery revisions are literal; normal AI history expiry is not reset.

Build and focused checks:

```sh
node scripts/jotclipart/portability-build.mjs
node --test scripts/jotclipart/portability-tests.mjs
```

The public module is the tested compiled artifact. The 16 pure checks cover
binary/graph integrity, corruption, prototype safety, scope, IDs/layers/hashes,
merge/conflict behavior and explicit capability consent. They are not actual
browser IndexedDB tests. `work/jotclipart-build/portability-{source,destination}-synthetic.json`
are private synthetic fixtures for the separate browser flow, not user data or
real AI generations. Use two isolated local origins to test storage isolation
and real import/export before operating on any owner's real origin. Actual
owner export/import and production browser checks remain separate release gates.

Recommended response headers for this standalone route are `Cache-Control:
no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy:
no-referrer` and a policy allowing only its own external script, inline styles
and embedded fonts, with `connect-src 'none'` and `frame-ancestors 'none'`.
