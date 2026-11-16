import { originalImageFrameBounds } from '../lib/original-image-frame.mjs';

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
  let supportsObserver = typeof IntersectionObserver === 'function';
  if (supportsObserver) {
    try {
      const probe = new IntersectionObserver(() => {});
      probe.disconnect();
    } catch {
      supportsObserver = false;
    }
  }
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
    previewFrame?: HTMLElement;
    backdrop?: HTMLSpanElement;
    onLoad: () => void;
    onError: () => void;
  };
  const states = new WeakMap<HTMLImageElement, State>();
  const queue = new Set<State>(),
    active = new Set<State>(),
    exhausted = new Set<State>();
  const previewFrames = new WeakMap<Element, Set<State>>();
  const previewing = new Set<State>();
  const valid = (image: HTMLImageElement) => {
    try {
      const url = new URL(image.getAttribute('src') ?? '', location.href);
      return url.protocol === 'https:' && url.hostname === 'assets.jotclipart.com' ? url.href : '';
    } catch {
      return '';
    }
  };
  const previewFor = (image: HTMLImageElement, source: string) => {
    if (image.dataset.originalPlaceholderFor !== source) return '';
    try {
      const url = new URL(image.dataset.originalPlaceholder ?? '');
      return url.protocol === 'https:' &&
        url.hostname === 'assets.jotclipart.com' &&
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
    const s = states.get(image);
    s?.backdrop?.remove();
    if (s) {
      s.backdrop = undefined;
      previewing.delete(s);
    }
    delete image.dataset.originalPreview;
    image.style.removeProperty('--original-loading-preview');
  };
  const paintFramePreview = (s: State) => {
    const frame = s.previewFrame;
    if (
      !frame ||
      !frame.isConnected ||
      s.image.parentElement !== frame ||
      !s.preview ||
      valid(s.image) !== s.source ||
      s.image.dataset.originalImageState === 'error' ||
      (s.image.complete && s.image.naturalWidth > 0)
    )
      return;
    const style = getComputedStyle(frame);
    if (style.position === 'static') return;
    const padding = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
    // Pending originals are display:none to prevent native request flooding.
    // Their temporary thumbnail therefore needs its own fixed-frame paint box.
    // It never replaces src/srcset, file controls or image structured data.
    if (!s.backdrop) {
      s.backdrop = root.createElement('span');
      s.backdrop.className = 'original-image-loading-backdrop';
      s.backdrop.setAttribute('aria-hidden', 'true');
      frame.append(s.backdrop);
      previewing.add(s);
    }
    // Match the original's reserved content box, including responsive parent
    // padding. A full-frame thumbnail would appear to shrink when src finishes.
    [s.backdrop.style.top, s.backdrop.style.right, s.backdrop.style.bottom, s.backdrop.style.left] =
      padding;
    s.backdrop.style.backgroundImage = 'url(' + JSON.stringify(s.preview) + ')';
  };
  const forgetFramePreview = (s: State) => {
    if (!s.previewFrame) return;
    const frame = s.previewFrame;
    previewFrames.get(frame)?.delete(s);
    if (!previewFrames.get(frame)?.size) previewObserver?.unobserve(frame);
    s.previewFrame = undefined;
  };
  const previewFrameFor = (s: State) => {
    const frame = s.image.parentElement;
    if (!s.preview || !s.image.hasAttribute('data-original-deferred') || !frame) return;
    if (
      [...frame.children].some(
        (child) => child !== s.image && child !== s.backdrop && child !== s.note,
      )
    )
      return;
    if (
      [...frame.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
      )
    )
      return;
    return frame;
  };
  const watchFramePreview = (s: State) => {
    const frame = previewFrameFor(s);
    if (s.previewFrame === frame) return;
    clearPreview(s.image);
    forgetFramePreview(s);
    if (!frame || (s.image.complete && s.image.naturalWidth > 0)) return;
    s.previewFrame = frame;
    const members = previewFrames.get(frame) ?? new Set<State>();
    members.add(s);
    previewFrames.set(frame, members);
    previewObserver?.observe(frame);
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
    paintFramePreview(s);
  };
  const geometry = (s: State) =>
    (s.image.hasAttribute('data-original-deferred') ? s.image.parentElement : null) ?? s.image;
  const inView = (s: State) => {
    const r = originalImageFrameBounds(geometry(s));
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
    exhausted.delete(s);
    release(s);
    queue.delete(s);
    observer?.unobserve(s.image);
    viewportObserver?.unobserve(s.image);
    if (s.retry) clearTimeout(s.retry);
    s.retry = undefined;
    s.retryReady = false;
    status(s, 'loaded');
    forgetFramePreview(s);
    pump();
  }
  function scheduleRetry(s: State) {
    if (s.retry || s.retries >= delays.length || !s.visible || !inView(s) || root.hidden) return;
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
    // Actual failure must not depend on a delayed intersection callback. The
    // reserved frame stays measurable while a deferred/failed image is hidden.
    s.visible = inView(s);
    s.near = s.near || s.visible;
    s.top = geometry(s).getBoundingClientRect().top;
    s.retryReady = false;
    observer?.observe(s.image);
    viewportObserver?.observe(s.image);
    status(
      s,
      'error',
      s.retries < delays.length
        ? 'Retrying image…'
        : s.image.complete
          ? 'Image unavailable. Open artwork.'
          : 'Image still loading. Open artwork.',
    );
    if (s.retries >= delays.length && s.image.complete) {
      exhausted.add(s);
      s.image.dispatchEvent(new Event('uc:original-image-terminal-error'));
    }
    queue.add(s);
    scheduleRetry(s);
    pump();
  }
  function watch(s: State) {
    s.watch = setTimeout(() => {
      s.watch = undefined;
      if (s.image.complete && s.image.naturalWidth > 0) loaded(s);
      else if (s.image.complete) recover(s);
      else if (inView(s) && !root.hidden) {
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
  const admittedOrFailed = (s: State) =>
    s.image.dataset.originalImageState === 'error' ||
    marker.dataset.originalScheduling !== 'active' ||
    s.image.dataset.originalDeferred !== 'pending';
  function pump() {
    // Connectivity hints can be false while R2 remains reachable. Keep the
    // same two retry/promoted-slot limits and trust actual load/error results.
    if (root.hidden) return;
    const rank = (a: State, b: State) =>
      Number(b.visible) - Number(a.visible) ||
      Number(b.retryReady) - Number(a.retryReady) ||
      Number(b.preferred) - Number(a.preferred) ||
      a.top - b.top;
    const candidates = [...new Set([...queue, ...active])]
      .filter(
        (s) =>
          (s.visible || s.near) &&
          s.image.isConnected &&
          valid(s.image) === s.source &&
          admittedOrFailed(s) &&
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
    // Ready retries of visible failed originals must not wait behind healthy
    // preferred transfers. Rebalance promotion only; never abort their bytes.
    for (const s of [...queue].sort(rank)) {
      if (active.size >= 2) break;
      if (!s.image.isConnected || valid(s.image) !== s.source) {
        queue.delete(s);
        release(s);
        continue;
      }
      if (s.retry || s.active || !(s.visible || s.near) || !admittedOrFailed(s)) continue;
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
        s.image.dataset.originalRetryReset = 'true';
        s.image.removeAttribute('src');
        requestAnimationFrame(() => {
          if (states.get(s.image) !== s || !s.image.isConnected) return;
          if (s.image.getAttribute('src') === null) s.image.src = s.source;
          s.resetting = false;
          delete s.image.dataset.originalRetryReset;
          paintPreview(s);
          if (s.active) watch(s);
        });
      } else watch(s);
    }
  }
  // Observe the reserved parent, not the hidden pending img. This observer only
  // paints a small source-bound background; original admission stays bounded.
  const previewObserver = !supportsObserver
    ? undefined
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            for (const s of previewFrames.get(entry.target) ?? []) {
              if (
                entry.isIntersecting &&
                entry.intersectionRect.width > 0 &&
                entry.intersectionRect.height > 0
              )
                paintFramePreview(s);
              else {
                s.backdrop?.remove();
                s.backdrop = undefined;
                previewing.delete(s);
              }
            }
        },
        { rootMargin: '160px 0px' },
      );
  const viewportObserver = !supportsObserver
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
  const observer = !supportsObserver
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
    exhausted.delete(s);
    release(s);
    queue.delete(s);
    if (s.retry) clearTimeout(s.retry);
    image.removeEventListener('load', s.onLoad);
    image.removeEventListener('error', s.onError);
    observer?.unobserve(image);
    viewportObserver?.unobserve(image);
    s.note?.remove();
    clearPreview(image);
    forgetFramePreview(s);
    states.delete(image);
  }
  function register(image: HTMLImageElement) {
    const source = valid(image),
      preview = previewFor(image, source),
      previous = states.get(image);
    if (previous?.resetting && image.getAttribute('src') === null) return;
    if (previous?.source === source && previous.preview === preview) {
      watchFramePreview(previous);
      return;
    }
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
      watchFramePreview(s);
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
      if (r.type === 'childList' && r.target instanceof Element) {
        const affected = new Set([
          ...[...(previewFrames.get(r.target) ?? [])].map((s) => s.image),
          ...[...r.target.children].filter(
            (child): child is HTMLImageElement => child instanceof HTMLImageElement,
          ),
        ]);
        for (const image of affected) register(image);
      }
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
      const r = geometry(s).getBoundingClientRect();
      s.top = r.top;
      s.visible = inView(s);
      if (!viewportObserver) s.near = s.visible;
      else if (s.visible) s.near = true;
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
    { passive: true, capture: true },
  );
  window.addEventListener('resize', resume);
  window.addEventListener('resize', () => {
    for (const s of previewing) paintFramePreview(s);
  });
  window.addEventListener('online', () => {
    // A new connectivity event is a new bounded recovery opportunity, not an
    // unbounded retry timer. Keep terminal states reachable after queue removal.
    for (const s of exhausted) {
      exhausted.delete(s);
      if (!s.image.isConnected || valid(s.image) !== s.source) continue;
      s.retries = 0;
      s.retryReady = false;
      status(s, 'error', 'Retrying image…');
      queue.add(s);
    }
    resume();
  });
  root.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  pump();
}
