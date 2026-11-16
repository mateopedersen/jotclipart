// Parser-time presentation only. The cached HTML is identical for every query;
// no storage, network, scrolling, keyboard focus or native fullscreen is used.
// Keep these exact bytes bound into the compiled CSP and inline-script audit.
export const studioWorkspaceStartupScript =
  '(()=>{const r=document.currentScript?.parentElement;if(r?.matches(".uc-editor[data-creator=\\"true\\"]")&&location.pathname==="/create/"&&new URLSearchParams(location.search).get("view")==="workspace"&&r.dataset.wbFocus!=="false"){r.dataset.wbFocus="true";r.dataset.wbStartup="workspace"}})();';
