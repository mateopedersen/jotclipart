# Independent JotClipart publication

JotClipart uses the existing Astro native renderers and signed seven-facet R2 catalog. The accepted source records, source signing domain separator, immutable object keys and source checksums remain unchanged. Public presentation derives the new domain and a single Free prefix; it does not rewrite reviewed descriptions or upload a second archive.

Catalog social PNGs use a separate private versioned `jotclipart-og-<rendererSHA-prefix>` Worker through the exact `OG_RENDERER` service binding on the new Pages project. It has no public routes, `workers.dev`/preview URLs, database or R2 bindings. Preserve this new renderer Worker, its versioned source/engine hashes and the new production/preview service bindings when removing old site resources. It reads existing originals through the new verified CDN path; it is not a second original archive. Keep the account's existing Workers Paid plan and the shared R2/D1/AI bindings intact.

The separate Cloudflare project is connected to `mateopedersen/jotclipart` on `main`, with automatic production and preview Git deployments intentionally disabled. The authoritative software publication is a manually verified native build/deploy from a clean checkout of that new repository using the owner's existing Cloudflare authentication. GitHub Actions validates the exact candidate; it does not deploy or hold a Cloudflare token. Reviewed content-only batches separately use the installed publisher and guarded new R2 pointer. This prevents an automatic or stale build from overwriting a newer manual software/content release.

`pnpm test:release` runs the complete native source/type/invariant and exact built-package gates. The four original static-artifact tests are preserved unchanged as `pnpm test:release:legacy`; the manual legacy workflow explicitly uses that legacy backend. Neither a missing local R2 archive nor missing legacy HTML files is treated as a passing test of the native deployment.

## Current installation record

Read `config/content-publisher.json` before a content operation. `AWAITING_JOTCLIPART_PRODUCTION_INSTALLATION` is a real hold, not proof that the historical UltraClipart runtime is the new installed publisher. The old protected runtime and independent KEEP archives must remain intact. The new public configuration is `config/content-publisher-public.json`, with explicit production origin `https://jotclipart.com` and pointer `catalog/jotclipart/active.json` in the existing shared bucket.

The normal content, presentation, URL-repair and resume operators reject an old origin, omitted/old pointer, changed authority or software whose trusted-configuration digest belongs to the old namespace before staging or activation. A software revision also has to match actual production control before activation. Never fix a failure by relaxing these checks, reusing an old active pointer or overwriting a newer catalog root.

## Rebuild from the new repository

After the release owner approves and pushes an exact candidate, run with Node 24.22.2 and pnpm 11.25.0:

```sh
node scripts/jotclipart/clean-checkout.mjs CANDIDATE_SHA work/new-independent-release
```

This creates a real network clone of `mateopedersen/jotclipart`, installs the frozen lockfile into a separate package store, runs source/type/invariant and package gates, and builds a unique `work/jotclipart-release-CANDIDATE` tree. It refuses an existing destination. It does not deploy. `verify-independent.mjs` requires the new remote only, no Git object alternates, no old linked worktree, and every ABI-bound compiled dependency within this new checkout. The native package contains no duplicate R2 original archive.

`JOTCLIPART_BUILD_ROOT` selects a relative, separate descendant of this checkout's `work/` directory for both build and deployment. It rejects traversal, aliases and existing symlink/non-directory components. The default remains `work/jotclipart-build`; a verified installed release needs its own stable directory.

The two large historical JSON sources have generated, source-SHA-bound structural declarations so the unchanged strict Astro checker does not build a multi-gigabyte literal type graph. Runtime imports still read the original JSON. The mandatory source gate regenerates and compares every declaration byte from the complete actual sources, in addition to the existing editorial, source-identity and hash checks. When an approved source edit changes `data/art.json` or `data/editorial/reviews.json`, regenerate the declarations with `node scripts/jotclipart/catalog-json-types.mjs --write` and rerun the complete gate. Do not replace this with an `any` declaration, ignore a stale declaration, or reduce the Astro/TypeScript source scope.

## Preserve the exact installed publisher

Compiled renderer inputs have original absolute paths bound into their ABI. Moving only `runtime/` does not preserve the full installed publisher. Keep the exact unique build tree, its source inputs and the new checkout. Future source changes require a separately built and verified software release.

After the exact new software is deployed and all independent release gates pass, run inside that same new checkout:

```sh
node scripts/jotclipart/freeze-publisher.mjs work/jotclipart-release-CANDIDATE work/publisher-installation-CANDIDATE --record-installed
```

The script reads production control twice, verifies its exact software revision and stable catalog root/counts, hashes the original worker, renderer, client and source inputs, and writes a private preservation manifest and installation record. It makes no R2 writes. Without `--record-installed` it leaves the tracked installation record unchanged. This control/byte proof does not replace real browser, model, shared-project, complete URL or R2 inventory evidence. A manifest is not a separate backup; the release owner also preserves the required independent source/configuration archive.

## Approved content batches

Use the installed software directory recorded above and the explicit new public configuration:

```sh
pnpm content:publish -- prepare data/catalog-batches/REVIEWED.json INSTALLED_SOFTWARE config/content-publisher-public.json work/new-reviewed-preparation
pnpm content:publish -- publish data/catalog-batches/REVIEWED.json INSTALLED_SOFTWARE config/content-publisher-public.json work/new-reviewed-publication
```

Use a fresh output for each operation. The existing immutable ZIP intake, actual pixel/source review, at most 256 changed artworks and 64 affected topics, four concurrent binary transfers, full original-byte/MIME/CORS checks, native routes, independent source replay, authority issuance and conditional parent/ETag activation remain mandatory. Never turn a dry run or queued packet into a live publication claim.

New-site media verification explicitly carries its scoped production origin through preparation, independent replay, resume and final verification. The historical source-receipt replay contract remains separately supported without changing old signatures. `rehearse-publisher.mjs` can exercise an unchanged signed record, canonical alias, art/editor and discovery routes from a private verified metadata capture without any cloud requests or writes; it does not publish a new import.

New planned media may name `assets.jotclipart.com` directly. The plan retains the same strict normalized immutable object path, hash prefix, MIME, byte ceiling, local source and pair checks. New canonical records may retain either exact owned HTTPS asset origin; public rendering always uses the new host. The old verified-manifest validator remains unchanged. An old immutable plan can bind a fresh receipt to the explicit new production origin, new public URL and new CORS facts without rewriting its signed source URL or original checksums. A private real-workerd regression covers new-host source admission, captured v2 collection reads and the derived Free title; it is not a published dummy import or a fresh visual-review/CDN receipt.

## Search submissions remain disabled

The owner deferred all JotClipart search submissions on 2026-11-16. `config/indexnow.json` has `submissionEnabled: false` and `OWNER_DEFERRED_2026_11_16`. Neither a direct sender/CLI nor a publication hook may start an IndexNow sender, modify an accepted ledger, or override this hold through an environment flag. Sitemap generation and read-only SEO validation remain available. A held notification is not a submitted URL. Do not enable Google/Bing sitemap, URL or IndexNow submission until the owner explicitly changes this direction. Preserve the separate historical accepted ledgers.
