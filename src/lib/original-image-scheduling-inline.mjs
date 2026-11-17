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
  let criticalDeadline = 0;
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
      return u.protocol === 'https:' && u.hostname === 'assets.jotclipart.com' &&
        !u.username && !u.password && !u.port ? u.href : '';
    } catch { return ''; }
  };
  function pump() {
    scheduled = false;
    if (failed || document.hidden) return;
    try {
      // Only the desktop homepage marks its preloaded full-size LCP artwork.
      // Give that original a bounded head start instead of starting six other
      // multi-megabyte originals alongside it. Never block mobile, a hidden
      // showcase, another page, or an image which has already completed.
      let critical;
      if (innerWidth >= 901) {
        const image = document.querySelector('img[data-home-critical="true"]');
        if (image && source(image) && !image.complete) {
          const r = frameBounds(image.parentElement);
          if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
            if (!criticalDeadline) {
              criticalDeadline = performance.now() + 1500;
              setTimeout(() => requestPump(), 1500);
            }
            if (performance.now() < criticalDeadline) critical = image;
          }
        }
      }
      for (const s of active) s.image.fetchPriority = s.visible && (!critical || s.image === critical) ? 'high' : 'low';
      const candidates = [...queued].filter(s => s.image.isConnected &&
        states.get(s.image) === s && source(s.image) === s.source && (s.visible || s.near) &&
        (!critical || s.image === critical))
        .sort((a,b) => Number(b.visible)-Number(a.visible) || a.top-b.top);
      for (const s of candidates) {
        // Keep old healthy transfers intact, but reserve two bounded admission
        // slots when scrolling would otherwise leave the visible viewport idle.
        const visibleActive = [...active].filter(x => x.visible).length;
        const compact = innerWidth <= 600;
        const ordinarySlots = compact ? 2 : 6;
        const maximumSlots = compact ? 4 : 8;
        if (active.size >= ordinarySlots && (!s.visible || active.size >= maximumSlots || visibleActive >= 2)) break;
        // On a narrow screen a speculative multi-megabyte original must not
        // compete with the artwork the visitor is actually waiting to see.
        if (compact && !s.visible && active.size) break;
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
export const originalImageSchedulingScript =
  '(()=>{const R=function(n,e=new Map){const i=n.getBoundingClientRect();let r=i.left,d=i.right,f=i.top,u=i.bottom;for(let o=n.parentElement;o;o=o.parentElement){let s=e.get(o);if(!s){const p=getComputedStyle(o),k=/^(auto|scroll|hidden|clip)$/.test(p.overflowX),D=/^(auto|scroll|hidden|clip)$/.test(p.overflowY);if(s={x:k,y:D,hidden:o.hidden||p.display==="none"||p.visibility==="hidden"||p.visibility==="collapse"||p.contentVisibility==="hidden"},k||D){const M=o.getBoundingClientRect(),B=o.offsetWidth?M.width/o.offsetWidth:1,F=o.offsetHeight?M.height/o.offsetHeight:1;s.left=M.left+o.clientLeft*B,s.right=s.left+o.clientWidth*B,s.top=M.top+o.clientTop*F,s.bottom=s.top+o.clientHeight*F}e.set(o,s)}if(s.hidden)return{top:f,bottom:f,left:r,right:r,width:0,height:0,sourceTop:i.top};s.x&&(r=Math.max(r,s.left),d=Math.min(d,s.right)),s.y&&(f=Math.max(f,s.top),u=Math.min(u,s.bottom))}return{top:f,bottom:u,left:r,right:d,width:Math.max(0,d-r),height:Math.max(0,u-f),sourceTop:i.top}},v=document.documentElement,I=Symbol.for("ultraclipart:original-scheduling:v1");if(window[I]||(window[I]=!0,delete v.dataset.originalScheduling,typeof IntersectionObserver!="function"||typeof MutationObserver!="function"))return;const W=\'img[data-original-deferred="pending"]\',h=new WeakMap,b=new WeakMap,E=new Set,c=new Set,a=new Set;let S,L,q,H,g=!1,A=!1,C=!1,x=0;const l=()=>{g=!0,v.dataset.originalScheduling="fallback",S?.disconnect(),L?.disconnect(),q?.disconnect(),clearInterval(H),c.clear(),E.clear()},y=t=>{try{const n=new URL(t.getAttribute("src")||"",location.href);return n.protocol==="https:"&&n.hostname==="assets.jotclipart.com"&&!n.username&&!n.password&&!n.port?n.href:""}catch{return""}};function N(){if(A=!1,!(g||document.hidden))try{let t;if(innerWidth>=901){const e=document.querySelector(\'img[data-home-critical="true"]\');if(e&&y(e)&&!e.complete){const i=R(e.parentElement);i.width>0&&i.height>0&&i.bottom>0&&i.top<innerHeight&&i.right>0&&i.left<innerWidth&&(x||(x=performance.now()+1500,setTimeout(()=>w(),1500)),performance.now()<x&&(t=e))}}for(const e of a)e.image.fetchPriority=e.visible&&(!t||e.image===t)?"high":"low";const n=[...c].filter(e=>e.image.isConnected&&h.get(e.image)===e&&y(e.image)===e.source&&(e.visible||e.near)&&(!t||e.image===t)).sort((e,i)=>Number(i.visible)-Number(e.visible)||e.top-i.top);for(const e of n){const i=[...a].filter(u=>u.visible).length,r=innerWidth<=600,d=r?2:6,f=r?4:8;if(a.size>=d&&(!e.visible||a.size>=f||i>=2)||r&&!e.visible&&a.size||!e.visible&&[...a].filter(u=>!u.visible).length>=2)break;c.delete(e),a.add(e),e.image.fetchPriority=e.visible?"high":"low",e.image.dataset.originalDeferred="open",e.image.loading="eager",e.image.complete&&e.image.naturalWidth>0&&e.finish()}}catch{l()}}const w=()=>{!A&&!g&&(A=!0,requestAnimationFrame(N))},m=()=>{g||C||(C=!0,requestAnimationFrame(()=>{if(C=!1,!(g||document.hidden))try{const t=new Map;for(const n of E){if(!n.image.isConnected){n.finish();continue}if(n.image.dataset.originalRetryReset==="true"&&n.image.getAttribute("src")===null)continue;if(y(n.image)!==n.source){n.finish();continue}const e=R(n.frame,t),i=e.width>0&&e.height>0&&e.right>0&&e.left<innerWidth;n.top=e.sourceTop,n.visible=i&&e.bottom>0&&e.top<innerHeight,n.near=i&&e.bottom>-160&&e.top<innerHeight+160,(n.visible||n.near)&&!a.has(n)?c.add(n):c.delete(n)}w()}catch{l()}}))},O=(t,n)=>{try{for(const e of t)for(const i of b.get(e.target)||[]){if(i.top=e.boundingClientRect.top,i[n?"visible":"near"]=e.isIntersecting&&e.intersectionRect.width>0&&e.intersectionRect.height>0,e.boundingClientRect.width>0&&e.boundingClientRect.height===0){i.image.dataset.originalDeferred="native",c.delete(i);continue}(i.visible||i.near)&&!a.has(i)?c.add(i):c.delete(i)}w()}catch{l()}},z=t=>{const n=h.get(t);if(n&&t.dataset.originalRetryReset==="true"&&t.getAttribute("src")===null||(n&&n.source!==y(t)&&n.finish(),h.has(t)||t.dataset.originalDeferred!=="pending"))return;const e=y(t),i=t.parentElement;if(!e||!i||t.loading!=="lazy"){t.dataset.originalDeferred="native";return}const r={image:t,source:e,frame:i,visible:!1,near:!1,top:0};r.finish=()=>{a.delete(r),c.delete(r),E.delete(r),h.get(t)===r&&h.delete(t),t.removeEventListener("load",r.finish),t.removeEventListener("error",r.finish),t.removeEventListener("uc:original-image-terminal-error",r.finish),b.get(i)?.delete(r),b.get(i)?.size||(S.unobserve(i),L.unobserve(i)),w()},h.set(t,r),E.add(r);const d=b.get(i)||new Set;d.add(r),b.set(i,d),t.addEventListener("load",r.finish),t.addEventListener("uc:original-image-terminal-error",r.finish),S.observe(i),L.observe(i)},T=t=>{if(t instanceof HTMLImageElement&&z(t),t instanceof Element)for(const n of t.querySelectorAll(W))z(n)};try{S=new IntersectionObserver(t=>O(t,!0)),L=new IntersectionObserver(t=>O(t,!1),{rootMargin:"160px 0px"}),q=new MutationObserver(t=>{try{for(const n of t){n.type==="attributes"&&z(n.target);for(const e of n.addedNodes)T(e);for(const e of n.removedNodes){const i=e instanceof HTMLImageElement?[e]:e instanceof Element?[...e.querySelectorAll("img[data-original-deferred]")]:[];for(const r of i)r.isConnected||h.get(r)?.finish()}}m()}catch{l()}}),q.observe(document,{subtree:!0,childList:!0,attributes:!0,attributeFilter:["src","data-original-deferred"]}),v.dataset.originalScheduling="active";for(const t of document.querySelectorAll(\'img[data-original-deferred="open"]\'))(!t.complete||!t.naturalWidth)&&(t.loading="lazy",t.dataset.originalDeferred="pending");T(v),m(),H=setInterval(()=>{if(!(g||document.hidden||document.readyState==="loading"))try{if(a.size&&v.dataset.originalImageLoading!=="ready"&&[...a].every(t=>t.image.complete&&!t.image.naturalWidth)){l();return}if(!a.size&&!c.size){const t=[...document.querySelectorAll(W)],n=new Map;t.some(e=>{const i=R(e.parentElement,n);return i.width>0&&i.height>0&&i.bottom>0&&i.top<innerHeight&&i.right>0&&i.left<innerWidth})&&l()}}catch{l()}},2500),addEventListener("pageshow",m),addEventListener("scroll",m,{passive:!0,capture:!0}),addEventListener("resize",m),addEventListener("online",w),document.addEventListener("visibilitychange",m),addEventListener("beforeprint",()=>{l();for(const t of document.querySelectorAll(W))t.loading="eager"},{once:!0})}catch{l()}})();';
