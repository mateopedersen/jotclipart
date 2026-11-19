// Keep the signed default browse visible on both entry URLs.
export const searchStartupScript =
  '(()=>{const params=new URLSearchParams(location.search).toString();' +
  'if(params&&params!=="type=artwork")document.documentElement.setAttribute("data-search-pending","");})();';
