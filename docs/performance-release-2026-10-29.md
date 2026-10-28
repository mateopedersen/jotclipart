# Site speed release

The owner requested a full performance investigation, tests and live publication,
without another confirmation. Public catalog images continue to use their exact
reviewed R2 originals. Source files, IDs, copy, licenses and download verification
are unchanged.

- Shared fixed-size picture frames use native `content-visibility: auto` to avoid
  downloading and rendering distant original images during the initial visit.
  The frame sizes and all SSR image URLs, alt text and schema remain intact.
  Printing explicitly restores rendering. Scroll the reserved frame when testing
  offscreen pictures in WebKit; scrolling its skipped child directly does not
  reliably move the viewport. Actual scrolling and decoding must be tested.
  The same fixed-frame rule covers offscreen Studio composition cards, so their
  reduced SVG files do not all compete with the visible hero on first load.
  Home's fixed grid cards, seasonal scenes, project example and benefit scenes
  also defer their originals outside the viewport; their dimensions stay defined
  by the existing grid tracks or fixed-height scene, and printing restores them.
- Studio composition previews embed screen-sized, source-verified artwork rather
  than full-resolution masters. The SVG keeps the same 1400 × 1000 composition.
  Each preview has a 500 KiB browser regression limit. Editing/export still load
  and verify original sources. Private library tiles use the catalog's verified
  thumbnails. Public catalog/gallery images retain originals.
- Project restoration, adding one artwork and opening a starter resolve only
  required metadata buckets. Full-library search is still available. Stable,
  revalidated metadata URLs support tabs that remain open across deployment;
  original immutable URLs, byte counts and SHA-256 remain authoritative.
- Choosing a subject loads only that subject's metadata. A delayed request cannot
  replace a newer library choice. Global search still loads the full library.
- The private, noindex image editor displays its checksum-bound 960-pixel screen
  copy while the original verifies. Controls still wait for the verified original;
  a missing screen copy falls back to the verified master. Public galleries,
  image pages, social images and download sources retain the original R2 assets.
- The interface font uses optional display and an early preload on applicable
  pages, preventing late text replacement on slow first visits. Reading pages keep
  their own face; editable canvas text keeps the existing export font contract.
- The desktop Studio hero preload remains media-gated. Its below-fold mobile
  images and repeated launch icons do not claim high fetch priority. Home
  shortcuts, category covers and offscreen filter images load progressively.
- The AI Builder's desktop mosaic prioritizes its original primary illustration.
  Ingredient, style and idea references use low fetch priority; fixed offscreen
  idea frames defer their original images. The mobile form and all original
  sources, choices, generation controls and safeguards remain intact.

For this release, the normal publisher runs with `UC_DELIVERY_BROWSER_QA=1`.
It completes the fresh render, source/editorial/media/SEO/CSP/unit gates, then
browser checks before any R2 staging. The browser gate covers every page template,
the Robot and Dinner galleries, 390/1440 widths in Chromium/WebKit, search,
original-image lightbox, 18 compositions, project restoration and actual export
formats. A failure stops publication. This is template coverage, not an individual
interaction test of every artwork URL or a physical-device test.
AI Builder UI checks use a recorded image and explicitly mocked API/quota and
challenge responses; they do not make a new inference request or change live limits.

The local preview origin is not an allowed production R2 CORS origin. Its browser
tests explicitly enable the existing loopback-only CDN fixture, which passes
through actual upstream bytes and supplies local-origin CORS headers. It never
changes R2 settings. Native production-origin checks remain necessary after the
release. The editor test also delays the original to verify the small preview,
blocked controls, a single shared original request, and missing-preview fallback
in both browser engines.

`UC_DELIVERY_EXPECTED_LIVE_REVISION` pins the known production baseline before
activation. If another content release or control patch appears during the work,
reconcile and rebuild instead of overwriting it. All existing account writer,
fresh inventory, storage cap, read-back verification, release budgets, fail-closed
and rollback controls remain in force.

Delivery staging waits up to one hour for an occupied account writer lock. It
never removes another writer's lock, and no inventory, reservation or remote write
starts while waiting. Once acquired, the normal fresh census and all existing
storage proofs run. Missing directories and other lock failures stop immediately.
This lets a tested release follow a concurrent content transfer safely.

Keep measured Lighthouse results separate from Google PageSpeed results. The
Google API can return a quota error; the ordinary PageSpeed web UI can still run
a public URL. Invalid/missing paint metrics are not a successful test. Report
actual measured scores and variation, never claim every URL scored 100 from a
subset of templates or from static consistency checks.
