type ImageSource = {
  webp: string;
  originalThumb?: string;
  files?: { webp?: { sha256?: string }; thumb?: { sha256?: string } };
};

export type LoadingPreview = { source: string; url: string };

/** A thumbnail bound to the original by catalog checksums. */
export function imageLoadingPreview(item: ImageSource, source = item.webp) {
  if (
    source !== item.webp ||
    !/^[a-f0-9]{64}$/.test(item.files?.webp?.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(item.files?.thumb?.sha256 ?? '')
  )
    return undefined;
  return boundLoadingPreview(source, item.originalThumb);
}

/** For small catalog surfaces. Keep the original in src and file actions. */
export function catalogThumbnailAttributes(item: ImageSource & { thumbSrcSet?: string }) {
  const preview = imageLoadingPreview(item);
  return {
    srcset: preview?.url ?? item.thumbSrcSet,
    'data-catalog-thumbnail': preview ? '' : undefined,
  };
}

export function boundLoadingPreview(
  source: string,
  thumbnailURL: string | undefined,
): LoadingPreview | undefined {
  const original = publicLoadingImageURL(source);
  const thumbnail = publicLoadingImageURL(thumbnailURL);
  if (original && thumbnail && original !== thumbnail) return { source: original, url: thumbnail };
}

export function publicLoadingImageURL(source?: string) {
  try {
    const url = new URL(source ?? '');
    if (
      url.protocol === 'https:' &&
      url.hostname === 'assets.ultraclipart.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
    )
      return url.href;
  } catch {
    return undefined;
  }
}

/** The editor can paint a source-bound R2 thumbnail when no larger screen copy exists. */
export function editorDisplayPreview(item: ImageSource & {
  preview?: string;
  previewWidth?: number;
  previewHeight?: number;
}) {
  if (isEditorScreenURL(item.preview))
    return { url: item.preview!, width: item.previewWidth, height: item.previewHeight };
  const thumbnail = imageLoadingPreview(item);
  return thumbnail && { url: thumbnail.url };
}

export function isEditorScreenURL(url?: string) {
  return /^\/previews\/p1\/[a-f0-9]{24}-960\.webp$/.test(url ?? '');
}
