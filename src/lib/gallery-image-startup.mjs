// Enable the short handoff to the gallery loader before native lazy requests.
// If the module is blocked or unavailable, the browser resumes native loading.
export const galleryImageStartupScript = `(()=>{if(!window.IntersectionObserver)return;const d=document.documentElement.dataset;d.galleryImageStartup='';setTimeout(()=>{delete d.galleryImageStartup},3500)})();`;
