# Natural openings — latest owner direction, 2026-11-04

Every current and future topic starts with a specific characteristic of its own
accepted collection. Do not open with the reusable “Welcome to our … collection”
formula or a count sentence. The live count belongs in the inventory paragraph.
Opening sentences must differ even after replacing the current topic name.
`verifyCollectionOpenings` rejects exact and subject-substituted duplicates across
the registry; this is a publication gate, not an automatic writing approval.

## Search and visitor copy

Name the subject as people look for it, such as Tupolev aircraft clipart or
sunflower clipart. Use model names, common names and alternate terms only where
the reviewed inventory supports them. A clear description of a representative
drawing is more useful than a list of terms. Use the count and the second
paragraph to explain choices visitors can make for a relevant project, lesson
or personal design. Keep the examples and sentence structure specific to the
gallery. Write in American English and leave editor notes, identification
decisions, file format instructions and licensing details to their own records
and pages. Distinguish a depicted concept from a released product.

New or rewritten topic copy passes the visitor copy checks in the content
publisher in addition to the source and signature checks. In a prose-only
snapshot update, the publisher can replay a committed registry in
`data/catalog-prose/` against the signed predecessor. This covers collections
already published through data-only imports as well as older topics. The
registry proves what copy changed, and the exact prior inventory proves the
scope of the edit.

Visible introductions and concise summaries use natural phrases without hyphens
or dash punctuation. Write “blue and gold” and “black and white”; numeric ranges
retain their meaning as “1970 to 1979”. Never change slugs, IDs, original file
URLs, checksums or product identity to enforce prose style. The draft helper uses
the accepted summary as a starting point and formats prose, but still requires a
catalog-grounded editorial check and distinct opening before publication. It does
not promise automatic semantic uniqueness for millions of unseen collections.

# Collection introductions

Owner direction, 2026-11-04: every current and future subject page has exactly
two short, topic-specific English paragraphs totaling 50 to 200 words. Describe
the actual drawings, current live count and visible variety available in the
accepted inventory. Open on the topic's own visual character, with no count or
count placeholder in the first sentence. Put exactly one `{{artworkCount}}` in
the inventory paragraph; the accepted live membership supplies that count. Do not
invent classroom, craft, packaging or other uses to fill space, or repeat a generic
one sentence opening. This supersedes the earlier two or three paragraph and one
paragraph limits. It is an owner presentation choice, not a Google word count
requirement or a ranking guarantee.

The existing editorial record keeps `intro` as its concise, checked search/schema
summary. Its `paragraphs` contain the visible introduction, including exactly one
`{{artworkCount}}` token. `CollectionIntroduction.astro` renders ordinary escaped
paragraphs and `CollectionCountCopy` supplies the live topic count. No JavaScript
is needed to read the complete build-time text or correct initial count.

Each expansion records `paragraphSourceSha256`, `paragraphEvidence` and
`paragraphsCheckedAt`. The signature binds the summary and the accepted public
titles, alt text and image hashes for the complete topic. Replacing artwork,
changing reviewed identities or editing the summary invalidates the expansion.
`paragraphReviewSha256` also binds the exact paragraph wording, selected examples
and check date; a text edit needs a renewed catalog check.
Submit checked two paragraph copy and valid examples for every published subject,
without a legacy exemption. The normal Astro and publisher structural checks do
not substitute for the semantic catalog check.

For a new topic, complete its normal image reviews and source-bound concise
summary first. `node scripts/collection-introduction-draft.mjs --topic <slug>`
prepares a private, non-overwriting draft. It combines the accepted topic summary
with actual public artwork labels and suggested uses from the current primary
category. Treat those uses as unapproved suggestions and omit any that are not
grounded in this collection. Generated suggestions are not evidence. The helper
does not infer a picture from its filename, inspect unseen pixels,
approve a record, invoke paid inference or publish anything. Read and edit the
draft for the particular topic before recording checked paragraphs in the normal
collection registry. Bind the accepted text with `collectionParagraphSignature`
and source-matched examples. Never mark a draft checked merely to pass a gate.

The catalog migration retains the existing distinct, checked descriptions and
adds representative accepted artwork examples and relevant use suggestions.
It is a collection-copy change, not a fresh visual inspection of every artwork.
Native originals, image metadata, identity reviews, licenses and stable URLs
are outside this change. No new Search Console or Bing submission is requested.

Primary guidance consulted:
- https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- https://developers.google.com/search/docs/appearance/google-images
