import { originalImageFrameBounds } from './original-image-frame.mjs';
// Run before the body is parsed. Native lazy-loading otherwise starts dozens of
// full originals at once in WebKit. The original src, bytes and file links stay
// untouched; only the first request's start is scheduled inside a stable frame.
export const originalImageSchedulingSource = String.raw`(() => {
  const frameBounds = ${originalImageFrameBounds.toString()};
  const root = document.documentElement;
  // A browser's history snapshot can retain DOM attributes without retaining
  // this execution's observers. Idempotence must use live JS state, not markup.
  const runtime = Symbol.for('ultraclipart:original-scheduling:v1');
  if (window[runtime]) return;
  window[runtime] = true;
  delete root.dataset.originalScheduling;
  if (typeof IntersectionObserver !== 'function' || typeof MutationObserver !== 'function') return;
  const selector = 'img[data-original-deferred="pending"]';
  const states = new WeakMap(), frames = new WeakMap(), watched = new Set(), queued = new Set(), active = new Set();
  let observer, nearObserver, mutations, watchdog, failed = false, scheduled = false, refreshScheduled = false;
  const failOpen = () => {
    failed = true;
    root.dataset.originalScheduling = 'fallback';
    observer?.disconnect(); nearObserver?.disconnect(); mutations?.disconnect();
    clearInterval(watchdog);
    queued.clear(); watched.clear();
  };
  // navigator.onLine is only an unreliable connectivity hint. Actual image
  // results drive loading and recovery; the hint must not gate the queue.
  const source = image => {
    try {
      const u = new URL(image.getAttribute('src') || '', location.href);
      return u.protocol === 'https:' && u.hostname === 'assets.ultraclipart.com' &&
        !u.username && !u.password && !u.port ? u.href : '';
    } catch { return ''; }
  };
  function pump() {
    scheduled = false;
    if (failed || document.hidden) return;
    try {
      for (const s of active) s.image.fetchPriority = s.visible ? 'high' : 'low';
      const candidates = [...queued].filter(s => s.image.isConnected &&
        states.get(s.image) === s && source(s.image) === s.source && (s.visible || s.near))
        .sort((a,b) => Number(b.visible)-Number(a.visible) || a.top-b.top);
      for (const s of candidates) {
        // Keep old healthy transfers intact, but reserve two bounded admission
        // slots when scrolling would otherwise leave the visible viewport idle.
        const visibleActive = [...active].filter(x => x.visible).length;
        if (active.size >= 6 && (!s.visible || active.size >= 8 || visibleActive >= 2)) break;
        // No more than two speculative transfers; leave room for visible work.
        if (!s.visible && [...active].filter(x => !x.visible).length >= 2) break;
        queued.delete(s);
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
  // Native intersection notifications can arrive after a quick scroll or a
  // dynamically inserted gallery. Reconcile only this rendered DOM once per
  // animation frame, using fixed outer frames, before the same bounded pump.
  const requestRefresh = () => {
    if (failed || refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      if (failed || document.hidden) return;
      try {
        const geometryCache = new Map();
        for (const s of watched) {
          if (!s.image.isConnected) { s.finish(); continue; }
          if (s.image.dataset.originalRetryReset === 'true' && s.image.getAttribute('src') === null) continue;
          if (source(s.image) !== s.source) { s.finish(); continue; }
          const r = frameBounds(s.frame, geometryCache);
          const area = r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
          s.top = r.sourceTop;
          s.visible = area && r.bottom > 0 && r.top < innerHeight;
          s.near = area && r.bottom > -160 && r.top < innerHeight + 160;
          if ((s.visible || s.near) && !active.has(s)) queued.add(s); else queued.delete(s);
        }
        requestPump();
      } catch { failOpen(); }
    });
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
      active.delete(s); queued.delete(s); watched.delete(s);
      if (states.get(image) === s) states.delete(image);
      image.removeEventListener('load',s.finish); image.removeEventListener('error',s.finish);
      image.removeEventListener('uc:original-image-terminal-error',s.finish);
      frames.get(frame)?.delete(s);
      if (!frames.get(frame)?.size) { observer.unobserve(frame); nearObserver.unobserve(frame); }
      requestPump();
    };
    states.set(image,s); watched.add(s);
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
        requestRefresh();
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
    requestRefresh();
    watchdog = setInterval(() => {
      if (failed || document.hidden || document.readyState === 'loading') return;
      try {
        // Never restart or discard a healthy request. If scheduling cannot make
        // progress, remove this enhancement and let native original loading work.
        // A healthy large original is not evidence that the scheduler failed.
        // Dropping the gate here starts the rest of the gallery concurrently.
        // Fall back only when recovery never initialized and every held request
        // has actually failed, not while any original is still transferring.
        if (active.size && root.dataset.originalImageLoading !== 'ready' &&
          [...active].every(s => s.image.complete && !s.image.naturalWidth)) { failOpen(); return; }
        if (!active.size && !queued.size) {
          // This is the bounded rendered DOM, never the remote catalogue. A
          // restored deep scroll may be beyond the first 32 pending frames.
          const pending = [...document.querySelectorAll(selector)];
          const geometryCache = new Map();
          if (pending.some(i => { const r=frameBounds(i.parentElement,geometryCache);
            return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth;
          })) failOpen();
        }
      } catch { failOpen(); }
    },2500);
    addEventListener('pageshow',requestRefresh);
    addEventListener('scroll',requestRefresh,{passive:true,capture:true});
    addEventListener('resize',requestRefresh);
    addEventListener('online',requestPump);
    document.addEventListener('visibilitychange',requestRefresh);
    // Printing needs the complete document, including images outside the screen.
    addEventListener('beforeprint',() => {
      failOpen();
      for (const image of document.querySelectorAll(selector)) image.loading = 'eager';
    },{once:true});
  } catch { failOpen(); }
})();
`;

// Generated from the reviewed source above. The runtime build rejects any drift.
export const originalImageSchedulingScript = "(()=>{const W=function(e,n=new Map){const i=e.getBoundingClientRect();let r=i.left,f=i.right,g=i.top,M=i.bottom;for(let o=e.parentElement;o;o=o.parentElement){let s=n.get(o);if(!s){const m=getComputedStyle(o),T=/^(auto|scroll|hidden|clip)$/.test(m.overflowX),k=/^(auto|scroll|hidden|clip)$/.test(m.overflowY);if(s={x:T,y:k,hidden:o.hidden||m.display===\"none\"||m.visibility===\"hidden\"||m.visibility===\"collapse\"||m.contentVisibility===\"hidden\"},T||k){const S=o.getBoundingClientRect(),D=o.offsetWidth?S.width/o.offsetWidth:1,B=o.offsetHeight?S.height/o.offsetHeight:1;s.left=S.left+o.clientLeft*D,s.right=s.left+o.clientWidth*D,s.top=S.top+o.clientTop*B,s.bottom=s.top+o.clientHeight*B}n.set(o,s)}if(s.hidden)return{top:g,bottom:g,left:r,right:r,width:0,height:0,sourceTop:i.top};s.x&&(r=Math.max(r,s.left),f=Math.min(f,s.right)),s.y&&(g=Math.max(g,s.top),M=Math.min(M,s.bottom))}return{top:g,bottom:M,left:r,right:f,width:Math.max(0,f-r),height:Math.max(0,M-g),sourceTop:i.top}},p=document.documentElement,x=Symbol.for(\"ultraclipart:original-scheduling:v1\");if(window[x]||(window[x]=!0,delete p.dataset.originalScheduling,typeof IntersectionObserver!=\"function\"||typeof MutationObserver!=\"function\"))return;const R='img[data-original-deferred=\"pending\"]',d=new WeakMap,v=new WeakMap,b=new Set,l=new Set,a=new Set;let y,w,A,z,u=!1,C=!1,q=!1;const c=()=>{u=!0,p.dataset.originalScheduling=\"fallback\",y?.disconnect(),w?.disconnect(),A?.disconnect(),clearInterval(z),l.clear(),b.clear()},E=t=>{try{const e=new URL(t.getAttribute(\"src\")||\"\",location.href);return e.protocol===\"https:\"&&e.hostname===\"assets.ultraclipart.com\"&&!e.username&&!e.password&&!e.port?e.href:\"\"}catch{return\"\"}};function F(){if(C=!1,!(u||document.hidden))try{for(const e of a)e.image.fetchPriority=e.visible?\"high\":\"low\";const t=[...l].filter(e=>e.image.isConnected&&d.get(e.image)===e&&E(e.image)===e.source&&(e.visible||e.near)).sort((e,n)=>Number(n.visible)-Number(e.visible)||e.top-n.top);for(const e of t){const n=[...a].filter(i=>i.visible).length;if(a.size>=6&&(!e.visible||a.size>=8||n>=2)||!e.visible&&[...a].filter(i=>!i.visible).length>=2)break;l.delete(e),a.add(e),e.image.fetchPriority=e.visible?\"high\":\"low\",e.image.dataset.originalDeferred=\"open\",e.image.loading=\"eager\",e.image.complete&&e.image.naturalWidth>0&&e.finish()}}catch{c()}}const L=()=>{!C&&!u&&(C=!0,requestAnimationFrame(F))},h=()=>{u||q||(q=!0,requestAnimationFrame(()=>{if(q=!1,!(u||document.hidden))try{const t=new Map;for(const e of b){if(!e.image.isConnected){e.finish();continue}if(e.image.dataset.originalRetryReset===\"true\"&&e.image.getAttribute(\"src\")===null)continue;if(E(e.image)!==e.source){e.finish();continue}const n=W(e.frame,t),i=n.width>0&&n.height>0&&n.right>0&&n.left<innerWidth;e.top=n.sourceTop,e.visible=i&&n.bottom>0&&n.top<innerHeight,e.near=i&&n.bottom>-160&&n.top<innerHeight+160,(e.visible||e.near)&&!a.has(e)?l.add(e):l.delete(e)}L()}catch{c()}}))},H=(t,e)=>{try{for(const n of t)for(const i of v.get(n.target)||[]){if(i.top=n.boundingClientRect.top,i[e?\"visible\":\"near\"]=n.isIntersecting&&n.intersectionRect.width>0&&n.intersectionRect.height>0,n.boundingClientRect.width>0&&n.boundingClientRect.height===0){i.image.dataset.originalDeferred=\"native\",l.delete(i);continue}(i.visible||i.near)&&!a.has(i)?l.add(i):l.delete(i)}L()}catch{c()}},I=t=>{const e=d.get(t);if(e&&t.dataset.originalRetryReset===\"true\"&&t.getAttribute(\"src\")===null||(e&&e.source!==E(t)&&e.finish(),d.has(t)||t.dataset.originalDeferred!==\"pending\"))return;const n=E(t),i=t.parentElement;if(!n||!i||t.loading!==\"lazy\"){t.dataset.originalDeferred=\"native\";return}const r={image:t,source:n,frame:i,visible:!1,near:!1,top:0};r.finish=()=>{a.delete(r),l.delete(r),b.delete(r),d.get(t)===r&&d.delete(t),t.removeEventListener(\"load\",r.finish),t.removeEventListener(\"error\",r.finish),t.removeEventListener(\"uc:original-image-terminal-error\",r.finish),v.get(i)?.delete(r),v.get(i)?.size||(y.unobserve(i),w.unobserve(i)),L()},d.set(t,r),b.add(r);const f=v.get(i)||new Set;f.add(r),v.set(i,f),t.addEventListener(\"load\",r.finish),t.addEventListener(\"uc:original-image-terminal-error\",r.finish),y.observe(i),w.observe(i)},O=t=>{if(t instanceof HTMLImageElement&&I(t),t instanceof Element)for(const e of t.querySelectorAll(R))I(e)};try{y=new IntersectionObserver(t=>H(t,!0)),w=new IntersectionObserver(t=>H(t,!1),{rootMargin:\"160px 0px\"}),A=new MutationObserver(t=>{try{for(const e of t){e.type===\"attributes\"&&I(e.target);for(const n of e.addedNodes)O(n);for(const n of e.removedNodes){const i=n instanceof HTMLImageElement?[n]:n instanceof Element?[...n.querySelectorAll(\"img[data-original-deferred]\")]:[];for(const r of i)r.isConnected||d.get(r)?.finish()}}h()}catch{c()}}),A.observe(document,{subtree:!0,childList:!0,attributes:!0,attributeFilter:[\"src\",\"data-original-deferred\"]}),p.dataset.originalScheduling=\"active\";for(const t of document.querySelectorAll('img[data-original-deferred=\"open\"]'))(!t.complete||!t.naturalWidth)&&(t.loading=\"lazy\",t.dataset.originalDeferred=\"pending\");O(p),h(),z=setInterval(()=>{if(!(u||document.hidden||document.readyState===\"loading\"))try{if(a.size&&p.dataset.originalImageLoading!==\"ready\"&&[...a].every(t=>t.image.complete&&!t.image.naturalWidth)){c();return}if(!a.size&&!l.size){const t=[...document.querySelectorAll(R)],e=new Map;t.some(n=>{const i=W(n.parentElement,e);return i.width>0&&i.height>0&&i.bottom>0&&i.top<innerHeight&&i.right>0&&i.left<innerWidth})&&c()}}catch{c()}},2500),addEventListener(\"pageshow\",h),addEventListener(\"scroll\",h,{passive:!0,capture:!0}),addEventListener(\"resize\",h),addEventListener(\"online\",L),document.addEventListener(\"visibilitychange\",h),addEventListener(\"beforeprint\",()=>{c();for(const t of document.querySelectorAll(R))t.loading=\"eager\"},{once:!0})}catch{c()}})();";
