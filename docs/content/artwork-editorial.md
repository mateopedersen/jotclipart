# Image-specific artwork copy

Owner direction, 2026-10-26. Applies to every current and future UltraClipart import.

Start with the actual image. Write a clear title naming its subject and the detail that distinguishes this composition. Describe the visible scene in natural English: what the subject is doing, how its parts are arranged, and the details a visitor needs to distinguish it from another drawing. A simple object may need one sentence; a complex scene may need several. Do not force every image into the same sentence pattern, word count, or usage paragraph.

## Subject and visible action first — owner direction, 2026-11-04

Begin each description with the main depicted subject and its visible action.
For a static object, describe its identity and visible arrangement instead of
inventing an action. Clothing, colors, tools and background details follow when
they help distinguish the drawing. A description of a worker must not replace
the worker's activity with a list of clothes or nearby equipment. Use a natural
action in the title when it meaningfully distinguishes the scene; do not force
verbs into static object titles or rewrite an already useful title by formula.

For example, an illustration of a waiter carrying a tray needs the waiter and
tray carrying action before the bow tie, jacket or towel. A suitable opening is
“A smiling illustrated waiter carries a tray with a Coca Cola bottle and two
filled glasses.” This describes an illustration, not a real event, endorsement,
product specification or bottle model year. Preserve qualifications for imagined
roles and concepts, and do not infer hidden intentions or unsupported actions.

The semantic check requires actual source pixels. A language or vision model
reviewer must receive the image or numbered image sheet, inspect every affected
image, and open the original for ambiguous details. Record concrete observations
about the subject and action or arrangement, bound to the exact source checksum.
Filenames, prompts, word matches, regular expressions and passed text gates do
not establish image understanding. Automated checks may flag candidates or verify
hashes and copy consistency; they cannot certify that an unseen scene is accurate.

Keep good, natural copy. Correct only a confirmed omission, misleading detail or
other image specific defect. Do not replace every description with a repeated
sentence pattern, append generic uses, or add an unverified model, year, capacity,
performance, event or endorsement claim.

Do not turn a filename or drawing prompt into public prose. Do not invent visual details, historical facts, product specifications, expertise, human authorship or personal experience to make copy sound authoritative. Verify named landmarks and branded products against primary sources where needed; follow `product-identification.md` for product identities. Label imagined concepts accurately.

Alt text describes the image concisely. It is not a duplicate title, sales pitch, keyword list or download instruction. Title, H1, alt, image schema, search and related captions must refer to the same reviewed subject. Keep stable artwork IDs, URLs, file bytes and licenses.

File controls already explain downloads. Do not append generic Image/PDF instructions to every description. The user-facing download label is **Image**, not WebP. The actual `.webp` extension, MIME, format facts, file checksums and technical compatibility documentation remain accurate; do not rename a WebP file to another format.

## Review and automatic protection

`data/editorial/reviews.json` holds image-specific copy and observed evidence. Each review binds the inspected source and rendered image hashes, a canonical fingerprint of the entire incoming catalog entry, review date and factual references. This fingerprint includes the topic and product identity as well as title, alt and description; JSON key order alone does not change it. A new image, changed source or changed metadata invalidates its prior review. When the context fingerprint was introduced, existing records were first validated against their existing source and text checks and then bound to the catalog as it stood; that migration did not add or assert any visual reviews. Do not calculate a missing context fingerprint for a new or changed record as a substitute for inspection. Record at least two real visual observations; do not populate observations without looking at the image. Set `status: reviewed-from-image` only after the visual check.

After any title, alt, description, topic or product identity change, the prior
source-bound review fingerprint, token or approval is stale even when the image
bytes are unchanged. Recheck the affected copy against the exact source pixels,
retain the source checksum, record the new wording and observations, and issue a
fresh review through the normal validator. Never refresh only a checksum, token,
date or legacy fingerprint to make changed metadata appear reviewed. Source
replacement likewise requires renewed inspection. The accepted public resolver
must carry the same reviewed subject through H1, alt, description, schema, search
and related cards.

`scripts/artwork-editorial.mjs` produces the single public copy used by the catalog. Its automatic cleanup removes the exact generic sentences listed in `data/editorial/boilerplate.json`, preserves necessary qualifications through the explicit `sentence-replacements.json` map, and removes a duplicated title prefix from alt text. It does not infer image contents, manufacture alternate wording or assert that a visual review occurred. The imported catalog remains the original audit trail; public copy is resolved centrally.

New or modified entries without a source-matched review fail the normal build. Existing accepted entries are temporarily fingerprinted in `legacy-baseline.json`, explicitly marked **not visually re-reviewed**. This baseline is a migration ledger, not an approval list to extend for new imports. Never add a new ID or refresh a changed fingerprint to bypass the review requirement. Replace legacy entries with real image reviews as they are completed. `npm run content:audit -- --details` reports every remaining review and text issue. Do not claim a full catalog visual review merely because this automated audit passes.

If the system can safely remove known boilerplate, it does. If a semantic correction needs image inspection, it blocks new publication until that review is supplied. It must not silently substitute a guess. Existing qualified concept/fan-art statements and license restrictions are not disposable filler.

Run `npm run content:review -- --topic <slug> --limit 25` to prepare the next missing image reviews. The command checks original image hashes and creates a numbered contact sheet plus an empty review JSON in `work/editorial-review/`. Open every image; use the recorded original path for fine details. Fill `copy`, `observations`, `references` and `reviewedAt`, and set `status` to `reviewed-from-image` only after inspection. Merge the finished records into `data/editorial/reviews.json`, then run the audit and normal checks. Preparation never invents captions, auto-approves evidence or overwrites an existing reviewer draft.

Use `npm run content:apply -- path/to/review.json` to validate a completed batch without writing, then append `--write` to apply it atomically. An invalid, duplicated, unknown, stale or still-pending entry rejects the whole batch. Unrelated reviews remain intact; original paths and sheet numbering are discarded. This is the reusable production workflow for large imports: prepare image evidence in batches, review the actual images and complete specific copy, validate/apply once, then use the installed guarded content publisher. Software/template changes retain their separate software-release checks. A language or vision model can prepare proposed copy, but it must actually receive the images; filename-only text expansion is not a substitute for image evidence. No paid inference provider is invoked by these commands.

## Updated collection display — owner direction, 2026-11-04

Topic pages need exactly two short, distinct paragraphs, totaling 50 to 200 words.
Open with a characteristic of the actual collection, without a count or count
placeholder in the first sentence. Include exactly one `{{artworkCount}}` in the
inventory paragraph so the accepted live membership supplies the displayed count.
Describe the types and visible variety actually available. Do not invent classroom,
craft, packaging or other uses to fill space, repeat a generic one sentence opening,
or imply every artwork was freshly inspected during a prose migration. See
`collection-introductions.md`. Keep the concise `intro` for search metadata.
This direction supersedes the earlier two or three paragraph and single paragraph
display guidance.

## Search guidance

Public-figure reviews record `depiction` with the named people, `sceneNature: imagined-illustration` and whether the picture assigns a fictional role. Validation checks identity consistency and rejects unqualified fictional roles and unsupported event/result claims. This text check complements actual pixel review; it is not automatic proof that every sentence is true. Use pixel-based color checks to catch a drawing labeled as line art when its original has colored elements. Keep any image-quality limitations in the internal review, not repeated disclaimer paragraphs on every public page.

Topic pages use one concise introduction from `data/editorial/collections.json`. It describes the particular available drawings and helps choose between them. `collection-editorial.mjs` binds the introduction to its topic inventory and source-image examples; missing, duplicated or stale entries stop the build. Keep helpful technical guidance in the shared file guide and image facts, with compact links beside the gallery. Do not restore the removed multi-paragraph SEO sections. Catalog-grounded topic summaries and actual per-image visual reviews are different types of evidence; report each honestly.

Useful original images, accurate nearby text and clear titles matter more than artificially lengthened paragraphs. E-E-A-T is not a reason to invent authors or credentials. No ranking or indexing guarantee is made. References checked for this policy:

- [Google: helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Google: descriptive and concise title links](https://developers.google.com/search/docs/appearance/title-link)
- [Google: image landing pages and useful alt text](https://developers.google.com/search/docs/appearance/google-images)

Concurrent imports may keep their reviewed topic introductions in dedicated `*-collection.json` or `*-collections.json` files. The shared loader validates the combined registries and rejects conflicting duplicate topics. Refresh an inventory signature only after checking the changed metadata and verifying the source examples; replacement pixels or new visual claims require renewed image inspection.
