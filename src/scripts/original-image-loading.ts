/** Original R2 URLs stay in SSR src and schema. Only loading priority and retries change. */
export function initOriginalImageLoading(
  root: Document = document,
  timing: { retryDelays?: number[]; stallMs?: number } = {},
) {
  const marker = root.documentElement;
  if (marker.dataset.originalImageLoading) return;
  const delays = timing.retryDelays ?? [800, 2400];
  const stallMs = timing.stallMs ?? 45000;
  if (
    delays.length !== 2 ||
    delays.some((x) => !Number.isFinite(x) || x < 10 || x > 10000) ||
    !Number.isFinite(stallMs) ||
    stallMs < 100 ||
    stallMs > 60000
  )
    throw Error('Bounded image recovery required');
  marker.dataset.originalImageLoading = 'initializing';
  // A native responsive candidate can fail independently of its R2 original.
  // Fall back once, including when the error arrived before this module.
  const fallbackThumbnail = (target: EventTarget | null) => {
    if (!(target instanceof HTMLImageElement) || !target.hasAttribute('data-catalog-thumbnail'))
      return;
    target.removeAttribute('data-catalog-thumbnail');
    target.removeAttribute('srcset');
  };
  root.addEventListener('error', (event) => fallbackThumbnail(event.target), true);
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-catalog-thumbnail]'))
    if (image.complete && image.currentSrc && !image.naturalWidth) fallbackThumbnail(image);
  type State = {
    image: HTMLImageElement;
    source: string;
    preferred: boolean;
    preview: string;
    previewState: 'idle' | 'loading' | 'ready' | 'failed';
    target: Element;
    frame?: HTMLElement;
    previewObjectURL?: string;
    cancelPreview?: (defer?: boolean) => void;
    retries: number;
    near: boolean;
    visible: boolean;
    top: number;
    active: boolean;
    retryReady: boolean;
    resetting: boolean;
    retry?: ReturnType<typeof setTimeout>;
    watch?: ReturnType<typeof setTimeout>;
    note?: HTMLSpanElement;
    onLoad: () => void;
    onError: () => void;
  };
  const states = new WeakMap<HTMLImageElement, State>();
  const targets = new WeakMap<Element, State>();
  const queue = new Set<State>(),
    active = new Set<State>();
  const previewQueue = new Set<State>(),
    activePreviews = new Set<State>();
  const rank = (a: State, b: State) =>
    Number(b.visible) - Number(a.visible) ||
    Number(b.preferred) - Number(a.preferred) ||
    Math.abs(a.top) - Math.abs(b.top);
  const valid = (image: HTMLImageElement) => {
    try {
      const url = new URL(image.getAttribute('src') ?? '', location.href);
      return url.protocol === 'https:' && url.hostname === 'assets.ultraclipart.com'
        ? url.href
        : '';
    } catch {
      return '';
    }
  };
  const previewFor = (image: HTMLImageElement, source: string) => {
    if (image.dataset.originalPlaceholderFor !== source) return '';
    try {
      const url = new URL(image.dataset.originalPlaceholder ?? '');
      return url.protocol === 'https:' &&
        url.hostname === 'assets.ultraclipart.com' &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.href !== source
        ? url.href
        : '';
    } catch {
      return '';
    }
  };
  const clearPreview = (image: HTMLImageElement) => {
    const state = states.get(image);
    const frame = state?.frame;
    if (state?.previewObjectURL) {
      URL.revokeObjectURL(state.previewObjectURL);
      state.previewObjectURL = undefined;
    }
    frame?.removeAttribute('data-card-loading-preview');
    frame?.style.removeProperty('--original-loading-preview');
    delete image.dataset.originalPreview;
    image.style.removeProperty('--original-loading-preview');
  };
  const paintPreview = (s: State) => {
    if (
      !s.preview ||
      s.previewState !== 'ready' ||
      valid(s.image) !== s.source ||
      s.image.dataset.originalImageState === 'error' ||
      (s.image.complete && s.image.naturalWidth > 0)
    )
      return;
    (s.frame ?? s.image).style.setProperty(
      '--original-loading-preview',
      'url(' + JSON.stringify(s.previewObjectURL ?? s.preview) + ')',
    );
    if (s.frame) s.frame.dataset.cardLoadingPreview = '';
    s.image.dataset.originalPreview = 'pending';
  };
  const inView = (s: State) => {
    const r = s.target.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      r.right > 0 &&
      r.left < innerWidth
    );
  };
  function pumpPreviews() {
    if (root.hidden || !navigator.onLine) return;
    const candidates = [...previewQueue].sort(rank);
    if (activePreviews.size >= 8 && candidates.some((s) => s.visible)) {
      // A jump down the page should not sit behind previews for the old row.
      for (const s of activePreviews) if (!s.visible) s.cancelPreview?.(true);
    }
    for (const s of candidates) {
      if (activePreviews.size >= 8) break;
      if (!s.visible && activePreviews.size >= 2) continue;
      previewQueue.delete(s);
      if (
        !s.near ||
        s.previewState !== 'idle' ||
        !s.image.isConnected ||
        states.get(s.image) !== s ||
        (s.image.complete && s.image.naturalWidth > 0)
      )
        continue;
      s.previewState = 'loading';
      activePreviews.add(s);
      const controller = new AbortController();
      let deferred = false;
      // The native lazy loader may already have queued many large originals.
      // Give nearby small images their own bounded, higher priority window.
      function finish(blob?: Blob, useDirectBackground = false) {
        if (s.previewState !== 'loading') return;
        clearTimeout(timeout);
        s.cancelPreview = undefined;
        activePreviews.delete(s);
        s.previewState =
          blob || useDirectBackground
            ? 'ready'
            : deferred || (controller.signal.aborted && !s.near && !s.visible)
              ? 'idle'
              : 'failed';
        if (
          s.previewState === 'ready' &&
          states.get(s.image) === s &&
          s.image.dataset.originalImageState !== 'error' &&
          !(s.image.complete && s.image.naturalWidth > 0)
        ) {
          if (blob) s.previewObjectURL = URL.createObjectURL(blob);
          paintPreview(s);
        }
        if (deferred && s.near && states.get(s.image) === s) preparePreview(s);
        pumpPreviews();
        pump();
      }
      const timeout = setTimeout(() => controller.abort(), 5000);
      s.cancelPreview = (defer = false) => {
        deferred = defer;
        controller.abort();
      };
      fetch(s.preview, { signal: controller.signal, credentials: 'omit', priority: 'high' })
        .then(async (response) => {
          if (!response.ok || !/^image\//.test(response.headers.get('content-type') ?? ''))
            return finish();
          const blob = await response.blob();
          finish(blob.size > 0 && blob.size <= 512 * 1024 ? blob : undefined);
        })
        .catch(() => finish(undefined, !controller.signal.aborted));
    }
  }
  function preparePreview(s: State) {
    if (s.preview && s.previewState === 'idle' && !s.image.dataset.originalPreview)
      previewQueue.add(s);
  }
  function status(s: State, value: string, text = '') {
    s.image.dataset.originalImageState = value;
    if (value === 'loaded' || value === 'error') clearPreview(s.image);
    if (!text) {
      s.note?.remove();
      s.note = undefined;
      return;
    }
    const frame = s.image.closest<HTMLElement>('.art-picture');
    if (!frame) return;
    if (!s.note) {
      s.note = root.createElement('span');
      s.note.className = 'original-image-status';
      s.note.setAttribute('role', 'status');
      frame.append(s.note);
    }
    s.note.textContent = text;
  }
  function release(s: State) {
    if (s.watch) clearTimeout(s.watch);
    s.watch = undefined;
    s.active = false;
    active.delete(s);
    // A demoted request may continue normally. Its old promoted marker must not
    // masquerade as another active high-priority slot after scrolling/rebalance.
    if (s.image.dataset.originalImageState === 'loading') status(s, 'pending');
  }
  function loaded(s: State, reschedule = true) {
    release(s);
    s.cancelPreview?.();
    delete s.image.dataset.originalRequestHeld;
    queue.delete(s);
    previewQueue.delete(s);
    observer?.unobserve(s.target);
    viewportObserver?.unobserve(s.target);
    if (s.retry) clearTimeout(s.retry);
    s.retry = undefined;
    s.retryReady = false;
    status(s, 'loaded');
    if (reschedule) pump();
  }
  function scheduleRetry(s: State) {
    if (
      s.retry ||
      s.retries >= delays.length ||
      !navigator.onLine ||
      !s.visible ||
      !inView(s) ||
      root.hidden
    )
      return;
    const delay = delays[s.retries++];
    s.retry = setTimeout(() => {
      s.retry = undefined;
      if (!s.image.isConnected || valid(s.image) !== s.source) return;
      s.retryReady = true;
      queue.add(s);
      pump();
    }, delay);
  }
  function recover(s: State) {
    release(s);
    if (!s.image.isConnected || valid(s.image) !== s.source) return;
    s.retryReady = false;
    observer?.observe(s.target);
    viewportObserver?.observe(s.target);
    status(
      s,
      'error',
      !navigator.onLine
        ? 'Waiting for connection…'
        : s.retries < delays.length
          ? 'Retrying image…'
          : s.image.complete
            ? 'Image unavailable. Open artwork.'
            : 'Image still loading. Open artwork.',
    );
    queue.add(s);
    scheduleRetry(s);
    pump();
  }
  function watch(s: State) {
    s.watch = setTimeout(() => {
      s.watch = undefined;
      if (s.image.complete && s.image.naturalWidth > 0) loaded(s);
      else if (s.image.complete) recover(s);
      else if (inView(s) && !root.hidden && navigator.onLine) {
        // A large original over a slow connection may still be transferring.
        // Do not discard its progress merely because a timer expired. Actual
        // error events retain bounded retries; this transfer can finish intact.
        release(s);
        status(s, 'slow', 'Image is still loading. Open artwork.');
        pump();
      } else {
        release(s);
        pump();
      }
    }, stallMs);
  }
  function pump() {
    if (root.hidden || !navigator.onLine) return;
    const readyToPromote = (s: State) =>
      !s.image.hasAttribute('data-search-preview-awaiting') &&
      (!s.preview ||
        s.preferred ||
        s.previewState === 'ready' ||
        s.previewState === 'failed' ||
        Boolean(s.image.dataset.originalPreview) ||
        s.image.dataset.originalImageState === 'error');
    const candidates = [...new Set([...queue, ...active])]
      .filter(
        (s) =>
          s.visible &&
          s.image.isConnected &&
          valid(s.image) === s.source &&
          readyToPromote(s) &&
          !s.retry &&
          !(s.image.complete && s.image.naturalWidth > 0) &&
          (s.image.dataset.originalImageState !== 'error' || s.retryReady),
      )
      .sort(rank);
    const desired = new Set(candidates.slice(0, 2));
    for (const s of [...active])
      if (!desired.has(s)) {
        release(s);
        s.image.fetchPriority = s.preview ? 'low' : 'auto';
        queue.add(s);
      }
    for (const s of [...queue].sort(rank)) {
      if (active.size >= 2) break;
      if (!s.image.isConnected || valid(s.image) !== s.source) {
        queue.delete(s);
        release(s);
        continue;
      }
      if (s.retry || s.active || !s.visible || !readyToPromote(s)) continue;
      const failed = s.image.dataset.originalImageState === 'error';
      if (!failed && s.image.complete && s.image.naturalWidth > 0) {
        loaded(s, false);
        continue;
      }
      if (failed && !s.retryReady) {
        if (s.retries >= delays.length) {
          queue.delete(s);
          continue;
        }
        scheduleRetry(s);
        continue;
      }
      if (failed && !inView(s)) continue;
      queue.delete(s);
      s.active = true;
      active.add(s);
      s.image.fetchPriority = s.visible ? 'high' : 'auto';
      delete s.image.dataset.originalRequestHeld;
      s.image.loading = 'eager';
      status(s, 'loading');
      paintPreview(s);
      if (failed) {
        // WebKit retains a failed image request when src is assigned the same
        // value directly. Reset only that failed element for one frame, then
        // restore the identical immutable URL; no derivative or query is used.
        s.retryReady = false;
        s.resetting = true;
        s.image.removeAttribute('src');
        requestAnimationFrame(() => {
          if (states.get(s.image) !== s || !s.image.isConnected) return;
          if (s.image.getAttribute('src') === null) s.image.src = s.source;
          s.resetting = false;
          paintPreview(s);
          if (s.active) watch(s);
        });
      } else watch(s);
    }
  }
  const viewportObserver =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const s = targets.get(entry.target);
              if (!s) continue;
              const r = entry.boundingClientRect;
              s.visible =
                entry.isIntersecting &&
                entry.intersectionRect.width > 0 &&
                entry.intersectionRect.height > 0;
              s.top = r.top;
              if (s.visible) {
                s.near = true;
                queue.add(s);
                preparePreview(s);
              }
              if (s.active && !s.visible) {
                release(s);
                s.image.fetchPriority = s.preview ? 'low' : 'auto';
                if (s.near) queue.add(s);
              }
              if (!s.active && !s.image.complete) {
                const overlapsViewport =
                  r.width > 0 &&
                  r.height > 0 &&
                  r.bottom > 0 &&
                  r.top < innerHeight &&
                  r.right > 0 &&
                  r.left < innerWidth;
                const horizontallyOffscreen =
                  r.width > 0 &&
                  r.height > 0 &&
                  r.bottom > 0 &&
                  r.top < innerHeight &&
                  (r.right <= 0 || r.left >= innerWidth);
                s.image.fetchPriority =
                  s.preview || horizontallyOffscreen || (overlapsViewport && !s.visible)
                    ? 'low'
                    : 'auto';
              }
              paintPreview(s);
            }
            pumpPreviews();
            pump();
          },
          { rootMargin: '0px' },
        );
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const s = targets.get(entry.target);
              if (!s) continue;
              s.near = entry.isIntersecting;
              s.top = entry.boundingClientRect.top;
              const r = entry.boundingClientRect;
              if (s.near && r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth) {
                queue.add(s);
                preparePreview(s);
              } else {
                queue.delete(s);
                previewQueue.delete(s);
                if (!s.visible) s.cancelPreview?.();
              }
            }
            pumpPreviews();
            pump();
          },
          { rootMargin: `${Math.min(800, Math.max(320, Math.round(innerHeight * 0.75)))}px 0px` },
        );
  function remove(image: HTMLImageElement) {
    const s = states.get(image);
    if (!s) return;
    s.cancelPreview?.();
    release(s);
    queue.delete(s);
    if (s.retry) clearTimeout(s.retry);
    image.removeEventListener('load', s.onLoad);
    image.removeEventListener('error', s.onError);
    previewQueue.delete(s);
    observer?.unobserve(s.target);
    viewportObserver?.unobserve(s.target);
    targets.delete(s.target);
    s.note?.remove();
    clearPreview(image);
    delete image.dataset.originalRequestHeld;
    delete image.dataset.originalImageState;
    states.delete(image);
  }
  function register(image: HTMLImageElement) {
    const source = valid(image),
      preview = previewFor(image, source),
      previous = states.get(image);
    if (previous?.resetting && image.getAttribute('src') === null) return;
    if (previous?.source === source && previous.preview === preview) return;
    if (previous) remove(image);
    if (!source) return;
    if (!preview) clearPreview(image);
    const frame = image.parentElement;
    // Card frames have stable geometry even when content-visibility skips the
    // image inside them. Observe that frame before its children are laid out.
    const cardFrame =
      frame?.matches('.art-picture') &&
      frame.querySelector('img') === image &&
      frame.querySelectorAll('img').length === 1
        ? frame
        : undefined;
    const target = cardFrame ?? image;
    const s: State = {
      image,
      source,
      preferred: image.getAttribute('fetchpriority') === 'high',
      preview,
      previewState: 'idle',
      target,
      frame: cardFrame,
      retries: 0,
      near: false,
      visible: false,
      top: 0,
      active: false,
      retryReady: false,
      resetting: false,
      onLoad: () => {
        if (states.get(image) === s && valid(image) === s.source) {
          if (image.naturalWidth > 0) loaded(s);
          else recover(s);
        }
      },
      onError: () => {
        if (!s.resetting) recover(s);
      },
    };
    states.set(image, s);
    targets.set(target, s);
    image.addEventListener('load', s.onLoad);
    image.addEventListener('error', s.onError);
    if (image.complete && image.naturalWidth > 0) status(s, 'loaded');
    else {
      // IntersectionObserver batches geometry after layout. Measuring every
      // image between state writes forces repeated full-document layouts.
      if (!observer) {
        s.visible = inView(s);
        s.near = s.visible;
        s.top = target.getBoundingClientRect().top;
      }
      if (image.complete) status(s, 'error');
      if (preview && !s.preferred) image.fetchPriority = 'low';
      if (cardFrame && preview && image.loading === 'lazy' && viewportObserver && !image.complete)
        image.dataset.originalRequestHeld = '';
      if (s.visible) {
        queue.add(s);
        preparePreview(s);
      }
      observer?.observe(target);
      viewportObserver?.observe(target);
    }
  }
  const images = (node: Node) =>
    node instanceof HTMLImageElement
      ? [node]
      : node instanceof Element
        ? [...node.querySelectorAll<HTMLImageElement>('img')]
        : [];
  for (const image of root.images) register(image);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target instanceof HTMLImageElement) register(r.target);
      for (const node of r.removedNodes)
        for (const image of images(node)) if (!image.isConnected) remove(image);
      for (const node of r.addedNodes) for (const image of images(node)) register(image);
    }
    pump();
  }).observe(root.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'src',
      'data-original-placeholder',
      'data-original-placeholder-for',
      'data-search-preview-awaiting',
    ],
  });
  const resume = () => {
    for (const s of new Set([...queue, ...active])) {
      const r = s.target.getBoundingClientRect();
      s.top = r.top;
      if (!viewportObserver) {
        s.visible = inView(s);
        s.near = s.visible;
        if (s.visible) preparePreview(s);
      }
      if (s.active && !s.visible) {
        release(s);
        s.image.fetchPriority = s.preview ? 'low' : 'auto';
        if (s.near) queue.add(s);
        else queue.delete(s);
      }
      if (s.active) s.image.fetchPriority = s.visible ? 'high' : 'auto';
    }
    pumpPreviews();
    pump();
  };
  let scrollFrame = 0;
  if (!viewportObserver)
    window.addEventListener(
      'scroll',
      () => {
        if (!scrollFrame)
          scrollFrame = requestAnimationFrame(() => {
            scrollFrame = 0;
            resume();
          });
      },
      { passive: true },
    );
  window.addEventListener('resize', resume);
  window.addEventListener('online', resume);
  root.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  marker.dataset.originalImageLoading = 'ready';
  delete marker.dataset.galleryImageStartup;
  pumpPreviews();
  pump();
}
