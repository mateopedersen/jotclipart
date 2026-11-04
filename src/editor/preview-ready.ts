import { nextPaint } from '../lib/initial-paint';
let pending: Promise<void> | undefined;
/** Give the server-rendered interface a frame. Its compact preview, consent
 * notice, region lookup and fonts load independently; none may hold the editing
 * original or tool initialization behind another network dependency. Original
 * byte, MIME, SHA and dimension verification remain in verified-fetch/raster. */
export function editorPreviewReady() {
  return (pending ??= nextPaint());
}
