# Search descriptions and post-publication notifications

Owner-authorized indexing work, 2026-10-29, coordinated with Search Console Ultra Clipart.

Topic search descriptions reuse a complete first sentence from each source-bound introduction. The visible introduction and CollectionPage description remain complete. No words are clipped, invented, padded or added to artwork copy. The 25–160 character heuristic flags difficult summaries for editorial attention; it is not a Google requirement or an indexing guarantee. Duplicate summaries stop the normal build.

The guarded publisher freezes `work/delivery/{revision}/indexnow-snapshot.json` from the actual Pages package and byte-verified offloaded HTML before activation. It rejects stale revision stamps, noncanonical pages and mismatched R2 digests. Full build, image/SEO/source tests, storage reservation and readback, production preflight and pinned Pages publication remain mandatory.

Only after publication does the notification helper independently verify Cloudflare's exact canonical successful production revision, rendered/control revision, delivery root, prepared Worker digest, live homepage indexing permission and live root verification text. It submits canonical HTML page URLs from page sitemaps; it does not submit private editors, search endpoints, PDF files or a different image hostname. Image discovery continues through the image sitemap and original ImageObject markup.

A notification problem records `PUBLISHED_NOTIFICATION_PENDING` in that release's `indexnow-notification.json`. The site remains successfully published. Retry `node scripts/seo/indexnow-release.mjs --send --wait`, without rebuilding or redeploying. The first reviewed rollout alone uses `--send --initialize`; a missing ledger blocks routine full replay, and an existing ledger rejects initialization.

Accepted state lives in `.indexnow/` beside the repository's shared Git common directory (the primary checkout for linked worktrees). Preserve `accepted.json`, receipt history and `last-result.json` during cleanup. This is deliberately outside disposable `dist` and `work`; independent clones must obtain the accepted state before sending, not silently initialize a second catalog. An exclusive lock prevents concurrent senders; never remove an active sender's lock. Each received batch checkpoints atomically. Retry skips all confirmed accepted URLs. A network timeout after remote acceptance but before receiving/checkpointing the response is inherently ambiguous and can require resending that unconfirmed batch.

Initial notification covers the current canonical HTML catalog once. Later notifications compare meaningful main text, image/link identities, title, description and structured data, excluding revision/runtime/CSS/global navigation noise. Batches contain at most 10,000 URLs. Removed URLs require real 404/410 before notification. HTTP 200 confirms receipt; 202 means received with key validation pending. Neither guarantees crawling or indexing, and this is not Google's restricted Indexing API.

References checked: https://www.indexnow.org/documentation and https://developers.google.com/search/docs/appearance/snippet.
