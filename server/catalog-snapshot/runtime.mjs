// Production adapter: one authenticated snapshot, budget, cache and fallback.
import {captureProductionSnapshot} from './signed-production-snapshot.mjs';
import {requestBucket} from './request-bucket.mjs';
import {createCatalogHandler} from './handler.mjs';
import {validateInlineScripts,applyCatalogHeaders} from './response-policy.mjs';
import {compressHtml,compressCatalogJson} from '../delivery/compress-html.mjs';
import {immutableMetadataCache} from './immutable-cache.mjs';
import {immutableEdgeMetadata} from './immutable-edge-cache.mjs';
import {presentationResponse} from './brand-presentation.mjs';
export function createSnapshotRuntime({renderers,verifier,softwareRevision,policy,redirects={}}){
 if(!verifier?.publicKey||!/^[a-f0-9]{40}$/.test(softwareRevision??'')||!policy?.page||!policy?.editor||!policy?.inlineSHA256?.length)throw Error('Reviewed software configuration required');
 const metadata=immutableMetadataCache(),edge=immutableEdgeMetadata(globalThis.caches?.default);
 return async(request,env,execution)=>{
  const bucket=requestBucket({get:key=>metadata.get({get:k=>edge.get(env.CATALOG_PAGES,k,execution)},key)}),handler=createCatalogHandler({bucket,renderers,softwareRevision,redirects,rendererSHA256:verifier.abiSHA256,cache:globalThis.caches?.default,defer:execution?.waitUntil?task=>execution.waitUntil(task):undefined,capture:()=>captureProductionSnapshot(bucket,verifier),validateHTML:html=>validateInlineScripts(html,policy.inlineSHA256)});
  const response=await handler(request);if(!response)return null;
  return compressHtml(request,compressCatalogJson(request,applyCatalogHeaders(await presentationResponse(response),new URL(request.url).pathname,policy)));
 };
}
