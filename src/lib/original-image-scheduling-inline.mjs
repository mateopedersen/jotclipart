// Run before the body is parsed. Native lazy-loading otherwise starts dozens of
// full originals at once in WebKit. The original src, bytes and file links stay
// untouched; only the first request's start is scheduled inside a stable frame.
export const originalImageSchedulingScript = String.raw`(() => {
  const root = document.documentElement;
  // A browser's history snapshot can retain DOM attributes without retaining
  // this execution's observers. Idempotence must use live JS state, not markup.
  const runtime = Symbol.for('ultraclipart:original-scheduling:v1');
  if (window[runtime]) return;
  window[runtime] = true;
  delete root.dataset.originalScheduling;
  if (typeof IntersectionObserver !== 'function' || typeof MutationObserver !== 'function') return;
  const selector = 'img[data-original-deferred="pending"]';
  const states = new WeakMap(), frames = new WeakMap(), queued = new Set(), active = new Set();
  let observer, nearObserver, mutations, watchdog, failed = false, scheduled = false;
  let progressAt = performance.now();
  const failOpen = () => {
    failed = true;
    root.dataset.originalScheduling = 'fallback';
    observer?.disconnect(); nearObserver?.disconnect(); mutations?.disconnect();
    clearInterval(watchdog);
    queued.clear();
  };
  const source = image => {
    try {
      const u = new URL(image.getAttribute('src') || '', location.href);
      return u.protocol === 'https:' && u.hostname === 'assets.ultraclipart.com' &&
        !u.username && !u.password && !u.port ? u.href : '';
    } catch { return ''; }
  };
  function pump() {
    scheduled = false;
    if (failed || document.hidden || !navigator.onLine) return;
    try {
      for (const s of active) s.image.fetchPriority = s.visible ? 'high' : 'low';
      const candidates = [...queued].filter(s => s.image.isConnected &&
        states.get(s.image) === s && source(s.image) === s.source && (s.visible || s.near))
        .sort((a,b) => Number(b.visible)-Number(a.visible) || a.top-b.top);
      for (const s of candidates) {
        if (active.size >= 4) break;
        // No more than two speculative transfers; leave room for visible work.
        if (!s.visible && [...active].filter(x => !x.visible).length >= 2) break;
        queued.delete(s);
        if (!active.size) progressAt = performance.now();
        active.add(s);
        s.image.fetchPriority = s.visible ? 'high' : 'low';
        s.image.dataset.originalDeferred = 'open';
        s.image.loading = 'eager';
        if (s.image.complete && s.image.naturalWidth > 0) s.finish();
      }
    } catch { failOpen(); }
  }
  const requestPump = () => {
    if (!scheduled && !failed) { scheduled = true; requestAnimationFrame(pump); }
  };
  const update = (entries, visible) => {
    try {
      for (const entry of entries) for (const s of frames.get(entry.target) || []) {
        s.top = entry.boundingClientRect.top;
        s[visible ? 'visible' : 'near'] = entry.isIntersecting &&
          entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
        // A caller without a fixed outer frame must fall back to native loading,
        // never disappear because the deferred image supplied its only height.
        if (entry.boundingClientRect.width > 0 && entry.boundingClientRect.height === 0) {
          s.image.dataset.originalDeferred = 'native'; queued.delete(s); continue;
        }
        if ((s.visible || s.near) && !active.has(s)) queued.add(s); else queued.delete(s);
      }
      requestPump();
    } catch { failOpen(); }
  };
  const register = image => {
    const previous = states.get(image);
    if (previous && image.dataset.originalRetryReset === 'true' && image.getAttribute('src') === null) return;
    if (previous && previous.source !== source(image)) previous.finish();
    if (states.has(image) || image.dataset.originalDeferred !== 'pending') return;
    const url = source(image), frame = image.parentElement;
    if (!url || !frame || image.loading !== 'lazy') {
      image.dataset.originalDeferred = 'native'; return;
    }
    const s = {image, source:url, frame, visible:false, near:false, top:0};
    s.finish = () => {
      progressAt = performance.now();
      active.delete(s); queued.delete(s);
      if (states.get(image) === s) states.delete(image);
      image.removeEventListener('load',s.finish); image.removeEventListener('error',s.finish);
      image.removeEventListener('uc:original-image-terminal-error',s.finish);
      frames.get(frame)?.delete(s);
      if (!frames.get(frame)?.size) { observer.unobserve(frame); nearObserver.unobserve(frame); }
      requestPump();
    };
    states.set(image,s);
    const set = frames.get(frame) || new Set(); set.add(s); frames.set(frame,set);
    // Reserve this same slot through the existing bounded recovery attempts.
    // Releasing it on the first error lets that retry race a new original.
    image.addEventListener('load',s.finish);
    image.addEventListener('uc:original-image-terminal-error',s.finish);
    observer.observe(frame); nearObserver.observe(frame);
  };
  const discover = node => {
    if (node instanceof HTMLImageElement) register(node);
    if (node instanceof Element) for (const image of node.querySelectorAll(selector)) register(image);
  };
  try {
    observer = new IntersectionObserver(entries => update(entries,true));
    nearObserver = new IntersectionObserver(entries => update(entries,false), {rootMargin:'160px 0px'});
    mutations = new MutationObserver(records => {
      try {
        for (const record of records) {
          if (record.type === 'attributes') register(record.target);
          for (const node of record.addedNodes) discover(node);
          for (const node of record.removedNodes) {
            const removed = node instanceof HTMLImageElement ? [node] :
              node instanceof Element ? [...node.querySelectorAll('img[data-original-deferred]')] : [];
            for (const image of removed) if (!image.isConnected) states.get(image)?.finish();
          }
        }
      } catch { failOpen(); }
    });
    mutations.observe(document,{subtree:true,childList:true,attributes:true,
      attributeFilter:['src','data-original-deferred']});
    root.dataset.originalScheduling = 'active';
    for (const image of document.querySelectorAll('img[data-original-deferred="open"]')) {
      if (!image.complete || !image.naturalWidth) {
        image.loading = 'lazy'; image.dataset.originalDeferred = 'pending';
      }
    }
    discover(root);
    watchdog = setInterval(() => {
      if (failed || document.hidden || !navigator.onLine || document.readyState === 'loading') return;
      try {
        // Never restart or discard a healthy request. If scheduling cannot make
        // progress, remove this enhancement and let native original loading work.
        if (active.size && performance.now()-progressAt > 15000) { failOpen(); return; }
        if (!active.size && !queued.size) {
          // This is the bounded rendered DOM, never the remote catalogue. A
          // restored deep scroll may be beyond the first 32 pending frames.
          const pending = [...document.querySelectorAll(selector)];
          if (pending.some(i => { const r=i.parentElement.getBoundingClientRect();
            return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth;
          })) failOpen();
        }
      } catch { failOpen(); }
    },2500);
    addEventListener('pageshow',requestPump);
    addEventListener('online',requestPump);
    document.addEventListener('visibilitychange',requestPump);
    // Printing needs the complete document, including images outside the screen.
    addEventListener('beforeprint',() => {
      failOpen();
      for (const image of document.querySelectorAll(selector)) image.loading = 'eager';
    },{once:true});
  } catch { failOpen(); }
})();
`;
