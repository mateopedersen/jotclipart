import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
export function ownerPreviewFingerprint(root,batch){
 const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8')),art=read('data/art.json'),ids=new Set(batch.artworkIds),topics=new Set(batch.topics);
 const records=art.filter(a=>ids.has(a.id)).sort((a,b)=>a.id.localeCompare(b.id));if(records.length!==ids.size)throw Error('Owner preview scope is missing artwork');
 const definitions=[...read('data/topics.json').topics,...read('data/extra-topics.json')].filter(t=>topics.has(t.slug)),copy=read('data/collection-copy.json');
 const scope={records,topics:definitions.sort((a,b)=>a.slug.localeCompare(b.slug)),copy:Object.fromEntries([...topics].sort().map(t=>[t,copy[t]]))};
 return createHash('sha256').update(JSON.stringify(ordered(scope))).digest('hex');
}
export function assertOwnerPublicationApproval(root){
 const file=path.join(root,'data/publication-approval.json');if(!fs.existsSync(file))return;
 const manifest=JSON.parse(fs.readFileSync(file,'utf8'));if(manifest.schema!==1||!Array.isArray(manifest.batches))throw Error('Invalid owner publication approval record');
 const approvedIds=new Set();
 for(const batch of manifest.batches){
  if(batch.status!=='APPROVED_FOR_EXACT_SOURCE')throw Error('Publication held: '+batch.id+' requires owner preview and fresh explicit live approval');
  const approval=batch.approval;
  if(!approval?.ownerMessageId||!approval.ownerThreadId||!approval.approvedAt||approval.previewFingerprint!==batch.previewFingerprint||ownerPreviewFingerprint(root,batch)!==batch.previewFingerprint)throw Error('Owner publication approval is missing or stale: '+batch.id);
  for(const id of batch.artworkIds)approvedIds.add(id);
 }
 const art=JSON.parse(fs.readFileSync(path.join(root,'data/art.json'),'utf8'));
 for(const item of art){if(!item.published||!item.indexable||item.productionMethod!=='generated-raster')continue;if(manifest.acceptedBeforePolicyImageHashes?.[item.id]===item.files?.webp?.sha256)continue;if(!approvedIds.has(item.id))throw Error('New API/generated artwork requires owner preview and explicit batch approval: '+item.id);}
}
