// Shared read-only geometry for the first-request queue and error recovery.
// Clip against scroll/overflow ancestors before testing the viewport. A fixed
// card can be inside the window while completely outside its visible carousel.
export function originalImageFrameBounds(frame, cache = new Map()) {
  const bounds = frame.getBoundingClientRect();
  let left = bounds.left,
    right = bounds.right,
    top = bounds.top,
    bottom = bounds.bottom;
  for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
    let clip = cache.get(parent);
    if (!clip) {
      const style = getComputedStyle(parent);
      const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      clip = {
        x,
        y,
        hidden:
          parent.hidden ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.contentVisibility === 'hidden',
      };
      if (x || y) {
        const r = parent.getBoundingClientRect();
        const sx = parent.offsetWidth ? r.width / parent.offsetWidth : 1;
        const sy = parent.offsetHeight ? r.height / parent.offsetHeight : 1;
        clip.left = r.left + parent.clientLeft * sx;
        clip.right = clip.left + parent.clientWidth * sx;
        clip.top = r.top + parent.clientTop * sy;
        clip.bottom = clip.top + parent.clientHeight * sy;
      }
      cache.set(parent, clip);
    }
    if (clip.hidden)
      return { top, bottom: top, left, right: left, width: 0, height: 0, sourceTop: bounds.top };
    if (clip.x) {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (clip.y) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  return {
    top,
    bottom,
    left,
    right,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    sourceTop: bounds.top,
  };
}
