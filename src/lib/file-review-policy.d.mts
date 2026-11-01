import type { FileReviewArtwork } from './file-review';

export const OWNER_PDF_DIRECTION_SHA256: string;
export const OWNER_PDF_SCOPE_REVISION_SHA256: string;
export const OWNER_PDF_REGISTRY_SHA256: string;
export const OWNER_PDF_REPLACEMENT_REGISTRY_SHA256: string;
export const OWNER_PDF_SELECTION_PROOF_SHA256: string;
export const OWNER_PDF_STATUS: string;
export function isKnownOwnerPdfOriginalPair(item: FileReviewArtwork): boolean;
export function isKnownOwnerPdfSource(item: FileReviewArtwork): boolean;
export function isOwnerDirectedPdfOriginal(item: FileReviewArtwork): boolean;
export function isOwnerReviewedPdfReplacement(item: FileReviewArtwork): boolean;
export function assertOwnerPdfColorCatalog(artwork: FileReviewArtwork[], registry?: unknown, replacements?: unknown): {
  ownerDirectedOriginals: number;
  visuallyApprovedByDirection: false;
};
