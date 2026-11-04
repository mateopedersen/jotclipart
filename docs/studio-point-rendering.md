# Point-rendered editor startup

The editor document must resolve its selected artwork and original/preview source
decisions through the signed catalog snapshot. It must not hydrate all 500
featured artwork records merely to print the Featured count.

`readStudioFeaturedCount` validates the bounded immutable featured ID directory
and supplies its actual length to `getFeaturedStudioCount`. The editor compiler
reads this request-local count; the normal static and creation renderers retain
their existing featured inventory. The separate Studio library request still
resolves real source-bound artwork, paginates its previews and verifies originals
before editing or exporting. Never substitute this count for artwork validation.

The same count provider serves the create landing page. Its hero and element
library labels must not resolve 500 unrelated source records before rendering.
Keep the existing starter compositions, static hero artwork and independent
client library request intact.

The matching create-page comparison reduced 756 immutable metadata reads
(13,262,649 bytes) to 113 (1,584,734 bytes), preserving all 52 static artwork
records, starter composition previews, discovery, counts and page properties.

The 2026-11-04 source-bound local comparison of the same production snapshot and
selected original reduced metadata reads from 717 to 39 (12,598,664 to 675,706
bytes). The selected item, preview decision, shared artwork, discovery and global
counts were compared for exact equality. Local file-read milliseconds are not
Cloudflare network timings or a guarantee for a physical mobile connection.

Run `node --test tests/studio-featured-count.mjs tests/catalog-scoped-context.mjs
tests/verified-fetch.mjs`, the native editor renderer and actual browser Edit
navigation before publication. Preserve original R2 bytes, checksum verification,
project recovery and export behavior. The shared CollectionIntroduction spans
the available hero content width; do not restore an independent 82ch limit.
