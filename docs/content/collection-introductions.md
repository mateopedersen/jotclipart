# Natural openings — latest owner direction, 2026-11-04

Every current and future topic starts with a specific characteristic of its own
accepted collection. Do not open with the reusable “Welcome to our … collection”
formula or a count sentence. The live count belongs in the inventory paragraph.
Opening sentences must differ even after replacing the current topic name.
`verifyCollectionOpenings` rejects exact and subject-substituted duplicates across
the registry; this is a publication gate, not an automatic writing approval.

Visible introductions and concise summaries use natural phrases without hyphens
or dash punctuation. Write “blue and gold” and “black and white”; numeric ranges
retain their meaning as “1970 to 1979”. Never change slugs, IDs, original file
URLs, checksums or product identity to enforce prose style. The draft helper uses
the accepted summary as a starting point and formats prose, but still requires a
catalog-grounded editorial check and distinct opening before publication. It does
not promise automatic semantic uniqueness for millions of unseen collections.

# Collection introductions

Owner direction, 2026-11-03: every current and future subject page has two or
three short, topic-specific English paragraphs. Explain the collection's actual
drawings, current size, useful differences and relevant uses. This supersedes the
earlier one-paragraph limit. It is an owner presentation choice, not a Google
word-count requirement or a ranking guarantee.

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
The normal Astro and publisher gates require all published subjects, without a
legacy exemption, to carry checked 2–3 paragraph copy and valid examples.

For a new topic, complete its normal image reviews and source-bound concise
summary first. `node scripts/collection-introduction-draft.mjs --topic <slug>`
prepares a private, non-overwriting draft. It combines the accepted topic summary
with actual public artwork labels and suggested uses from the current primary
category. It does not infer a picture from its filename, inspect unseen pixels,
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
