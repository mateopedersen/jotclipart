# Surprise me selection

The index is built from the shared reviewed catalog, including its actual-source
monochrome audit. It does not claim to perform a new visual review or call a paid
vision service. Titles and alt text supply positive visible-subject evidence;
filenames never supply positive evidence. Negative clues, actual monochrome
measurements, unpublished records and explicit operator exclusions remain blocked.

There is no topic or brand allowlist. An expressive robot, donut, fish, computer
accessory or a previously unknown subject can qualify. A cheerful face is
evidence; an ordinary object, material, color or generic tag by itself is not.

## Classification provenance

Historical importers used `discovery.cute: false` both for actual exclusion reviews
and for blanket topic defaults. An unbound boolean cannot distinguish them and
must not permanently suppress an otherwise suitable new subject. Version 3
reevaluates these legacy hints using the current visible-subject rules.

A negative visual decision can set `cute: false` with `reviewedSourceSha256`
matching the original WebP checksum. An image replacement invalidates that
decision. `exclude: true` is an explicit operator veto. Future importers should
leave classification unset when unknown, not invent a visual review or assume a
whole topic is cute/non-cute.

The existing GTA and remaining-thirty-one discovery ledgers contain actual-pixel
exclusion evidence and per-image original hashes. The finite adapter preserves
those existing decisions only while their source hashes still match. It is not
a fresh visual review, an extensible approval bypass or permission to admit
unreviewed new content. New source-bound observations use the normal review
workflow.

## Variety and additions

The build makes a bounded, topic-stratified streaming reservoir and emits at most
512 picks. A separate recent-addition lane reserves up to a quarter of that pool,
with a per-topic cap. Recency is accepted catalog append order, not an invented
creation date. Topic balancing prevents a large category from crowding out all
others; the click picker has no special animal weight. When both lanes are
available, recent additions receive a 35% opportunity before topic balancing.

The browser uses a shared fetch and pool, avoids the current ID, remembers recent
24 IDs and avoids the last three topics when alternatives exist. Navigation never
waits for inference or a network response. Offline/no-JavaScript visits retain a
genuine eligible fallback. Normal imports rebuild the index from the current
catalog, so suitable new subjects need no keyword-list edit.

The protocol is version 3. Changing its shared client or template selects a full
software release; ordinary append-only content can use the guarded incremental
publisher. This is a conservative discovery filter, not a guarantee that every
visitor will find every selection equally cute.
