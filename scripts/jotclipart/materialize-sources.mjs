import {readFileSync,writeFileSync,mkdirSync,existsSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

// Preserve exact accepted source capsules separately. Never modify data/ or
// fabricate an editorial approval, a media receipt or missing original archive.
const args=Object.fromEntries(process.argv.slice(2).map(x=>{const at=x.indexOf('=');if(at<0||!x.startsWith('--'))throw Error('Use --name=value');return[x.slice(2,at),x.slice(at+1)]}));
const task=resolve('../../..'),out=resolve(args.output??'work/jotclipart-source-materialization'),reports=resolve(join(task,'reports/jotclipart-migration'));
if(!args.baseline)throw Error('Use --baseline=/absolute/path/to/accepted-baseline.json');
const baselinePath=resolve(args.baseline);
const baselineBytes=readFileSync(baselinePath),baseline=JSON.parse(baselineBytes),supplement=JSON.parse(readFileSync(join(reports,'catalog-supplemental-live-sources.json')));
const sha=b=>createHash('sha256').update(b).digest('hex');
if(baseline.verifiedRoot!==supplement.root)throw Error('Baseline/supplement root mismatch');
if(supplement.differences.length||supplement.records.reduce((n,r)=>n+r.signedLiveMetadataFieldsMatched,0)!==500)throw Error('Supplement lacks exact signed-live source equality');
mkdirSync(join(out,'source-objects'),{recursive:true,mode:0o700});chmodSync(out,0o700);chmodSync(join(out,'source-objects'),0o700);mkdirSync(reports,{recursive:true});
function preserve(bytes){const hash=sha(bytes),path=join(out,'source-objects',hash+'.json.gz');if(existsSync(path)){if(sha(gunzipSync(readFileSync(path)))!==hash)throw Error('Existing preserved source changed')}else writeFileSync(path,gzipSync(bytes,{level:9}),{flag:'wx',mode:0o600});return {sha256:hash,bytes:bytes.length,compressedBytes:readFileSync(path).length,file:'source-objects/'+hash+'.json.gz'}}
const baselineLedger=preserve(baselineBytes),supplementalLedger=preserve(readFileSync(join(reports,'catalog-supplemental-live-sources.json')));
const sourceBaseBytes=readFileSync('data/art.json'),base=JSON.parse(sourceBaseBytes),rawById=new Map(base.map(a=>[a.id,a])),sourceBase=preserve(sourceBaseBytes),capsules=[];
const topics=new Map(),sourceFields=new Map();let changes=0,newIDs=0,replacedIDs=0;
for(const c of [...baseline.capsules,...supplement.records]){
 if(!/^[a-f0-9]{40}$/.test(c.sourceCommit)||!/^data\/catalog-batches\/[a-z0-9][a-z0-9-]*\.json$/.test(c.path)||!/^[a-f0-9]{64}$/.test(c.sha256))throw Error('Invalid reviewed source capsule identity');
 const b=execFileSync('git',['show',c.sourceCommit+':'+c.path],{maxBuffer:64*1024*1024});
 if(sha(b)!==c.sha256)throw Error('Committed reviewed capsule bytes differ');
 const packet=JSON.parse(b);if(packet.status!=='SOURCE_REVIEWED_CONTENT_BATCH'||!Array.isArray(packet.artworkRows)||!Array.isArray(packet.changes))throw Error('Wrong reviewed source capsule');
 for(const row of packet.artworkRows){if(row.id!==row.raw?.id)throw Error('Source identity mismatch');rawById.has(row.id)?replacedIDs++:newIDs++;rawById.set(row.id,row.raw)}
 for(const row of packet.changes){changes++;if(row.record===null){rawById.delete(row.id);sourceFields.delete(row.id)}else sourceFields.set(row.id,row.record)}
 for(const row of packet.topicRows??[])topics.set(row.slug,row);
 capsules.push({sourceCommit:c.sourceCommit,path:c.path,...preserve(b),artworkRows:packet.artworkRows.length,changes:packet.changes.length,sourceStatus:packet.status,sourceRecordRole:baseline.capsules.includes(c)?'baseline-listed-accepted-capsule':'additional-500-source-capsule-verified-against-signed-live-graph',historicalReceiptReverified:false});
}
if(rawById.size!==49858)throw Error('Replayed source ID inventory differs from signed live catalog');
const mergedBytes=Buffer.from(JSON.stringify([...rawById.values()].sort((a,b)=>a.id.localeCompare(b.id))));
const rawCatalog=preserve(mergedBytes),topicRows=preserve(Buffer.from(JSON.stringify([...topics.values()].sort((a,b)=>a.slug.localeCompare(b.slug))))),acceptedNativeRecords=preserve(Buffer.from(JSON.stringify([...sourceFields.values()].sort((a,b)=>a.id.localeCompare(b.id)))));
const audit=JSON.parse(readFileSync(join(reports,'catalog-audit.json')));
if(audit.root!==baseline.verifiedRoot||audit.status!=='OFFLINE_SIGNED_CONTENT_URL_ASSET_IDENTITY_AUDIT_PASSED')throw Error('Completed signed metadata manifest required');
const proof=audit.outputChecksums.find(f=>f.file==='catalog-content-map.jsonl.gz'),manifestBytes=readFileSync(join(reports,'catalog-content-map.jsonl.gz'));
if(!proof||sha(manifestBytes)!==proof.sha256||manifestBytes.length!==proof.bytes)throw Error('Content manifest bytes changed');
const live=new Map(gunzipSync(manifestBytes).toString('utf8').trim().split('\n').map(line=>{const row=JSON.parse(line);return[row.id,row]}));
const missingIDs=[...live.keys()].filter(id=>!rawById.has(id)),extraIDs=[...rawById.keys()].filter(id=>!live.has(id));
if(missingIDs.length||extraIDs.length)throw Error('Replayed source ID set differs from signed live identity set');
const sourceDifferences=[];
for(const [id,row] of sourceFields){const current=live.get(id),fields=[];if(!current){sourceDifferences.push({id,fields:['ID absent in signed live catalog']});continue}
 if(row.title!==current.sourceTitle)fields.push('title');if(sha(Buffer.from(row.description))!==current.descriptionSHA256)fields.push('description');if(sha(Buffer.from(row.alt))!==current.altSHA256)fields.push('alt');if(row.topic!==current.topic)fields.push('topic');
 for(const role of ['pdf','webp','thumb']){const expected=current.assets.find(a=>a.role===(role==='thumb'?'originalThumb':role))??current.assets.find(a=>a.role===role);if(!expected||expected.sha256!==row.files?.[role]?.sha256||expected.bytes!==row.files?.[role]?.bytes)fields.push('files.'+role)}
 if(fields.length)sourceDifferences.push({id,fields});
}
const rawIDsSHA256=sha(Buffer.from([...rawById.keys()].sort().join('\n'))),liveIDsSHA256=sha(Buffer.from([...live.keys()].sort().join('\n')));
const result={status:'EXACT_REVIEWED_SOURCE_CAPSULE_ARCHIVE_AND_RAW_ID_REPLAY_COMPLETE',at:new Date().toISOString(),root:baseline.verifiedRoot,baselineRevision:baseline.revision,baselineSHA256:sha(baselineBytes),baselineLedger,supplementalLedger,sourceBase,sourceBaseRecords:base.length,baselineCapsules:baseline.capsules.length,supplementalCapsules:supplement.records.length,capsules,totalCapsuleChanges:changes,newIDAssignments:newIDs,replacedIDAssignments:replacedIDs,rawCatalogRecords:rawById.size,rawCatalog,latestTopicSourceRows:topics.size,topicRows,latestAcceptedNativeRecords:sourceFields.size,acceptedNativeRecords,pathsAndSourceBytesPreserved:true,editorialReviewClaim:'Exact existing committed reviewed capsules preserved; this is not a new visual review.',sourceSchemaNotes:['The merged raw catalog is a private reconstruction, not a ready-to-deploy canonical graph.','Original exact capsules retain review, sourceFile, transport and integrity context.','Capsule sourceFiles may reference protected old local media; their bytes are not invented or copied by this utility.','Future native imports must validate source capsules against the preserved source objects and actual originals.','No data/ file or deployed metadata object was modified.'],sourceDescriptionsOrAltsRegenerated:false,noCloudChanges:true};
Object.assign(result,{liveIdentitySetVerified:true,rawIDsSHA256,liveIDsSHA256,missingSourceIDs:missingIDs.length,extraSourceIDs:extraIDs.length,latestCapsuleNativeRecordsCompared:sourceFields.size,latestCapsuleNativeDifferences:sourceDifferences,comparisonScope:'Latest capsule-native title/description/ALT/topic/original-media metadata compared to the signed live catalog manifest; raw sources retained without rewriting.'});
writeFileSync(join(out,'source-materialization-manifest.json'),JSON.stringify(result,null,2),{mode:0o600});
writeFileSync(join(reports,'catalog-source-materialization.json'),JSON.stringify({...result,capsules:undefined,archivePath:out},null,2));
console.log(JSON.stringify({status:result.status,rawCatalogRecords:result.rawCatalogRecords,sourceBaseRecords:base.length,baselineCapsules:baseline.capsules.length,supplementalCapsules:supplement.records.length,sourceArchive:out,sourceBytes:capsules.reduce((n,r)=>n+r.bytes,0),compressedBytes:capsules.reduce((n,r)=>n+r.compressedBytes,0)}));
