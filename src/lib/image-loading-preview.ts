type ImageSource = {
  webp: string;
  originalThumb?: string;
  files?: { webp?: { sha256?: string }; thumb?: { sha256?: string } };
};

/** A temporary CSS background, never an img src/srcset, download or ImageObject. */
export function imageLoadingPreview(item: ImageSource, source = item.webp) {
  if (
    source !== item.webp ||
    !/^[a-f0-9]{64}$/.test(item.files?.webp?.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(item.files?.thumb?.sha256 ?? '')
  )
    return undefined;
  try {
    const original = new URL(source),
      thumbnail = new URL(item.originalThumb ?? '');
    if (
      [original, thumbnail].some(
        (u) =>
          u.protocol !== 'https:' ||
          u.hostname !== 'assets.jotclipart.com' ||
          u.username ||
          u.password ||
          u.port,
      ) ||
      original.href === thumbnail.href
    )
      return undefined;
    return { source: original.href, url: thumbnail.href };
  } catch {
    return undefined;
  }
}

export function loadingPreviewStyle(preview: ReturnType<typeof imageLoadingPreview>) {
  return preview
    ? '--original-loading-preview:url(' + JSON.stringify(preview.url) + ')'
    : undefined;
}
