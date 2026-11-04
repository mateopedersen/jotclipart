// Source-derived metadata bridge. Metadata-only bridge; canonical records/media remain.
import {createDeltaStore} from '../../scripts/catalog-snapshot/delta-store.mjs';
import {openSnapshot} from '../../server/catalog-snapshot/snapshot-context.mjs';
import {bytesOf,digest,canonical} from '../../server/catalog-collections/store.mjs';
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export async function buildPresentationDelta({parentContext,parentBucket,revision,preparePresentation}){
 if(!/^[a-f0-9]{40}$/.test(revision??'')||revision===parentContext?.snapshot?.revision||typeof preparePresentation!=='function')throw Error('A new source-bound presentation revision is required');
 const overlay=createDeltaStore(parentBucket,parentContext,{maxBytes:256*1024*1024});
 const base=await openSnapshot(overlay.bucket,{provided:parentContext.snapshot});
 if(base.rootSHA256!==parentContext.rootSHA256)throw Error('Presentation predecessor changed');
 const art=await base.getFacet('artworks'),collections=await base.getFacet('collections');
 if(art.type!=='artwork-root'||art.revision!==base.snapshot.revision||!art.directories)throw Error('Invalid inherited ART envelope');
 const stage=async(facet,value)=>{const body=bytesOf(value),sha256=await digest(body),d={key:'catalog/objects/'+facet+'/'+sha256+'.json',sha256,bytes:body.length};await overlay.bucket.put(d.key,body);return d;};
 const rebound={...art,revision};
 const stripRevision=({revision,...rest})=>rest;
 if(!same(stripRevision(art),stripRevision(rebound)))throw Error('Presentation bridge altered canonical ART directories');
 const artworks=await stage('artworks',rebound);
 const discovery=await base.read('collections',collections.discoveryProjection,{maxBytes:262144});
 const surprise=await base.read('collections',collections.surprise,{maxBytes:262144});
 if(discovery.artworkRootSHA256!==base.snapshot.indexes.artworks.sha256||surprise.artworksRootSHA256!==base.snapshot.indexes.artworks.sha256)throw Error('Presentation predecessor projections are stale');
 const nextCollections={...collections,
  discoveryProjection:await stage('collections',{...discovery,artworkRootSHA256:artworks.sha256}),
  surprise:await stage('collections',{...surprise,artworksRootSHA256:artworks.sha256})};
 delete nextCollections.preparedHTML;
 const indexes={...base.snapshot.indexes,artworks,collections:await stage('collections',nextCollections)};
 const candidate={schema:1,fixture:true,status:'PRIVATE_UNPUBLISHABLE',revision,parentRevision:base.snapshot.revision,indexes};
 const current=await openSnapshot(overlay.bucket,{provided:candidate,allowFixture:true,maxReadObjects:20000,maxReadBytes:256*1024*1024});
 const prepared=await preparePresentation({context:current,bucket:overlay.bucket});
 if(!prepared?.collections||!prepared?.receipt)throw Error('Presentation bridge needs canonical renderer evidence');
 indexes.collections=prepared.collections;
 const graph=overlay.verifyChangedClosure(indexes);
 return{status:'PRIVATE_PRESENTATION_BRIDGE_REQUIRES_REPLAY_NATIVE_REMOTE_AND_AUTHORITY',candidate,created:overlay.created,graph,
  parentSnapshotSHA256:parentContext.rootSHA256,presentationReceipt:prepared.receipt,
  bridge:{kind:'PRESENTATION_ONLY_NO_ARTWORK_OR_MEDIA_CHANGE',
   beforeArtworkEnvelope:base.snapshot.indexes.artworks,afterArtworkEnvelope:artworks,
   artworkEnvelopeRevisionOnly:true,canonicalArtworkDirectoriesUnchanged:true,
   canonicalArtworkRecordsChanged:0,topicRecordsChanged:0,mediaBytesChanged:0,
   unchangedFacets:Object.keys(indexes).filter(k=>!['artworks','collections'].includes(k)),
   protectedCollectionDirectoryUnchanged:same(collections.directory,nextCollections.directory),
   parentRevision:base.snapshot.revision,revision},
  metrics:overlay.metrics(),fullCatalogPagesBuilt:0,preparedDiscoveryDocuments:prepared.receipt.canonicalDocumentsPrepared,
  fullArtworkMetadataScans:1,nativeMediaScans:0};
}
