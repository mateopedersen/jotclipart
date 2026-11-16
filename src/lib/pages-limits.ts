// JotClipart uses the Pages Free file entitlement; native R2 catalog routes are not files.
// Verified against current Cloudflare Pages limits on 2026-11-16.
export const PAGES_FILE_LIMIT = 20_000;

export function assertPagesFileCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Pages file count must be a non-negative safe integer.');
  if (count > PAGES_FILE_LIMIT)
    throw new Error(`Pages Free file limit exceeded: ${count} files (limit ${PAGES_FILE_LIMIT}).`);
}
