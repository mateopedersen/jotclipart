import{readCollectionReferences}from'../catalog-collections/reader.mjs';import{readArtwork}from'./artwork-facet-reader.mjs';
// Integration handler: injected capture must authenticate production snapshots.
import{readArtworkPageState}from'./art-page-data.mjs';import{readEditorPageState}from'./editor-page-data.mjs';import{readHomePageState}from'./home-page-data.mjs';import{readShellPageState}from'./shell-page-data.mjs';import{readSitemap}from'./sitemap-reader.mjs';
import{openSevenFacetCollectionContext}from'./collection-context.mjs';import{collectionStateFromContext}from'./collection-page-data.mjs';
import{createSnapshotSearchApi}from'../catalog-search/api.mjs';import{uiProviders}from'../catalog-search/ui-metadata.mjs';
const paths={'/new/':'new','/search/':'search','/black-and-white/':'monochrome','/categories/':'categories','/collections/':'collections','/library-index/':'library','/create/':'create','/favorites/':'favorites'};
const json=(body,root)=>Response.json(body,{headers:{'cache-control':'no-store','x-uc-snapshot':root}});
const missing=()=>new Response('<!doctype html><html lang="en"><head><meta name="robots" content="noindex"><title>Page Not Found</title></head><body><h1>Page Not Found</h1><a href="/">UltraClipart</a></body></html>',{status:404,headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store'}});
export function createCatalogHandler({capture,bucket,allowPrivateFixture=false,softwareRevision,redirects={},renderers}){
 if(typeof capture!=='function'||!bucket)throw Error('Captured catalog provider required');
 const{render:renderArtwork,css:artCSS,scripts:artScripts}=renderers.art,{render:renderEditor,css:editorCSS,scripts:editorScripts}=renderers.editor,{render:renderHome,css:homeCSS,scripts:homeScripts}=renderers.home,{render:renderCollection,css:collectionCSS,scripts:collectionScripts}=renderers.collection,shells=renderers.shells,shellScripts=renderers.shellScripts;
 return async request=>{
 const url=new URL(request.url),path=url.pathname,art=/^\/(art|edit)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path),topic=/^\/clipart\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path),cluster=/^\/collection\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path),xml=/^\/sitemap(?:-(?:pages|images)(?:-\d+)?)?\.xml$/.test(path),kind=paths[path];
 if(request.method==='GET'||request.method==='HEAD'){
  if(redirects[path])return Response.redirect(new URL(redirects[path],url.origin),301);
  if(/^\/download\//.test(path))return Response.redirect(new URL(path.replace(/^\/download\//,'/art/'),url.origin),301);
  if(!path.endsWith('/')&&(/^\/(?:art|edit|clipart|collection)\/[a-z0-9-]+$/.test(path)||Object.hasOwn(paths,path+'/')))return Response.redirect(new URL(path+'/'+url.search,url.origin),301);
 }
 const apiPath=['/catalog-search.json','/search-data/manifest.json','/studio-manifest.json','/studio-featured.json','/studio-catalog.json','/catalog-stats.json','/surprise-picks.json','/related-release.json','/delivery-release.json','/category-search/current.json','/collection-feed.json'].includes(path);
 if(!art&&!topic&&!cluster&&!xml&&!kind&&path!=='/'&&!apiPath)return null;
 if(request.method!=='GET'&&request.method!=='HEAD'&&!(path==='/catalog-search.json'&&request.method==='POST'))return new Response('Method not allowed',{status:405,headers:{allow:path==='/catalog-search.json'?'POST':'GET, HEAD','cache-control':'no-store'}});
 try{
  const context=await capture(request),privateRoot=context?.snapshot?.fixture===true||context?.snapshot?.status==='PRIVATE_UNPUBLISHABLE';
  if(privateRoot?!allowPrivateFixture:context?.authorizationVerified!==true)throw Error('Catalog authorization missing');
  const resultHeaders={'content-type':'text/html;charset=utf-8','cache-control':'no-cache','x-uc-snapshot':context.rootSHA256,'x-uc-revision':context.snapshot.revision};
  const cc=()=>openSevenFacetCollectionContext(bucket,{snapshot:context.snapshot,allowUnpublishableFixture:allowPrivateFixture});
  const api=createSnapshotSearchApi({captureAuthorizedSnapshot:async()=>({...context,bucket}),bucket,allowPrivateFixture,...uiProviders});let response;
  if(path==='/catalog-search.json')response=await api.post(request);
  else if(path==='/search-data/manifest.json')response=await api.manifest(request);
  else if(path==='/studio-manifest.json')response=await api.studioManifest(request);
  else if(path==='/studio-featured.json'||path==='/studio-catalog.json')response=await api.studioCatalog(request);
  else if(path==='/catalog-stats.json'){const c=await cc();response=json(url.searchParams.get('scope')==='visible'?await c.countsFor(url.searchParams.getAll('topic')):await c.allLegacyCounts(),context.rootSHA256)}
  else if(path==='/surprise-picks.json'){const c=await cc(),features=await c.read(c.root.features,256*1024);response=json({version:3,items:features.surprise},context.rootSHA256)}
  else if(path==='/related-release.json')response=json({version:(await context.getFacet('related')).version},context.rootSHA256);
  else if(path==='/delivery-release.json'){const c=await cc();response=json({schema:2,mode:'catalog-snapshot-v1',renderedRevision:context.snapshot.revision,controlRevision:softwareRevision,verifiedRoot:context.rootSHA256,artworks:c.global.totals.artworks,subjects:c.global.totals.subjects},context.rootSHA256)}
  else if(xml){const body=await readSitemap(context,path);response=body===undefined?missing():new Response(body,{headers:{...resultHeaders,'content-type':'application/xml;charset=utf-8'}})}
  else if(path==='/category-search/current.json'||path==='/collection-feed.json'){const state=await readShellPageState(bucket,context,path==='/collection-feed.json'?'collections':'categories',{allowFixture:allowPrivateFixture,dataOnly:true});response=json(path==='/collection-feed.json'?state.collectionFeed:{version:1,subjects:state.categorySubjects.map(s=>({id:s.slug,name:s.name,groups:s.groups.join(' '),keywords:s.searchKeywords}))},context.rootSHA256)}
  else{
   let state,html;
   if(path==='/'){state=await readHomePageState(bucket,context,{allowFixture:allowPrivateFixture});html=await renderHome(state,'https://ultraclipart.com/',homeCSS,homeScripts)}
   else if(art){state=art[1]==='art'?await readArtworkPageState(bucket,context,art[2],{allowFixture:allowPrivateFixture}):await readEditorPageState(bucket,context,art[2],{allowFixture:allowPrivateFixture});if(state)html=art[1]==='art'?await renderArtwork(state,'https://ultraclipart.com'+path,artCSS,artScripts):await renderEditor(state,'https://ultraclipart.com'+path,editorCSS,editorScripts)}
   else if(topic){try{state=(await ((await context.getFacet('collections')).viewProtocol==='collection-references-v2'?readCollectionReferences(context,topic[1],{resolveArtwork:async(id,ctx)=>({rootSHA256:ctx.rootSHA256,artwork:await readArtwork(ctx,id)})}):collectionStateFromContext(await cc(),topic[1]))).state}catch(error){if(error.status!==404)throw error}if(state)html=await renderCollection(state,'https://ultraclipart.com'+path,collectionCSS,collectionScripts)}
   else{const selected=cluster?'cluster':kind,c=cluster?(await cc()).global.collections[cluster[1]]:undefined,clusterName=cluster?c?.name:undefined;if(cluster&&!clusterName){const cctx=await cc(),root=await context.read('collections',cctx.collections.shells),pages=root.fields.clusters;for(const d of pages){const page=await context.read('collections',d,{maxBytes:65536});for(const name of page.entries)if(name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')===cluster[1])state={cluster:name}}if(!state)return missing()}
    state=await readShellPageState(bucket,context,selected,{cluster:clusterName??state?.cluster,allowFixture:allowPrivateFixture});if(state)html=await shells[selected][0](state,'https://ultraclipart.com'+path,shells[selected][1],shellScripts)}
   response=html===undefined?missing():new Response(html,{headers:resultHeaders});
  }
  const headers=new Headers(response.headers);headers.set('x-uc-snapshot',context.rootSHA256);headers.set('x-uc-revision',context.snapshot.revision);if(privateRoot)headers.set('x-private-catalog','not-published');return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});
 }catch(error){return new Response('Temporarily unavailable',{status:503,headers:{'cache-control':'no-store',...(allowPrivateFixture?{'x-private-error':String(error).slice(0,400)}:{})}})};
 };
}
