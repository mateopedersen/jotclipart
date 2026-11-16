type NativeShareAPI = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};
type NativeShareInput = { file?: File; title: string; text: string; url: string };

export function nativeShareMode(api: NativeShareAPI, file?: File): 'file' | 'link' | 'none' {
  if (typeof api.share !== 'function') return 'none';
  if (file && typeof api.canShare === 'function') {
    try {
      if (api.canShare({ files: [file] })) return 'file';
    } catch {
      // A capability probe can be denied or throw even though link sharing works.
      // This never invalidates an already prepared local PNG.
    }
  }
  return 'link';
}

// Invoke the OS API in the original click stack, before any promise or await.
// A rejected file handoff is not retried automatically after user activation ends.
export function handOffNativeShare(api: NativeShareAPI, input: NativeShareInput) {
  const mode = nativeShareMode(api, input.file);
  if (mode === 'none') return { mode, completion: Promise.resolve() };
  const data: ShareData =
    mode === 'file'
      ? { files: [input.file!], title: input.title, text: `${input.text}\n${input.url}` }
      : { title: input.title, text: input.text, url: input.url };
  try {
    return { mode, completion: Promise.resolve(api.share!(data)) };
  } catch (error) {
    return { mode, completion: Promise.reject(error) };
  }
}

export function shareWasCancelled(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
}
