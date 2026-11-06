const scenes = document.querySelectorAll<HTMLElement>('[data-home-preview-scene]');

if (scenes.length && 'IntersectionObserver' in window) {
  const upcoming = new IntersectionObserver((entries, observer) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      for (const image of target.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')) {
        if (image.complete && image.naturalWidth > 0) continue;
        image.fetchPriority = 'low';
        image.loading = 'eager';
      }
    }
  }, { rootMargin: '800px 0px' });
  for (const scene of scenes) upcoming.observe(scene);
}

export {};
