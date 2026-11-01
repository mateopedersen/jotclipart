import { isKnownOwnerPdfSource, isOwnerDirectedPdfOriginal, isOwnerReviewedPdfReplacement } from './file-review-policy.mjs';

/** A source-bound owner direction; this is not a claim of PDF color approval. */
export interface OwnerPdfColorDirection {
  status: 'OWNER_DIRECTED_ADDITIONAL_PDF_REVIEW_SKIPPED';
  ownerDirectionSha256: string;
  scopeRevisionSha256: string;
  sourceImageSha256: string;
  originalPdfSha256: string;
  visualColorApproved: false;
  visualPairApproved: false;
}

export interface FileReviewArtwork {
  reviewStatus?: string;
  sourceCollection?: string;
  sourceOriginalId?: string;
  sourceOriginalSha256?: string;
  topic?: string;
  pdf?: string | null;
  pdfColorReview?: OwnerPdfColorDirection;
  files?: {
    webp?: { bytes: number; sha256: string };
    pdf?: { bytes: number; sha256: string };
  };
}

/**
 * Keep the existing reviewed-pair rule and allow only the exact supplied
 * originals named in the owner's separate decision. Replacing either asset,
 * changing its topic, or omitting the explicit color status invalidates it.
 */
export function hasUsableFileReview(item: FileReviewArtwork): boolean {
  if (item.reviewStatus === 'FORMAT_AND_PAIR_REVIEW_PASSED')
    return !isKnownOwnerPdfSource(item) || isOwnerReviewedPdfReplacement(item);
  return isOwnerDirectedPdfOriginal(item);
}
