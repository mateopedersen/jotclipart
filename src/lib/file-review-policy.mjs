import owner75PdfExceptions from '../../data/editorial/owner-75-pdf-exceptions-20261101.json' with { type: 'json' };
import owner75ReviewedReplacements from '../../data/editorial/owner-75-reviewed-pdf-replacements-20261101.json' with { type: 'json' };

export const OWNER_PDF_DIRECTION_SHA256 = 'e26a250a96daa9b875b1353dc554834dbe73813d4198daa80d5ce7f19e5f2fc4';
export const OWNER_PDF_SCOPE_REVISION_SHA256 = 'e462a63610ed7463a8a1bfd0cf0d0e13a58e53bdc5a1deeb587a8e2f8b3a5031';
export const OWNER_PDF_REGISTRY_SHA256 = 'a0b917b81182a55cc2326d0b8f448c00a3675dd556973150ec516013173ef5cf';
export const OWNER_PDF_REPLACEMENT_REGISTRY_SHA256 = '288ee72810e1f98443612058468cbe7a18c4a79db57fce357065d90a8e1ebe86';
export const OWNER_PDF_SELECTION_PROOF_SHA256 = 'b056b4cd8ec9ba4d2c55ef03c5d40832189d5157c42912955f976c0e2a5ba917';
export const OWNER_PDF_STATUS = 'FORMAT_OWNER_ORIGINAL_ADDITIONAL_PDF_REVIEW_SKIPPED';
const SOURCE_COLLECTION = 'owner-75-2026-11-01';
const DIRECTION_STATUS = 'OWNER_DIRECTED_ADDITIONAL_PDF_REVIEW_SKIPPED';
const sha256 = /^[a-f0-9]{64}$/;
const pairKeys = (registry) => new Set(Object.values(registry.records).map((entry) => `${entry.imageSha256}:${entry.pdfSha256}`));
const ownerPairKeys = pairKeys(owner75PdfExceptions);
const imageKeys = (registry) => new Set(Object.values(registry.records).map((entry) => entry.imageSha256));
const ownerImageKeys = imageKeys(owner75PdfExceptions);

/** These exact originals have not passed a PDF color review. */
export function isKnownOwnerPdfOriginalPair(item, registry = owner75PdfExceptions) {
  const keys = registry === owner75PdfExceptions ? ownerPairKeys : pairKeys(registry);
  return keys.has(`${item.files?.webp?.sha256}:${item.files?.pdf?.sha256}`);
}

/** A replacement of a previously held source also needs its own reviewed proof. */
export function isKnownOwnerPdfSource(item, registry = owner75PdfExceptions) {
  const keys = registry === owner75PdfExceptions ? ownerImageKeys : imageKeys(registry);
  return keys.has(item.files?.webp?.sha256) || Boolean(item.sourceOriginalId && Object.hasOwn(registry.records, item.sourceOriginalId));
}

/** Only the exact original asset pair included in this owner's direction qualifies. */
export function isOwnerDirectedPdfOriginal(item, registry = owner75PdfExceptions) {
  if (
    item.reviewStatus !== OWNER_PDF_STATUS ||
    item.sourceCollection !== SOURCE_COLLECTION ||
    registry.schema !== 1 ||
    registry.status !== DIRECTION_STATUS ||
    registry.ownerDirectionSha256 !== OWNER_PDF_DIRECTION_SHA256 ||
    registry.scopeRevisionSha256 !== OWNER_PDF_SCOPE_REVISION_SHA256 ||
    registry.sourceCollection !== SOURCE_COLLECTION ||
    registry.count !== 781 ||
    registry.activeOwnerDirectionCount !== 777 ||
    registry.additionalReviewRequiredCount !== 0 ||
    registry.reviewedReplacementSelectedCount !== 4 ||
    !item.sourceOriginalId
  )
    return false;
  const exception = Object.hasOwn(registry.records, item.sourceOriginalId)
    ? registry.records[item.sourceOriginalId]
    : undefined;
  const direction = item.pdfColorReview;
  const webp = item.files?.webp;
  const pdf = item.files?.pdf;
  return Boolean(
    exception &&
      exception.ownerDirectionActive === true &&
      direction &&
      direction.status === DIRECTION_STATUS &&
      direction.ownerDirectionSha256 === OWNER_PDF_DIRECTION_SHA256 &&
      direction.scopeRevisionSha256 === OWNER_PDF_SCOPE_REVISION_SHA256 &&
      direction.visualColorApproved === false &&
      direction.visualPairApproved === false &&
      item.topic === exception.topic &&
      typeof item.pdf === 'string' &&
      item.pdf.length > 0 &&
      webp &&
      pdf &&
      Number.isSafeInteger(webp.bytes) &&
      Number.isSafeInteger(pdf.bytes) &&
      webp.bytes > 0 &&
      pdf.bytes > 0 &&
      sha256.test(webp.sha256) &&
      sha256.test(pdf.sha256) &&
      item.sourceOriginalSha256 === exception.imageSha256 &&
      webp.sha256 === exception.imageSha256 &&
      pdf.sha256 === exception.pdfSha256 &&
      direction.sourceImageSha256 === exception.imageSha256 &&
      direction.originalPdfSha256 === exception.pdfSha256,
  );
}

/** A reviewed replacement is accepted only for its exact source and PDF bytes. */
export function isOwnerReviewedPdfReplacement(item, registry = owner75PdfExceptions, replacements = owner75ReviewedReplacements) {
  if (
    item.reviewStatus !== 'FORMAT_AND_PAIR_REVIEW_PASSED' ||
    item.sourceCollection !== SOURCE_COLLECTION ||
    registry.schema !== 1 || registry.status !== DIRECTION_STATUS ||
    registry.scopeRevisionSha256 !== OWNER_PDF_SCOPE_REVISION_SHA256 ||
    replacements.schema !== 1 || replacements.status !== 'SOURCE_BOUND_REVIEWED_REPLACEMENT_PDFS_NOT_LIVE' ||
    replacements.sourceCollection !== SOURCE_COLLECTION ||
    replacements.heldOriginalRegistrySha256 !== OWNER_PDF_REGISTRY_SHA256 ||
    replacements.privateSelectionProofSha256 !== OWNER_PDF_SELECTION_PROOF_SHA256 ||
    replacements.count !== 4 || !item.sourceOriginalId || item.pdfColorReview != null
  ) return false;
  const held = Object.hasOwn(registry.records, item.sourceOriginalId) ? registry.records[item.sourceOriginalId] : undefined;
  const reviewed = Object.hasOwn(replacements.records, item.sourceOriginalId) ? replacements.records[item.sourceOriginalId] : undefined;
  const webp = item.files?.webp, pdf = item.files?.pdf;
  return Boolean(
    held && reviewed && held.ownerDirectionActive === false && held.reviewedReplacementSelected === true &&
    item.topic === held.topic && item.topic === reviewed.topic &&
    typeof item.pdf === 'string' && item.pdf.length > 0 && webp && pdf &&
    Number.isSafeInteger(webp.bytes) && webp.bytes > 0 && Number.isSafeInteger(pdf.bytes) && pdf.bytes > 0 &&
    sha256.test(webp.sha256) && sha256.test(pdf.sha256) && sha256.test(reviewed.decisionSha256) &&
    item.sourceOriginalSha256 === held.imageSha256 && webp.sha256 === held.imageSha256 &&
    reviewed.imageSha256 === held.imageSha256 && reviewed.originalPdfSha256 === held.pdfSha256 &&
    pdf.sha256 === reviewed.reviewedPdfSha256 && pdf.sha256 !== held.pdfSha256,
  );
}

/** Build-time guard: no unrelated or stale item can use the owner-only status. */
export function assertOwnerPdfColorCatalog(artwork, registry = owner75PdfExceptions, replacements = owner75ReviewedReplacements) {
  const seen = new Set();
  const knownImages = registry === owner75PdfExceptions ? ownerImageKeys : imageKeys(registry);
  for (const item of artwork) {
    const knownImage = knownImages.has(item.files?.webp?.sha256) || Boolean(item.sourceOriginalId && Object.hasOwn(registry.records, item.sourceOriginalId));
    if (item.reviewStatus === OWNER_PDF_STATUS) {
      if (!isOwnerDirectedPdfOriginal(item, registry))
        throw Error(`Invalid owner PDF color direction: ${item.id}`);
      if (seen.has(item.sourceOriginalId))
        throw Error(`Duplicate owner PDF color source: ${item.sourceOriginalId}`);
      seen.add(item.sourceOriginalId);
    } else if (knownImage && !isOwnerReviewedPdfReplacement(item, registry, replacements)) {
      throw Error(`Owner PDF source requires an exact reviewed replacement or owner direction: ${item.id}`);
    }
  }
  return { ownerDirectedOriginals: seen.size, visuallyApprovedByDirection: false };
}
