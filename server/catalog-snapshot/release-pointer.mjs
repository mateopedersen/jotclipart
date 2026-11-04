// Isolated prototype: never wired to the production bucket or a public endpoint.
const REQUIRED = ['artworks','collections','search','recent','related','counts','sitemaps'];
const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value};
export async function snapshotDigest(snapshot){const bytes=new TextEncoder().encode(JSON.stringify(canonical(snapshot)));const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')}

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== 1 || !revision.test(snapshot.revision ?? '') || !revision.test(snapshot.parentRevision ?? ''))
    throw Error('Invalid snapshot identity');
  if (snapshot.revision === snapshot.parentRevision) throw Error('Snapshot must advance');
  for (const name of REQUIRED) {
    const object = snapshot.indexes?.[name];
    if (!object || !digest.test(object.sha256 ?? '') || !Number.isSafeInteger(object.bytes) || object.bytes <= 0 ||
        object.key !== `catalog/objects/${name}/${object.sha256}.json`)
      throw Error(`Missing or invalid ${name} snapshot`);
  }
  if (Object.keys(snapshot.indexes).length !== REQUIRED.length) throw Error('Unexpected snapshot index');
  return snapshot;
}

// Read-back and coverage verification must precede the one conditional update.
// `verify` is supplied by the caller and must independently verify actual bytes,
// route coverage, media, editorial approvals, and compatibility before production.
export async function activateSnapshot({bucket,pointerKey,snapshot,verify}) {
  // Capture one immutable descriptor before any asynchronous verification.
  snapshot=freeze(JSON.parse(JSON.stringify(snapshot)));
  validateSnapshot(snapshot);
  if(snapshot.fixture===true||snapshot.status==='PRIVATE_UNPUBLISHABLE')throw Error('Private fixture cannot activate');
  const snapshotSha256=await snapshotDigest(snapshot);
  if (typeof verify !== 'function') throw Error('Independent verification required');
  if (pointerKey !== 'catalog/active.json') throw Error('Invalid pointer scope');
  const current=await bucket.get(pointerKey);
  if (!current || !current.etag) throw Error('Active pointer not found');
  const before=await current.json();
  if (before.revision !== snapshot.parentRevision) throw Error('Production parent changed');
  const proof=await verify(snapshot);
  if (proof?.status !== 'VERIFIED' || proof.revision !== snapshot.revision || proof.parentRevision !== snapshot.parentRevision || proof.snapshotSha256 !== snapshotSha256 || await snapshotDigest(snapshot) !== snapshotSha256)
    throw Error('Snapshot verification failed');
  const next=JSON.stringify(snapshot);
  const updated=await bucket.put(pointerKey,next,{onlyIf:{etagMatches:current.etag},httpMetadata:{contentType:'application/json',cacheControl:'no-store'}});
  if (!updated) throw Error('Concurrent activation detected');
  return {revision:snapshot.revision,etag:updated.etag};
}
