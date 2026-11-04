/** Only upgraded server HTML carries a captured catalogue identity. */
export function pageCatalogSnapshot(doc: Pick<Document, 'querySelector'> = document): string {
  const value = doc.querySelector<HTMLMetaElement>('meta[name="catalog-snapshot"]')?.content ?? '';
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
export function catalogCountsMatchPage(root: string, responseRoot: string | null): boolean {
  return !root || root === responseRoot;
}
/** Interactive views adopt a new root only after replacing their visible data. */
export function adoptCatalogSnapshot(version: string): void {
  if (!/^[a-f0-9]{64}$/.test(version)) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="catalog-snapshot"]');
  if (!meta || meta.content === version) return;
  meta.content = version;
  document.dispatchEvent(new CustomEvent('ultraclipart:catalog-snapshot', { detail: { version } }));
}
