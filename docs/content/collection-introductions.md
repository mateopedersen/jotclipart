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
