import {JURISDICTIONS,isAccount,isBucket,isId,isKey,isSha} from './protocol.mjs';

// Local/shadow verifier only. It independently reads the entire bounded R2
// object before sending a role-separated receipt to the shadow authority.
// It does not mint an upload permit or claim external writers are fenced.
const encoder=new TextEncoder(),hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const unhex=text=>Uint8Array.from(text.match(/../g),x=>parseInt(x,16));
async function signedCall(stub,role,operation,payload,secret){
 const command={role,commandId:crypto.randomUUID(),at:Date.now(),operation,payload},raw=JSON.stringify(command);
 const key=await crypto.subtle.importKey('raw',unhex(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=hex(await crypto.subtle.sign('HMAC',key,encoder.encode(`UC-R2-CAPACITY-SHADOW-V1\n${raw}`)));
 const response=await stub.fetch('https://quota.internal/quota',{method:'POST',headers:{'X-Quota-Signature':signature},body:raw});
 let body;try{body=await response.json();}catch{throw Error('AUTHORITY_INVALID_RESPONSE');}
 if(!response.ok||body?.mode!=='SHADOW'||body.authorizesR2Write!==false)throw Error('AUTHORITY_REJECTED');return body;
}
async function readExact(object,maximum){
 if(!object||!Number.isSafeInteger(object.size)||object.size<1||object.size>maximum||!object.body)throw Error('OBJECT_UNAVAILABLE_OR_TOO_LARGE');
 const reader=object.body.getReader(),chunks=[];let size=0;
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>maximum||size>object.size){await reader.cancel();throw Error('OBJECT_SIZE_MISMATCH');}chunks.push(item.value);}}
 finally{reader.releaseLock();}
 if(size!==object.size)throw Error('OBJECT_SIZE_MISMATCH');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return {size,sha256:hex(await crypto.subtle.digest('SHA-256',bytes))};
}
export async function verifyAndCommit({namespace,accountId,bucketFor,viewerKey,verifierKey,reservationId,attemptId,maximumBytes=8_000_000}){
 if(!namespace||typeof namespace.idFromName!=='function'||typeof namespace.get!=='function'||!isAccount(accountId)||typeof bucketFor!=='function'||
   !isSha(viewerKey)||!isSha(verifierKey)||viewerKey===verifierKey||!isId(reservationId)||!isId(attemptId)||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>8_000_000)throw Error('INVALID_VERIFIER_CONFIGURATION');
 const stub=namespace.get(namespace.idFromName(accountId)),lookup=await signedCall(stub,'viewer','get',{reservationId},viewerKey),r=lookup.reservation;
 if(!r||r.reservationId!==reservationId||!['STARTED','COMMITTED'].includes(r.state)||r.attemptId!==attemptId||!isBucket(r.bucket)||!JURISDICTIONS.includes(r.jurisdiction)||!isKey(r.key)||!isSha(r.sha256)||!Number.isSafeInteger(r.maxBytes)||r.maxBytes<1)throw Error('RESERVATION_NOT_VERIFIABLE');
 const bucket=bucketFor(r.bucket,r.jurisdiction);if(!bucket||typeof bucket.get!=='function')throw Error('UNKNOWN_BUCKET');
 const object=await bucket.get(r.key);if(!object||typeof object.etag!=='string'||!object.etag||object.etag.length>256||/[\x00-\x1f\x7f]/.test(object.etag))throw Error('OBJECT_UNAVAILABLE_OR_TOO_LARGE');
 const measured=await readExact(object,Math.min(maximumBytes,r.maxBytes));if(measured.sha256!==r.sha256)throw Error('OBJECT_HASH_MISMATCH');
 const receipt={reservationId,attemptId,bucket:r.bucket,jurisdiction:r.jurisdiction,key:r.key,bytes:measured.size,sha256:measured.sha256,etag:object.etag,verifiedAt:Date.now()};
 return signedCall(stub,'verifier','commit',receipt,verifierKey);
}
