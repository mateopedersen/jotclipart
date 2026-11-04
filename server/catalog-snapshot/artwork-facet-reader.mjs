// Private point reader over one already-captured seven-facet context.
// Returns data only; publication authorization and metadata semantics are separate.
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function readArtwork(context,id){
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id??''))throw Error('Invalid artwork ID');
 const root=await context.getFacet('artworks');if(root.type!=='artwork-root'||root.revision!==context.snapshot.revision||!root.directories)throw Error('Invalid artwork root');
 const fullHash=await hash(new TextEncoder().encode(id)),part=fullHash.slice(0,3),prefix=part.slice(0,2),descriptor=root.directories[prefix];if(!descriptor)return undefined;
 const directory=await context.read('artworks',descriptor);if(directory.type!=='artwork-directory'||directory.prefix!==prefix||!directory.shards)throw Error('Invalid artwork directory');
 let leafDescriptor=directory.shards[part],leafPrefix=part;if(!leafDescriptor)return undefined;
 for(let depth=3;depth<=64;depth++){
  const leaf=await context.read('artworks',leafDescriptor);if(leaf.schema!==1)throw Error('Invalid artwork schema');
  if(leaf.type==='artwork-split'){
   if(depth===64||leaf.prefix!==leafPrefix||!leaf.children||Array.isArray(leaf.children)||Object.keys(leaf.children).length>16||Object.keys(leaf.children).some(k=>!k.startsWith(leafPrefix)||k.length!==depth+1||!/^[a-f0-9]+$/.test(k)))throw Error('Invalid artwork split');
   leafPrefix=fullHash.slice(0,depth+1);leafDescriptor=leaf.children[leafPrefix];if(!leafDescriptor)return undefined;continue;
  }
  if(leaf.shard!==leafPrefix||!Array.isArray(leaf.records)||new Set(leaf.records.map(x=>x.id)).size!==leaf.records.length)throw Error('Invalid artwork leaf');
  for(const row of leaf.records)if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id??'')||!(await hash(new TextEncoder().encode(row.id))).startsWith(leafPrefix))throw Error('Artwork in wrong leaf');
  return leaf.records.find(x=>x.id===id);
 }
 throw Error('Artwork depth exceeded');
}
