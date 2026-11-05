# Progressive display while keeping original public images

The November 4 owner request adds image-loading repair to the approved collection
publication batch. The original-source decision remains in force: public `img`
sources, ImageObject data, social images, download links and original bytes are
unchanged. No resized candidate is placed in `src` or `srcset`, and no original is
re-encoded or enlarged.

An accepted record's existing `originalThumb` may supply a temporary CSS
background while its own original is still transferring. `imageLoadingPreview`
requires the original and thumbnail hashes, approved HTTPS asset origin and a
distinct thumbnail. The element binds the background to the exact original URL.
A source replacement without a corresponding binding cannot reuse the old
background. Loading completion, a real error or element removal clears it.

The small original-image loader has its own early head module entry so it does not wait
for the heavier download/PDF tools before attaching image lifecycle handlers.
The shared loader warms source-bound thumbnails near the viewport, in a window
of at most eight requests. It observes the gallery card frame, whose dimensions
remain available when offscreen child layout is skipped. It paints a successful
thumbnail as a temporary CSS background. The first collection cover and
the first subject/detail image can expose that background immediately. Preload
up to three small files for the first collection cover, or one for the first
individual subject/detail image. Critical original images receive eager/high priority where
appropriate. An early, hash-allowed startup script lets eligible gallery cards
start their small thumbnails before competing for bandwidth with full originals.
The original `img` stays in the HTML and becomes visible as the shared loader
promotes it. An unavailable loader releases the startup hold. A failed thumbnail
also releases its hold through the original scheduler, preserving bounded
recovery and the same R2 URL. Browsers can still initiate native requests for
images that are outside this gallery policy or were already requested.

JavaScript-disabled pages disable the temporary background and retain their
original images. Failed thumbnails cannot block the original. SVG detail pages
retain their existing path. Compact client records without complete original
thumbnail facts safely use the original alone. No new catalog rebuild or paid
image inference is needed.

Google's documentation distinguishes indexed HTML image sources from CSS images:
https://developers.google.com/search/docs/appearance/google-images
The CSS loading aid is not declared as an image search source; the existing full
original remains the real image and schema source. This is not a ranking or
indexing guarantee.

The local evidence directory records actual CDN SHA/MIME/byte verification and
source/thumbnail pixel comparisons for all 280 unique collection-cover pairs.
The comparison is not a fresh visual approval of every catalog artwork. Separate
controlled browser tests hold an original response open to verify the temporary
display, stale-source protection, offscreen deferral, failed-thumbnail behavior
and no-script fallback. Existing retry/offline/stall regressions remain required.

Cold throttled Chrome samples compare the first visible cover before and after
the change using real R2 files. Record the actual observation window and partial
results; do not turn one local sample into a site-wide speed percentage, live
PageSpeed result or physical-phone claim. Compile all affected native renderers
and use the existing sole guarded publisher for the approved release.
