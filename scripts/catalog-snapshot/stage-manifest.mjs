// Exact immutable metadata input validation. No credentials, writes or activation.
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {merkle} from '../delivery/manifest.mjs';
export const sha256=body=>createHash('sha256').update(body).digest('hex');
export function validateMetadataManifest(manifest,{sourceRoot=resolve('work')}={}){
 if(manifest?.schema!==1||manifest.status!=='REVIEWED_METADATA_REQUIRES_REMOTE_READBACK'||!/^[a-f0-9]{40}$/.test(manifest.revision??'')||!Array.isArray(manifest.records)||!manifest.records.length||!manifest.sourceByKey)throw Error('Reviewed immutable metadata manifest required');
 const keys=new Set(),paths=new Set(),base=realpathSync(sourceRoot)+'/';
 for(const r of manifest.records){
  if(!/^catalog\/objects\/(artworks|collections|search|recent|related|counts|sitemaps)\/[a-f0-9]{64}\.json$/.test(r.key)||r.key.split('/').at(-1)!==r.sha256+'.json'||r.path!=='/catalog-snapshot/'+r.key.slice('catalog/objects/'.length)||r.mime!=='application/json'||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>1048576||keys.has(r.key)||paths.has(r.path))throw Error('Invalid or duplicate metadata scope');
  const file=manifest.sourceByKey[r.key];if(typeof file!=='string'||lstatSync(file).isSymbolicLink()||!realpathSync(file).startsWith(base))throw Error('Metadata source outside protected task work');
  keys.add(r.key);paths.add(r.path);
 }
 if(merkle(manifest.records).root!==manifest.root)throw Error('Metadata Merkle root differs');
 return manifest;
}
export function readMetadataBytes(manifest,record){
 const bytes=readFileSync(manifest.sourceByKey[record.key]);
 if(bytes.length!==record.bytes||sha256(bytes)!==record.sha256)throw Error('Metadata source changed: '+record.key);
 const value=JSON.parse(bytes);if(value.fixture===true||['PRIVATE_UNPUBLISHABLE','UNIMPLEMENTED_FIXTURE_FACET'].includes(value.status))throw Error('Private node cannot stage');
 return bytes;
}
