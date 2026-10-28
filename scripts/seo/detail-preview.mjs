// Match the image inside the preview element, never an unrelated later image.
export function detailPreviewImage(html) {
  const container = html.match(
    /<([a-z][\w:-]*)\b[^>]*\bid="art-preview"[^>]*>([\s\S]*?)<\/\1\s*>/i,
  );
  return container?.[2].match(/<img\b[^>]*>/i)?.[0] || '';
}
