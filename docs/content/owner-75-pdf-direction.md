# Owner-directed PDF review scope

For the pending 75-package import, the owner most recently requested skipping
the remaining PDF matching checks and proceeding to publication. This follows
an earlier direction to skip further color checks for 349 eight-car originals.
The latest source-bound decision is
`work/imports/owner-75-combined-20261101/owner-pdf-skip-direction-v3-private/scope.json`
(SHA-256 `e462a63610ed7463a8a1bfd0cf0d0e13a58e53bdc5a1deeb587a8e2f8b3a5031`).
It covers 428 remaining originals from the 60-set group and the previously
identified 349 eight-car originals. Previously documented color or contrast
differences and other observations remain in the private evidence.

Skipping a check is not a visual PDF-pair approval, color approval or physical
print test. The 777 exact originals use
`FORMAT_OWNER_ORIGINAL_ADDITIONAL_PDF_REVIEW_SKIPPED`, with both
`pdfColorReview.visualColorApproved` and `pdfColorReview.visualPairApproved`
set to `false`. Download and Related accept the status only for an exact
registered source collection, identity, topic, image SHA-256 and original PDF
SHA-256 with the matching owner direction. A changed source, PDF, topic or
direction invalidates the exception.

Four previously held 60-set sources now have separately reviewed replacement
PDFs. `data/editorial/owner-75-reviewed-pdf-replacements-20261101.json` binds
each replacement to its actual image, original PDF, selected PDF and private
decision proof. The build and download paths reject any other PDF claiming a
passed review for one of the held source identities. Neither registry creates a
visual approval for the 777 skipped originals. Future new repairs require their
own evidence and an updated checked registry; never change only the status.

Source integrity, actual image and subject review, editorial and product
identity, media publication, the guarded build, the single writer and live
checks remain separate. The 75-package import is still private as of this
record; no deployment is implied.
