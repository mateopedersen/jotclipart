# November 4 site-wide speed repair

The owner extended the approved publication batch to Surprise me and all slow
page/image loading, then explicitly retained full originals in gallery cards and
required preservation of the established R2 setup. Do not change the original
public image strategy, R2 objects, immutable URLs, credentials or publication
pointers as part of this code patch. Source repair is separate from the sole
publisher's guarded activation.

The real live cold mobile Chrome audit covered home, New, Collections, a subject,
an artwork, search and the editor. At the captured root the homepage transferred
about 7.5 MB of images versus 57 KB of scripts; no long main-thread tasks were
observed in that sample. Search's first response exceeded 3 seconds on a cache
miss. Originals already had one-year immutable CDN caching. Do not diagnose an
unverified cache/configuration failure or promise a smaller full original.

Changes address measured critical paths while preserving the same files:

- Every actual document module and its verified static dependency chunks are
  preloaded together from the compiler's immutable graph. This removes the
  entry-to-shared-chunk-to-utility request waterfall without loading optional
  editor codecs or other dynamic imports. Only modules already required by that
  document enter the graph walk; URLs, source revision and byte sizes are bound,
  duplicates/cycles are bounded to 32, and unknown/external dependencies fail.
- Original-image priority promotion is limited to two actually visible images.
  Near-but-offscreen originals are no longer promoted to eager transfers. Native
  browser lazy requests can still occur; this is not a global two-request limit.
- The first New card is prioritized on mobile as well as desktop. The homepage's
  first full original has higher priority; dynamic search cards begin at low
  priority. Already verified, source-bound temporary CSS backgrounds also cover
  homepage artwork and subject-preview links. Real img/schema/download sources
  remain the original; source binding and lifecycle rules are unchanged.
- Art-page own-topic, shared context and related reads overlap on one captured
  snapshot. Independent shell inputs overlap. Search avoids building an unused
  monochrome directory; the B&W page keeps its complete directory/count gate.
  Existing request-bucket concurrency, SHA checks and identity guards remain.
- Simultaneous public HTML misses in the same cache/root/renderer/route share
  only a successful non-personalized render. The bound is 32 active identities;
  different roots, errors, non-HTML and Set-Cookie responses remain isolated.
  This coalesces work in an isolate; it is not a cross-region global cache.
- Supporting Chrome/Edge can prerender eligible public pages after deliberate
  pointer/touch intent using the standard Speculation-Rules response header.
  The same-origin JSON rule uses moderate eagerness; browser resource, battery,
  Save-Data and preload-settings limits apply. Editor/download/external targets
  are excluded. No inline-script CSP exception is introduced. Unsupported
  browsers retain ordinary links and the bounded HTML-warming fallback.
- Fallback public-page intent can warm at most two same-origin HTML destinations. The
  independent Surprise helper can prepare at most two, with at most two image
  hints for its current selected page. No editor/tool state is warmed. Neither
  helper blocks or replaces genuine link navigation. They skip Save-Data, 2G,
  hidden and offline documents; canceled/error/timeout cases fail normally.
  Homepage automatic preparation waits for the initial page load, while direct
  pointer/focus intent still starts immediately; optional work never competes
  with the initial module/font transfers by starting on a fixed early timer.

Source and fixture tests prove different things. The live audit records real
public response/asset timings. Controlled browser fixtures prove nonblocking
navigation, stable selection, bounded hint scope and original source invariants.
Reader dependency gates prove overlap and retained identity failures; immutable
snapshot and native runtime tests cover their own contracts. None is proof that
this change is live. The publisher must run current-root/native/browser gates,
activate through the existing writer and record actual public URL/CDN receipts.

Keeping 0.5-1.6 MB originals in small cards leaves a real bandwidth floor on slow
connections. Do not describe a temporary CSS first appearance as completion of
those original downloads, and do not promise instantaneous loading everywhere.

Primary implementation reference: https://developer.chrome.com/docs/web-platform/prerender-pages
The local native-browser test must record activationStart greater than zero before
claiming a prerender was reused. Readiness and bandwidth limits still apply;
this cannot guarantee an instant cold visit on every connection.

The native-browser fixture observed PrefetchResponseUsed, one document request
and complete synthetic image at357ms after click. Prerender activation itself
was disabled by the debugging environment (activationStart0); do not describe
that run as a successful prerender or as a real R2/site-wide357ms result.
