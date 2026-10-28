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
- Studio composition previews embed screen-sized, source-verified artwork rather
  than full-resolution masters. The SVG keeps the same 1400 × 1000 composition.
  Each preview has a 500 KiB browser regression limit. Editing/export still load
  and verify original sources. Private library tiles use the catalog's verified
  thumbnails. Public catalog/gallery images retain originals.
- Project restoration, adding one artwork and opening a starter resolve only
  required metadata buckets. Full-library search is still available. Stable,
  revalidated metadata URLs support tabs that remain open across deployment;
  original immutable URLs, byte counts and SHA-256 remain authoritative.
- The desktop Studio hero preload remains media-gated. Its below-fold mobile
  images and repeated launch icons do not claim high fetch priority. Home
  shortcuts, category covers and offscreen filter images load progressively.

For this release, the normal publisher runs with `UC_DELIVERY_BROWSER_QA=1`.
It completes the fresh render, source/editorial/media/SEO/CSP/unit gates, then
browser checks before any R2 staging. The browser gate covers every page template,
the Robot and Dinner galleries, 390/1440 widths in Chromium/WebKit, search,
original-image lightbox, 18 compositions, project restoration and actual export
formats. A failure stops publication. This is template coverage, not an individual
interaction test of every artwork URL or a physical-device test.

`UC_DELIVERY_EXPECTED_LIVE_REVISION` pins the known production baseline before
activation. If another content release or control patch appears during the work,
reconcile and rebuild instead of overwriting it. All existing account writer,
fresh inventory, storage cap, read-back verification, release budgets, fail-closed
and rollback controls remain in force.

Keep measured Lighthouse results separate from Google PageSpeed results. The
Google API can return a quota error; the ordinary PageSpeed web UI can still run
a public URL. Invalid/missing paint metrics are not a successful test. Report
actual measured scores and variation, never claim every URL scored 100 from a
subset of templates or from static consistency checks.
