# Request-local search startup

Keep the signed search format, public source identity, ranking, counts, filters,
pagination and immutable-byte checks unchanged. Never cache visitor query inputs
or personalized result bodies in a shared cache.

Posting pages, facet pages, distinct card blocks and multiword forward blocks
can be read concurrently through `mapFour`. The existing shared four-connection
body-consumption budget still owns the actual R2 requests. Result order remains
deterministic; parallel work must not change tie ordering or suppress errors.

Single-term searches first try a bounded ordered prefix. For at most 512 eligible
matches, a long global walk falls back to only their verified forward blocks and
the existing title/date/document-number comparator. Broad candidate sets retain
the streaming ordered index. Do not always read sparse forward blocks: dispersed
camera matches can make that slower than the short ordered path.

The 2026-11-04 comparison used the actual frozen production search bytes. Ten
queries compared the complete old and new JSON results, including USA, camera,
monochrome camera, Qatar flag, a long phrase, title/newest pagination and a typo.
USA point reads dropped from 347 to 37. Some other queries perform a few duplicate
small map reads while running concurrently; do not describe every query as using
fewer objects. Local file timing is not a network or PageSpeed measurement.

Run `tests/catalog-search-latency.mjs` for zero/one/512/513 candidates, tie order,
scope, fuzzy/phrase results, corruption rejection and the four-read bound. Run
the actual mobile/desktop query UI against the release before claiming a live
latency improvement.

The original Inter WOFF2 remains byte-identical. `font-display: swap` lets a late
font replace the fallback in both engines; `optional` could leave Chrome using
fallback glyphs and WebKit reporting a font error. A local 350 ms delayed-font
fixture reproduced the difference and matched the two engines after the change.
Font families, weight rules, Avenir and the separate reading/editor faces remain
unchanged.
