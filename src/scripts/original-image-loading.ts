/** Original R2 URLs stay in SSR src and schema. Only loading priority and retries change. */
export function initOriginalImageLoading(
  root: Document = document,
  timing: { retryDelays?: number[]; stallMs?: number } = {},
) {
  const marker = root.documentElement;
  if (marker.dataset.originalImageLoading === 'ready') return;
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
  marker.dataset.originalImageLoading = 'ready';
  type State = {
    image: HTMLImageElement;
    source: string;
    preferred: boolean;
    preview: string;
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
  const queue = new Set<State>(),
    active = new Set<State>();
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
    delete image.dataset.originalPreview;
    image.style.removeProperty('--original-loading-preview');
  };
  const paintPreview = (s: State) => {
    if (
      !s.preview ||
      !s.near ||
      valid(s.image) !== s.source ||
      s.image.dataset.originalImageState === 'error' ||
      (s.image.complete && s.image.naturalWidth > 0)
    )
      return;
    s.image.style.setProperty(
      '--original-loading-preview',
      'url(' + JSON.stringify(s.preview) + ')',
    );
    s.image.dataset.originalPreview = 'pending';
  };
  const inView = (s: State) => {
    const r = s.image.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      r.right > 0 &&
      r.left < innerWidth
    );
  };
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
  function loaded(s: State) {
    release(s);
    queue.delete(s);
    observer?.unobserve(s.image);
    viewportObserver?.unobserve(s.image);
    if (s.retry) clearTimeout(s.retry);
    s.retry = undefined;
    s.retryReady = false;
    status(s, 'loaded');
    pump();
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
    observer?.observe(s.image);
    viewportObserver?.observe(s.image);
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
    const rank = (a: State, b: State) =>
      Number(b.visible) - Number(a.visible) ||
      Number(b.preferred) - Number(a.preferred) ||
      a.top - b.top;
    const candidates = [...new Set([...queue, ...active])]
      .filter(
        (s) =>
          (s.visible || s.near) &&
          s.image.isConnected &&
          valid(s.image) === s.source &&
          !s.retry &&
          !(s.image.complete && s.image.naturalWidth > 0) &&
          (s.image.dataset.originalImageState !== 'error' || s.retryReady),
      )
      .sort(rank);
    const desired = new Set(candidates.slice(0, 2));
    for (const s of [...active])
      if (!desired.has(s)) {
        release(s);
        s.image.fetchPriority = 'auto';
        queue.add(s);
      }
    for (const s of [...queue].sort(
      (a, b) =>
        Number(b.visible) - Number(a.visible) ||
        Number(b.preferred) - Number(a.preferred) ||
        a.top - b.top,
    )) {
      if (active.size >= 2) break;
      if (!s.image.isConnected || valid(s.image) !== s.source) {
        queue.delete(s);
        release(s);
        continue;
      }
      if (s.retry || s.active || !(s.visible || s.near)) continue;
      const failed = s.image.dataset.originalImageState === 'error';
      if (!failed && s.image.complete && s.image.naturalWidth > 0) {
        queue.delete(s);
        observer?.unobserve(s.image);
        viewportObserver?.unobserve(s.image);
        status(s, 'loaded');
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
              const s = states.get(entry.target as HTMLImageElement);
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
              }
              if (s.active && !s.visible && !s.near) {
                release(s);
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
                  horizontallyOffscreen || (overlapsViewport && !s.visible) ? 'low' : 'auto';
              }
              paintPreview(s);
            }
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
              const s = states.get(entry.target as HTMLImageElement);
              if (!s) continue;
              s.near = entry.isIntersecting;
              s.top = entry.boundingClientRect.top;
              if (s.near) queue.add(s);
              else queue.delete(s);
            }
            pump();
          },
          { rootMargin: `${Math.min(600, Math.max(240, Math.round(innerHeight / 2)))}px 0px` },
        );
  function remove(image: HTMLImageElement) {
    const s = states.get(image);
    if (!s) return;
    release(s);
    queue.delete(s);
    if (s.retry) clearTimeout(s.retry);
    image.removeEventListener('load', s.onLoad);
    image.removeEventListener('error', s.onError);
    observer?.unobserve(image);
    viewportObserver?.unobserve(image);
    s.note?.remove();
    clearPreview(image);
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
    const s: State = {
      image,
      source,
      preferred: image.getAttribute('fetchpriority') === 'high',
      preview,
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
    image.addEventListener('load', s.onLoad);
    image.addEventListener('error', s.onError);
    if (image.complete && image.naturalWidth > 0) status(s, 'loaded');
    else {
      // IntersectionObserver batches geometry after layout. Measuring every
      // image between state writes forces repeated full-document layouts.
      if (!observer) {
        s.visible = inView(s);
        s.near = s.visible;
        s.top = image.getBoundingClientRect().top;
      }
      if (image.complete) status(s, 'error');
      if (s.visible) queue.add(s);
      observer?.observe(image);
      viewportObserver?.observe(image);
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
    attributeFilter: ['src', 'data-original-placeholder', 'data-original-placeholder-for'],
  });
  const resume = () => {
    for (const s of new Set([...queue, ...active])) {
      const r = s.image.getBoundingClientRect();
      s.top = r.top;
      if (!viewportObserver) {
        s.visible = inView(s);
        s.near = s.visible;
      }
      if (s.active && !s.visible && !s.near) {
        release(s);
        s.image.fetchPriority = 'auto';
        if (s.near) queue.add(s);
        else queue.delete(s);
      }
      if (s.active) s.image.fetchPriority = s.visible ? 'high' : 'auto';
    }
    pump();
  };
  let scrollFrame = 0;
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
  pump();
}
