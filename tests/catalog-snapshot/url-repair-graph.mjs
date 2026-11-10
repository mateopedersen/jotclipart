// Local-only graph fixtures: generated test key/account, no production credentials or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {canonical,patchMap} from '../../server/catalog-search/store.mjs';
import {buildPublicArtworkRoutes,publicRouteForId,resolvePublicArtworkRoute} from '../../server/catalog-snapshot/public-artwork-routes.mjs';
import {bootstrapSitemaps,sitemapEnvelope} from '../../server/catalog-snapshot/sitemap-ledger.mjs';
import {readSitemap} from '../../server/catalog-snapshot/sitemap-reader.mjs';
import {readArtwork} from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import {captureProductionSnapshot,productionSnapshotMessage} from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import {openSnapshot} from '../../server/catalog-snapshot/snapshot-context.mjs';
import {buildURLRepair} from '../../scripts/catalog-snapshot/build-url-repair.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const bytes=new Map();const object=b=>({size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),json:async()=>JSON.parse(b)});
 const bucket={get:async key=>bytes.has(key)?object(bytes.get(key)):null,put:async(key,b)=>{bytes.set(key,Buffer.from(b));return{etag:sha(b)};}};
 const put=async(facet,value)=>{const body=Buffer.from(JSON.stringify(canonical({schema:1,...value}))),sha256=sha(body),d={key:`catalog/objects/${facet}/${sha256}.json`,sha256,bytes:body.length};await bucket.put(d.key,body);return d;};
 const rows=[{id:'300-012',title:'Woman In A Flowing Ivory Gown',topic:'300-movie',published:true,indexable:true,webp:'https://assets.ultraclipart.com/300/gown.webp'},
 {id:'pumpkin-hot-air-balloon',title:'Pumpkin Hot Air Balloon',topic:'pumpkin',published:true,indexable:true,webp:'https://assets.ultraclipart.com/pumpkin/balloon.webp'},
 {id:'number-100-school-celebration',title:'Number 100 School Celebration',topic:'100',published:true,indexable:true,webp:'https://assets.ultraclipart.com/100/school.webp'}];
 const groups=new Map();for(const row of rows){const prefix=sha(row.id).slice(0,3);if(!groups.has(prefix))groups.set(prefix,[]);groups.get(prefix).push(row);}const dirs={};for(const[p,records]of groups){const prefix=p.slice(0,2);dirs[prefix]??={};dirs[prefix][p]=await put('artworks',{type:'artwork-leaf',shard:p,records});}
 const directories={};for(const[p,shards]of Object.entries(dirs))directories[p]=await put('artworks',{type:'artwork-directory',prefix:p,shards});
 const store={get:async d=>JSON.parse(bytes.get(d.key)),put:v=>put('artworks',v)};
 const initial=await buildPublicArtworkRoutes(store,rows,new Map()),route=await store.get(initial),publicRoutes=await store.put({...route,byPath:await patchMap(store,route.byPath,'public-artwork-paths',new Map([['historical-gown',{id:'300-012',slug:'300-012'}]]))});
 const artworks=await put('artworks',{type:'artwork-root',revision:'a'.repeat(40),directories,publicRoutes});
 const collections=await put('collections',{type:'collection-directory',directory:{unitFixture:'unchanged'},discoveryProjection:await put('collections',{type:'unit-discovery',artworkRootSHA256:artworks.sha256}),surprise:await put('collections',{type:'unit-surprise',artworksRootSHA256:artworks.sha256})});
 const entries=rows.map(r=>`<url><loc>https://ultraclipart.com/art/${r.id}/</loc></url>`),images=rows.map(r=>`<url><loc>https://ultraclipart.com/art/${r.id}/</loc><image:image><image:loc>${r.webp}</image:loc></image:image></url>`);
 const smstore={get:async d=>JSON.parse(bytes.get(d.key)),put:v=>put('sitemaps',v)};
 const sitemaps=await bootstrapSitemaps(smstore,[{kind:'pages',xml:sitemapEnvelope('pages')+'<url><loc>https://ultraclipart.com/</loc></url></urlset>'},{kind:'art-1',xml:sitemapEnvelope('art-1')+entries.join('')+'</urlset>'},{kind:'images-1',xml:sitemapEnvelope('images-1')+images.join('')+'</urlset>'}],{separated:true});
 const indexes={artworks,collections,sitemaps};for(const facet of ['search','recent','related','counts'])indexes[facet]=await put(facet,{type:'unread-unit-source',facet});
 const pair=generateKeyPairSync('ed25519'),config={accountId:'a'.repeat(32),bucketName:'private-url-repair-unit-fixture',keyId:'url-repair-unit-only',abiSHA256:'b'.repeat(64),publicKey:new Uint8Array(Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url')),now:1000};
 const snapshot={schema:1,status:'SOURCE_MEDIA_GRAPH_VERIFIED',revision:'a'.repeat(40),parentRevision:'b'.repeat(40),indexes,authorization:{policy:'source-media-graph-ed25519-v1',accountId:config.accountId,bucket:config.bucketName,keyId:config.keyId,abiSHA256:config.abiSHA256,sourceReceiptSHA256:'1'.repeat(64),mediaReceiptSHA256:'2'.repeat(64),graphReceiptSHA256:'3'.repeat(64),manifestRoot:'4'.repeat(64),parentSnapshotSHA256:'5'.repeat(64),issuedAt:500}};
 snapshot.authorization.signature=sign(null,productionSnapshotMessage(snapshot),pair.privateKey).toString('hex');await bucket.put('catalog/active.json',Buffer.from(JSON.stringify(snapshot)));
 const parent=await captureProductionSnapshot(bucket,config),plan={schema:1,kind:'OWNER_AUTHORIZED_READABLE_ARTWORK_URL_REPAIR',parentRoot:parent.rootSHA256,total:rows.length,changes:[{id:rows[0].id,oldSlug:rows[0].id,slug:'woman-in-a-flowing-ivory-gown',title:rows[0].title,topic:rows[0].topic,original:rows[0].webp,sourceRecordSHA256:sha(JSON.stringify(canonical(rows[0]))),historicalTopicPrefix:'300'}]};
 const run=async p=>buildURLRepair({parentContext:parent,parentBucket:bucket,revision:'c'.repeat(40),plan:p,preparePresentation:async({context})=>({collections:context.snapshot.indexes.collections,receipt:{canonicalDocumentsPrepared:0,scope:'LOCAL_ROUTE_GRAPH_ONLY_NO_HTML_NO_PUBLICATION'}})});
 return{bucket,parent,plan,rows,run};
}
test('actual repair builder preserves source bytes and every alias while updating both sitemap families',async()=>{const f=await fixture(),pointer=Buffer.from(await(await f.bucket.get('catalog/active.json')).arrayBuffer()),result=await f.run(f.plan),bucket={get:async key=>{const b=result.created.get(key);return b?{size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}:f.bucket.get(key);}},context=await openSnapshot(bucket,{provided:result.candidate,allowFixture:true});
 assert(result.bridge.canonicalArtworkDirectoriesUnchanged);assert.equal(result.bridge.historicalReservationsRemoved,0);assert.equal(result.bridge.preservedCanonicalIDs,2);
 for(const path of ['300-012','historical-gown','woman-in-a-flowing-ivory-gown'])assert.deepEqual(await resolvePublicArtworkRoute(context,path),{id:'300-012',slug:'woman-in-a-flowing-ivory-gown'});
 for(const row of f.rows){assert.deepEqual(await readArtwork(context,row.id),row);if(row.id!=='300-012')assert.equal(await publicRouteForId(context,row.id),row.id);}
 for(const kind of ['art-1','images-1']){const xml=await readSitemap(context,'/sitemap-'+kind+'.xml');assert(!xml.includes('<loc>https://ultraclipart.com/art/300-012/</loc>'));assert(xml.includes('<loc>https://ultraclipart.com/art/woman-in-a-flowing-ivory-gown/</loc>'));assert.equal((xml.match(/<url>/g)||[]).length,3);if(kind==='images-1')assert(xml.includes('<image:loc>'+f.rows[0].webp+'</image:loc>'));}
 assert.equal(result.candidate.fixture,true);assert.equal(result.candidate.status,'PRIVATE_UNPUBLISHABLE');assert(pointer.equals(Buffer.from(await(await f.bucket.get('catalog/active.json')).arrayBuffer())));
});
for(const[name,mutate]of[
 ['stale parent',p=>p.parentRoot='f'.repeat(64)],['stale source record checksum',p=>p.changes[0].sourceRecordSHA256='0'.repeat(64)],['changed original asset',p=>p.changes[0].original='https://assets.ultraclipart.com/other.webp'],['unreviewed title',p=>p.changes[0].title='Different Woman'],['reserved descriptive collision',p=>p.changes[0].slug='pumpkin-hot-air-balloon'],['automatic number disambiguation',p=>p.changes[0].slug+='-2'],['invented historical topic relationship',p=>p.changes[0].historicalTopicPrefix='another-topic'],
])test('repair fails closed: '+name,async()=>{const f=await fixture(),p=structuredClone(f.plan);mutate(p);await assert.rejects(f.run(p));assert.equal((await f.bucket.get('catalog/active.json')).size,Buffer.byteLength(JSON.stringify(f.parent.snapshot)));});
