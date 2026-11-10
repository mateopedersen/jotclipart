import { publicRouteForId } from './public-artwork-routes.mjs';
// Source-projected discovery data. Graph verification binds its current artwork
// root and all selected image/metadata hashes; visitors do not rescan a catalog.
export async function readSurprisePicks(context,{limit=512}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>512)throw Error('Invalid discovery limit');const collections=await context.getFacet('collections');if(!collections.surprise)throw Error('Discovery projection unavailable');const node=await context.read('collections',collections.surprise,{maxBytes:262144});
 if(node.schema!==1||node.type!=='cute-discovery-projection'||node.version!==3||node.artworksRootSHA256!==context.snapshot.indexes.artworks.sha256||!Array.isArray(node.items)||!node.items.length||node.items.length>512||new Set(node.items.map(x=>x.id)).size!==node.items.length)throw Error('Stale discovery projection');
 for(const p of node.items)if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id??'')||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.topic??'')||!/^[a-f0-9]{64}$/.test(p.sourceSHA256??'')||!/^[a-f0-9]{64}$/.test(p.metadataSHA256??'')||!Number.isFinite(p.score)||p.score<=0||p.fresh!==undefined&&typeof p.fresh!=='boolean')throw Error('Invalid discovery selection');
 return Promise.all(node.items.slice(0,limit).map(async p=>({id:p.id,topic:p.topic,publicSlug:await publicRouteForId(context,p.id),...(Object.hasOwn(p,'fresh')?{fresh:p.fresh}:{})})));
}
