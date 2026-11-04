// Source-replayed, guarded metadata-only publication. No artwork/media upload.
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {withCatalogReader} from '../../scripts/catalog-snapshot/publish-content.mjs';
import {preparePresentationOnly,PRESENTATION_SOURCE_FILES} from './prepare-presentation.mjs';
import {verifyNativeContent} from '../../scripts/catalog-snapshot/test-content-native.mjs';
import {sealCatalogContent} from '../../scripts/catalog-snapshot/seal-content.mjs';
import {activateCatalogContent} from '../../scripts/catalog-snapshot/activate-content.mjs';
import {sharedContentBaseline} from '../../scripts/catalog-snapshot/legacy-source-guard.mjs';
import {verifyPresentationLive} from './verify-presentation-live.mjs';
import {captureProductionSnapshot} from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import {snapshotDigest} from '../../server/catalog-snapshot/release-pointer.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function publishPresentationOnly({software,publicConfig,output,activate=false,progress=()=>{}}){
 const code=JSON.parse(readFileSync(join(software,'runtime/software-report.json'))),
  verifier={...publicConfig,abiSHA256:code.abiSHA256,publicKey:Uint8Array.from(Buffer.from(publicConfig.publicKeyHex,'hex'))},
  control=await(await fetch('https://ultraclipart.com/delivery-release.json',{cache:'no-store'})).json(),
  head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 assert.equal(control.controlRevision,code.revision,'Installed software changed');
 if(!/^[a-f0-9]{64}$/.test(control.verifiedRoot??''))throw Error('Current live source required');
 const baselinePath=sharedContentBaseline(),baselineBytes=existsSync(baselinePath)?readFileSync(baselinePath):null;
 if(baselineBytes)assert.equal(JSON.parse(baselineBytes).verifiedRoot,control.verifiedRoot,'Accepted content baseline is not current');
 output=resolve(output);if(!output.startsWith(resolve('work')+'/')||existsSync(output))throw Error('New protected publication output required');
 const names=PRESENTATION_SOURCE_FILES;
 const packet={schema:1,status:'SOURCE_DERIVED_PRESENTATION_BATCH',publicationIntent:activate?'OWNER_AUTHORIZED_PRESENTATION_ONLY':'PRIVATE_TEST_ONLY',
  sourceCommit:head,revision:head,parentSnapshotSHA256:control.verifiedRoot,softwareABI:code.abiSHA256,
  presentationBundleSHA256:code.presentation?.sha256,sourceHashes:Object.fromEntries(names.map(file=>[file,sha(readFileSync(file))]))};
 mkdirSync(output,{recursive:true});
 if(baselineBytes)writeFileSync(join(output,'baseline-before-presentation.json'),baselineBytes,{flag:'wx'});
 const prepared=await withCatalogReader({directory:join(output,'compose-reader'),verifier,parentSnapshotSHA256:control.verifiedRoot},async parentBucket=>{
  const result=await preparePresentationOnly({packetBytes:Buffer.from(JSON.stringify(packet)),parentBucket,verifier,software,output:join(output,'prepared'),progress});
  const native=await verifyNativeContent({candidate:result.result.candidate,created:result.result.created,parentBucket,software,packet,
   preparedPresentation:result.result.presentationReceipt});
  writeFileSync(join(result.output,'native-integration-report.json'),JSON.stringify(native,null,2));return result;
 });
 if(!activate)return{status:'PRESENTATION_PREPARED_NATIVE_VERIFIED_NOT_LIVE',directory:prepared.output,documents:prepared.result.preparedDiscoveryDocuments};
 execFileSync(process.execPath,['scripts/catalog-snapshot/stage.mjs',prepared.output],{stdio:'inherit'});
 const sealed=await withCatalogReader({directory:join(output,'seal-reader'),verifier,parentSnapshotSHA256:control.verifiedRoot},parentBucket=>
  sealCatalogContent({directory:prepared.output,parentBucket,verifier,software,replay:preparePresentationOnly}));
 const current=await(await fetch('https://ultraclipart.com/delivery-release.json',{cache:'no-store'})).json();
 assert.equal(current.controlRevision,code.revision);assert.equal(current.verifiedRoot,control.verifiedRoot,'Content advanced before presentation activation');
 const receipt={status:'PRESENTATION_POINTER_ACTIVE_LIVE_VALIDATION_PENDING',revision:packet.revision,root:sealed.verifiedRoot,
  parentRevision:prepared.parent.snapshot.revision,parentRoot:control.verifiedRoot,softwareRevision:code.revision,
  softwareABI:code.abiSHA256,sourceCommit:head,preparedDirectory:prepared.output,
  baselinePath,baselineSHA256:baselineBytes?sha(baselineBytes):null,
  canonicalArtworksChanged:0,mediaUploads:0,documents:prepared.result.preparedDiscoveryDocuments,
  bridge:join(prepared.output,'presentation-bridge.json'),at:new Date().toISOString()};
 writeFileSync(join(output,'activation-intent.json'),JSON.stringify({...receipt,status:'PRESENTATION_ACTIVATION_INTENT_NOT_LIVE'},null,2),{flag:'wx'});
 await activateCatalogContent({directory:prepared.output,sealed,verifier});
 writeFileSync(join(output,'activation-result.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
 return finalizePresentationOnly({software,publicConfig,output,progress});
}
export async function finalizePresentationOnly({software,publicConfig,output,progress=()=>{}}){
 output=realpathSync(resolve(output));if(!output.startsWith(realpathSync('work')+'/'))throw Error('Protected active presentation output required');
 const resultPath=join(output,'activation-result.json'),fromIntent=!existsSync(resultPath),receipt=JSON.parse(readFileSync(join(output,fromIntent?'activation-intent.json':'activation-result.json'))),directory=join(output,'prepared'),
  code=JSON.parse(readFileSync(join(software,'runtime/software-report.json'))),snapshotBytes=readFileSync(join(directory,'production-snapshot.json')),
  snapshot=JSON.parse(snapshotBytes),root=await snapshotDigest(snapshot),graphBytes=readFileSync(join(directory,'graph-verified-receipt.json')),graph=JSON.parse(graphBytes),
  baselinePath=sharedContentBaseline();
 assert.equal(receipt.status,fromIntent?'PRESENTATION_ACTIVATION_INTENT_NOT_LIVE':'PRESENTATION_POINTER_ACTIVE_LIVE_VALIDATION_PENDING');assert.equal(receipt.preparedDirectory,directory);
 assert.equal(receipt.root,root);assert.equal(receipt.softwareRevision,code.revision);assert.equal(receipt.softwareABI,code.abiSHA256);
 assert.equal(sha(readFileSync(join(software,'runtime/worker.mjs'))),code.workerSHA256);
 assert.equal(snapshot.authorization.graphReceiptSHA256,sha(graphBytes));
 assert.equal(graph.nativeIntegrationSHA256,sha(readFileSync(join(directory,'native-integration-report.json'))));
 assert.equal(graph.sourceReceiptSHA256,sha(readFileSync(join(directory,'source-receipt.json'))));
 assert.equal(receipt.baselinePath,baselinePath);
 await captureProductionSnapshot({get:async()=>({size:snapshotBytes.length,json:async()=>snapshot})},{...publicConfig,abiSHA256:code.abiSHA256,publicKey:Uint8Array.from(Buffer.from(publicConfig.publicKeyHex,'hex'))});
 const control=await(await fetch('https://ultraclipart.com/delivery-release.json',{signal:AbortSignal.timeout(30000)})).json();
 assert.equal(control.verifiedRoot,root,'Production advanced; verification-only continuation denied');assert.equal(control.controlRevision,code.revision);
 if(fromIntent){receipt.status='PRESENTATION_POINTER_ACTIVE_LIVE_VALIDATION_PENDING';writeFileSync(resultPath,JSON.stringify(receipt,null,2),{flag:'wx'});}
 if(existsSync(join(output,'result.json'))){
  const completed=JSON.parse(readFileSync(join(output,'result.json'))),liveBytes=readFileSync(join(directory,'presentation-live-verification.json')),live=JSON.parse(liveBytes);
  assert.equal(completed.status,'PRESENTATION_HTML_LIVE_VERIFIED_BROWSER_MEDIA_PENDING');assert.equal(completed.root,root);
  assert.equal(completed.softwareABI,code.abiSHA256);assert.equal(completed.softwareRevision,code.revision);assert.equal(completed.preparedDirectory,directory);
  assert.equal(completed.liveReceiptSHA256,sha(liveBytes));assert.equal(live.status,'PREPARED_PRESENTATION_CANONICAL_HTML_LIVE_VERIFIED');
  assert.equal(live.root,root);assert.equal(live.revision,receipt.revision);assert.equal(live.softwareRevision,code.revision);assert.equal(live.documents,completed.liveDocuments);
  return completed;
 }
 const baselineBytes=receipt.baselineSHA256?readFileSync(join(output,'baseline-before-presentation.json')):null;
 let baselineAlreadyFinalized=false;
 if(baselineBytes){
  assert.equal(sha(baselineBytes),receipt.baselineSHA256,'Original baseline receipt changed');
  const currentBytes=readFileSync(baselinePath);
  if(sha(currentBytes)!==receipt.baselineSHA256){
   // Recover only our exact append if the process stopped between the atomic
   // baseline rename and result receipt. Never repeat staging or activation.
   const old=JSON.parse(baselineBytes),current=JSON.parse(currentBytes),list=current.presentationBridges??[],prior=old.presentationBridges??[],last=list.at(-1);
   assert.equal(current.verifiedRoot,root);assert.equal(current.revision,receipt.revision);assert.equal(list.length,prior.length+1);
   assert.deepEqual(list.slice(0,-1),prior);
   assert.deepEqual(last,{parentRevision:receipt.parentRevision,parentRoot:receipt.parentRoot,revision:receipt.revision,root,
    softwareSourceCommit:receipt.sourceCommit,canonicalArtworksChanged:0,mediaBytesChanged:0,
    bridgeReceipt:join(directory,'presentation-bridge.json'),liveReceipt:join(directory,'presentation-live-verification.json')});
   for(const[k,v]of Object.entries(old))if(!['verifiedRoot','revision','presentationBridges','at'].includes(k))assert.deepEqual(current[k],v,'Accepted content baseline advanced: '+k);
   baselineAlreadyFinalized=true;
  }
 }
 const sealed={snapshot,verifiedRoot:root},live=await verifyPresentationLive({directory,sealed,software,progress});
 if(baselineBytes&&!baselineAlreadyFinalized){
  assert.equal(sha(readFileSync(baselinePath)),receipt.baselineSHA256,'Accepted content baseline advanced');
  const old=JSON.parse(baselineBytes),next={...old,verifiedRoot:root,revision:receipt.revision,
   presentationBridges:[...(old.presentationBridges??[]),{parentRevision:receipt.parentRevision,parentRoot:receipt.parentRoot,
    revision:receipt.revision,root,softwareSourceCommit:receipt.sourceCommit,canonicalArtworksChanged:0,mediaBytesChanged:0,
    bridgeReceipt:join(directory,'presentation-bridge.json'),liveReceipt:join(directory,'presentation-live-verification.json')}],at:new Date().toISOString()};
  // Preserve all original content capsules, authority receipts and materialization
  // policy. A presentation bridge is never relabelled as another artwork import.
  const temporary=baselinePath+'.presentation-'+process.pid;writeFileSync(temporary,JSON.stringify(next,null,2),{flag:'wx'});renameSync(temporary,baselinePath);
 }
 const result={...receipt,status:'PRESENTATION_HTML_LIVE_VERIFIED_BROWSER_MEDIA_PENDING',liveDocuments:live.documents,
  liveReceiptSHA256:sha(readFileSync(join(directory,'presentation-live-verification.json')))};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,software,config,output]=process.argv.slice(2);if(!['prepare','publish','finalize'].includes(mode)||!output)throw Error('Use prepare|publish|finalize installed-software public-config work-output');
 const operation=mode==='finalize'?finalizePresentationOnly:publishPresentationOnly;
 const result=await operation({software:resolve(software),publicConfig:JSON.parse(readFileSync(config)),output,
  activate:mode==='publish',progress:r=>console.log(JSON.stringify(r))});
 // Public verifier/receipt values only; no private signing material is returned.
 console.log(JSON.stringify(result));
}
