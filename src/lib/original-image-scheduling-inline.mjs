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
export const originalImageSchedulingScript =
  '(()=>{const R=function(n,e=new Map){const i=n.getBoundingClientRect();let r=i.left,f=i.right,g=i.top,S=i.bottom;for(let o=n.parentElement;o;o=o.parentElement){let s=e.get(o);if(!s){const m=getComputedStyle(o),D=/^(auto|scroll|hidden|clip)$/.test(m.overflowX),k=/^(auto|scroll|hidden|clip)$/.test(m.overflowY);if(s={x:D,y:k,hidden:o.hidden||m.display==="none"||m.visibility==="hidden"||m.visibility==="collapse"||m.contentVisibility==="hidden"},D||k){const M=o.getBoundingClientRect(),B=o.offsetWidth?M.width/o.offsetWidth:1,F=o.offsetHeight?M.height/o.offsetHeight:1;s.left=M.left+o.clientLeft*B,s.right=s.left+o.clientWidth*B,s.top=M.top+o.clientTop*F,s.bottom=s.top+o.clientHeight*F}e.set(o,s)}if(s.hidden)return{top:g,bottom:g,left:r,right:r,width:0,height:0,sourceTop:i.top};s.x&&(r=Math.max(r,s.left),f=Math.min(f,s.right)),s.y&&(g=Math.max(g,s.top),S=Math.min(S,s.bottom))}return{top:g,bottom:S,left:r,right:f,width:Math.max(0,f-r),height:Math.max(0,S-g),sourceTop:i.top}},p=document.documentElement,z=Symbol.for("ultraclipart:original-scheduling:v1");if(window[z]||(window[z]=!0,delete p.dataset.originalScheduling,typeof IntersectionObserver!="function"||typeof MutationObserver!="function"))return;const W=\'img[data-original-deferred="pending"]\',d=new WeakMap,v=new WeakMap,w=new Set,l=new Set,a=new Set;let E,L,q,H,u=!1,A=!1,C=!1,I=0;const c=()=>{u=!0,p.dataset.originalScheduling="fallback",E?.disconnect(),L?.disconnect(),q?.disconnect(),clearInterval(H),l.clear(),w.clear()},b=t=>{try{const n=new URL(t.getAttribute("src")||"",location.href);return n.protocol==="https:"&&n.hostname==="assets.jotclipart.com"&&!n.username&&!n.password&&!n.port?n.href:""}catch{return""}};function N(){if(A=!1,!(u||document.hidden))try{let t;if(innerWidth>=901){const e=document.querySelector(\'img[data-home-critical="true"]\');if(e&&b(e)&&!e.complete){const i=R(e.parentElement);i.width>0&&i.height>0&&i.bottom>0&&i.top<innerHeight&&i.right>0&&i.left<innerWidth&&(I||(I=performance.now()+1500,setTimeout(()=>y(),1500)),performance.now()<I&&(t=e))}}for(const e of a)e.image.fetchPriority=e.visible&&(!t||e.image===t)?"high":"low";const n=[...l].filter(e=>e.image.isConnected&&d.get(e.image)===e&&b(e.image)===e.source&&(e.visible||e.near)&&(!t||e.image===t)).sort((e,i)=>Number(i.visible)-Number(e.visible)||e.top-i.top);for(const e of n){const i=[...a].filter(r=>r.visible).length;if(a.size>=6&&(!e.visible||a.size>=8||i>=2)||!e.visible&&[...a].filter(r=>!r.visible).length>=2)break;l.delete(e),a.add(e),e.image.fetchPriority=e.visible?"high":"low",e.image.dataset.originalDeferred="open",e.image.loading="eager",e.image.complete&&e.image.naturalWidth>0&&e.finish()}}catch{c()}}const y=()=>{!A&&!u&&(A=!0,requestAnimationFrame(N))},h=()=>{u||C||(C=!0,requestAnimationFrame(()=>{if(C=!1,!(u||document.hidden))try{const t=new Map;for(const n of w){if(!n.image.isConnected){n.finish();continue}if(n.image.dataset.originalRetryReset==="true"&&n.image.getAttribute("src")===null)continue;if(b(n.image)!==n.source){n.finish();continue}const e=R(n.frame,t),i=e.width>0&&e.height>0&&e.right>0&&e.left<innerWidth;n.top=e.sourceTop,n.visible=i&&e.bottom>0&&e.top<innerHeight,n.near=i&&e.bottom>-160&&e.top<innerHeight+160,(n.visible||n.near)&&!a.has(n)?l.add(n):l.delete(n)}y()}catch{c()}}))},O=(t,n)=>{try{for(const e of t)for(const i of v.get(e.target)||[]){if(i.top=e.boundingClientRect.top,i[n?"visible":"near"]=e.isIntersecting&&e.intersectionRect.width>0&&e.intersectionRect.height>0,e.boundingClientRect.width>0&&e.boundingClientRect.height===0){i.image.dataset.originalDeferred="native",l.delete(i);continue}(i.visible||i.near)&&!a.has(i)?l.add(i):l.delete(i)}y()}catch{c()}},x=t=>{const n=d.get(t);if(n&&t.dataset.originalRetryReset==="true"&&t.getAttribute("src")===null||(n&&n.source!==b(t)&&n.finish(),d.has(t)||t.dataset.originalDeferred!=="pending"))return;const e=b(t),i=t.parentElement;if(!e||!i||t.loading!=="lazy"){t.dataset.originalDeferred="native";return}const r={image:t,source:e,frame:i,visible:!1,near:!1,top:0};r.finish=()=>{a.delete(r),l.delete(r),w.delete(r),d.get(t)===r&&d.delete(t),t.removeEventListener("load",r.finish),t.removeEventListener("error",r.finish),t.removeEventListener("uc:original-image-terminal-error",r.finish),v.get(i)?.delete(r),v.get(i)?.size||(E.unobserve(i),L.unobserve(i)),y()},d.set(t,r),w.add(r);const f=v.get(i)||new Set;f.add(r),v.set(i,f),t.addEventListener("load",r.finish),t.addEventListener("uc:original-image-terminal-error",r.finish),E.observe(i),L.observe(i)},T=t=>{if(t instanceof HTMLImageElement&&x(t),t instanceof Element)for(const n of t.querySelectorAll(W))x(n)};try{E=new IntersectionObserver(t=>O(t,!0)),L=new IntersectionObserver(t=>O(t,!1),{rootMargin:"160px 0px"}),q=new MutationObserver(t=>{try{for(const n of t){n.type==="attributes"&&x(n.target);for(const e of n.addedNodes)T(e);for(const e of n.removedNodes){const i=e instanceof HTMLImageElement?[e]:e instanceof Element?[...e.querySelectorAll("img[data-original-deferred]")]:[];for(const r of i)r.isConnected||d.get(r)?.finish()}}h()}catch{c()}}),q.observe(document,{subtree:!0,childList:!0,attributes:!0,attributeFilter:["src","data-original-deferred"]}),p.dataset.originalScheduling="active";for(const t of document.querySelectorAll(\'img[data-original-deferred="open"]\'))(!t.complete||!t.naturalWidth)&&(t.loading="lazy",t.dataset.originalDeferred="pending");T(p),h(),H=setInterval(()=>{if(!(u||document.hidden||document.readyState==="loading"))try{if(a.size&&p.dataset.originalImageLoading!=="ready"&&[...a].every(t=>t.image.complete&&!t.image.naturalWidth)){c();return}if(!a.size&&!l.size){const t=[...document.querySelectorAll(W)],n=new Map;t.some(e=>{const i=R(e.parentElement,n);return i.width>0&&i.height>0&&i.bottom>0&&i.top<innerHeight&&i.right>0&&i.left<innerWidth})&&c()}}catch{c()}},2500),addEventListener("pageshow",h),addEventListener("scroll",h,{passive:!0,capture:!0}),addEventListener("resize",h),addEventListener("online",y),document.addEventListener("visibilitychange",h),addEventListener("beforeprint",()=>{c();for(const t of document.querySelectorAll(W))t.loading="eager"},{once:!0})}catch{c()}})();';
