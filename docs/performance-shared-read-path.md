# Shared public read path — 2026-11-04

The owner reported slow navigation, image display, Edit and search even on a
fast connection. Actual DDF production measurements showed about 1.55 seconds
for the search manifest followed by 1.27 seconds for an 845 KB / 2,847-entry
public source directory. A local matching run took 18–38 ms; it is not a phone
CPU measurement. These observations explain why reducing image quality or
removing features would not repair the metadata dependency chain.

Only hash-addressed catalog JSON is reused in the edge Cache API. The response
is verified against its key before admission and again after retrieval. The
existing 16 MB memory cache and four body-consuming connection budget remain.
Cache failure falls back to checksum-verified R2; corruption never becomes a
successful substitute. Publication control stays fresh on every request. No
visitor query, Favorites, project, generation result, cookie/session response,
original image or PDF is added to this shared metadata cache.

The immutable directory GET is `/search-data/{verifiedRoot}/site.json`. It uses
captured authorization, rejects a different current root, validates all entries,
and may be reused by browsers and the edge for that exact root. The previous
private/no-store POST operation remains compatible. The suggestion controller
can load this public directory on input focus and show direct subject links
before the full artwork/monochrome manifest arrives. After 30 seconds or a
BFCache restoration, the normal fresh-manifest route replaces the page seed.
Ready direct matches do not wait for the artwork debounce. Late data may not
remove a native pointer or keyboard target. Full results and source alignment
remain intact.

Independent directory pages use at most four concurrent verified reads and are
reassembled in the exact original order, including offset and membership checks.
Catalog JSON may be gzip compressed in transport; decoded bytes and no-store
policies are unchanged. Images, PDFs, ranges, errors and Set-Cookie responses
remain outside the new JSON compressor.

Every native document preloads only its own declared same-revision module
entries. Explicit Edit pages additionally preload the editor entry's static
module graph. Dynamic export-only modules stay lazy, and Create still waits for
its workspace to approach the viewport. The compiler checks every preload against
its actual output and bounded size. Cookie-band measurement writes are deduplicated
and scheduled outside ResizeObserver delivery. The earlier source performed five
synchronous root writes in each native-engine fixture; the new source performed zero.

AI Builder is rendered through the same source-bound shell and current counts.
Its SEO text describes existing functionality and limitations. Existing idea
pictures remain subject references, not alleged AI outputs. No model invocation,
paid inference, billing change or search-engine submission is authorized by this
performance/SEO release.

Permanent checks cover immutable cache isolation/repair, fresh publication control,
root-addressed directories, private POST compatibility, query exclusion, transport
compression, bounded ordered reads, native input races, lifecycle restoration,
module preload graphs and cookie resize behavior. Native workerd and actual
production browser checks are required before claiming the update is live.

Primary references consulted: [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
and [execution context](https://developers.cloudflare.com/workers/runtime-apis/context/).
Cache API contents are local to a data center; this is not a promise of an instant
first visit in every region. Public title and description work follows
[Google title guidance](https://developers.google.com/search/docs/appearance/title-link)
and [snippet guidance](https://developers.google.com/search/docs/appearance/snippet).
No ranking or PageSpeed 100 guarantee is made.
