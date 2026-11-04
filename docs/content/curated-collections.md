# Curated collections

Curated collections are secondary views of existing, published subjects. The
reviewed registry currently adds 76 useful groupings alongside the 25 existing
primary categories. An artwork still has one stable ID and its existing subject,
file URLs, editorial record and primary category. Membership in several relevant
views does not increase the global artwork or subject total.

`data/curated-collections.json` is the reviewed source for explicit topic IDs,
collection names, concise summaries, two short introduction paragraphs and cover
choices. No substring, search alias or generated label can add a member. A group
needs at least two distinct subjects, a unique membership set and three distinct
cover artwork IDs. It becomes visible only when every member has published work.
New collections use `/collection/<slug>/`; individual subjects keep their existing
`/clipart/<slug>/` URLs.

The same reviewed registry supplies specific summaries and two short paragraphs
for the 25 existing primary collection pages. It replaces repeated generic card
descriptions while leaving their original topic memberships and stable routes
unchanged. Static rendering and the captured snapshot renderer use this one copy
source.

Each cover uses three actual catalog artworks in `CollectionCover.astro`, with
contained images, consistent frames, subtle depth and a reviewed palette. No new
artwork or paid image inference is involved. Cover reviews bind the exact source
WebP SHA-256 and canonical title, alt and description. A changed image or public
metadata fails the previous review. Keep the existing shared editorial resolver
as the authority for artwork copy; this registry does not approve unseen artwork.

The grouping review considered all 675 published subjects in the captured
November 4 catalog, accepted catalog descriptions and actual representative
pixels. Covers and ambiguous memberships received a second review. This is not
a new visual review of every artwork. Specific decisions include animal Jaguar
rather than a vehicle brand, Kiwi bird rather than kiwi fruit, mouse rather than
computer mouse, and lettering in Word rather than an assumed Microsoft product.
The five regional flag views cover the 52 country flag subjects; broader USA
artwork remains separate. Fictional scenes and unreleased branded concepts are
described as illustrations or fan concepts, without invented product facts.

## Captured snapshot integration

`server/catalog-snapshot/curated-collections.mjs` derives views from the captured
catalog root. It reads bounded topic-count keys, canonical artwork records and
the first approved page of each explicit member. A balanced preview prevents one
large subject from filling the gallery. The sealed counts, primary-category
assignments and search facets are not rewritten. Directory search filters the
collection cards; it does not change catalog-wide artwork search.

Both the static adapter and snapshot handler support the new routes and counts.
`/sitemap-collections.xml` lists the additional active routes. The normal sitemap
index links that document while retaining the existing page and image documents.
The index parser and normal IndexNow discovery recognize it; this local change
does not submit URLs or activate a release.

## Review and publication

Relevant checks are `tests/curated-collections.mjs`,
`tests/collection-natural-openings.mjs`, `tests/catalog-protocol.mjs`,
`tests/sitemaps.mjs`, `tests/indexed-sitemaps.mjs` and
`tests/discovery-projections.mjs`. The private native test in
`tests/e2e/curated-collections-native.mjs` uses isolated workerd/R2 fixtures with
outbound calls disabled and never activates a real pointer. The browser test in
`tests/e2e/curated-collections.mjs` checks all collection routes, responsive
controls, accessibility, complete source images and no-script navigation. Its
cover sheets require an actual human/agent visual pass after capture. Local
source-byte interception is recorded honestly and is not a fresh CDN receipt.

Show the current batch's local preview and obtain the owner's explicit current
publication instruction, as required by AGENTS.md. Then integrate through the
existing sole guarded publisher against its latest source and captured root.
The private preview overlays the exact two approved Lesotho capsules on the older
committed source catalog to match 37,958 artworks and 675 subjects. Do not replace
the current live catalog with that older committed JSON. Preserve concurrent
content, software changes, accepted media, originals and rollback copies.

Publication must use the normal compiler, strict catalog/editorial/SEO checks,
guarded activation and real URL/CDN/download verification. Local browser and
native test results alone are not evidence that these collections are live.
