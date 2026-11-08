# Original image delivery

UltraClipart keeps the full original R2 URL in public artwork `src`, image metadata,
editor sources and file controls. Discovery cards do not select a smaller `srcset`
variant. Existing checksum-bound loading backgrounds remain temporary backgrounds.

Managed gallery and discovery images use `data-original-deferred="pending"` only
inside an independently sized outer frame. The critical, static, hash-authorized
head script schedules up to four new managed original requests. Actual intersecting
frames take priority; at most two speculative near-screen requests can occupy slots.
Native eager hero images are outside this scheduled count. Changing visibility never
cancels a healthy original transfer or substitutes another URL.

The same slot remains reserved through the existing two bounded recovery attempts.
The loader's one-frame WebKit retry reset is explicitly distinguished from replacing
an artwork source. A terminal error releases its slot. Removing a node releases its
observers and slot. Dynamic search, favorites, topics and feed cards use the same
marker automatically, including future imports.

This is progressive enhancement. Disabled JavaScript, missing observer support,
constructor/runtime exceptions and print mode retain ordinary original loading.
A watchdog falls back to native loading if observer callbacks stop or scheduled
transfers cannot make progress; it does not restart those transfers. A fresh history
execution uses live JavaScript identity rather than trusting a serialized DOM marker.
Printing requests every remaining original. No personal storage is cleared.

Permanent checks cover compiler-stable script bytes and exact CSP hashes, delayed
network concurrency, transient failures, healthy slow transfers, missing/throwing/
silent observers, dynamic additions, source replacements, offline recovery, history
navigation and printing. Fixture traffic is explicitly separate from real CDN speed
measurements. Live/candidate image checks must count expected outer frames and verify
**every** corresponding original's `complete`, `naturalWidth` and `currentSrc`; hiding
an image must never reduce the expected count or turn a failure into a pass.
