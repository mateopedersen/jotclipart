// Private bounded immutable lookup; no publication or baseline authorization.
const sha=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function lookupHashedRecord(context,facet,root,name){
 if(typeof name!=='string'||name.length<1||name.length>512)throw Error('Invalid directory key');
 const digest=await sha(name);let descriptor=root,prefix='';
 for(let depth=0;depth<=64;depth++){
  const node=await context.read(facet,descriptor,{maxBytes:65536});
  if(node.schema!==1||node.prefix!==prefix)throw Error('Invalid directory identity');
  if(node.type==='record-leaf'){
   if(!Array.isArray(node.entries)||node.entries.length>256||new Set(node.entries.map(x=>x.name)).size!==node.entries.length)throw Error('Invalid directory leaf');
   for(const row of node.entries){if(typeof row.name!=='string'||row.name.length<1||row.name.length>512||!(await sha(row.name)).startsWith(prefix))throw Error('Wrong directory entry')}
   return node.entries.find(x=>x.name===name)?.value;
  }
  if(node.type!=='record-branch'||!node.children||Array.isArray(node.children)||Object.keys(node.children).length>16||Object.keys(node.children).some(k=>!k.startsWith(prefix)||k.length!==prefix.length+1||!/^[a-f0-9]+$/.test(k)))throw Error('Invalid directory branch');
  prefix=digest.slice(0,prefix.length+1);descriptor=node.children[prefix];if(!descriptor)return undefined;
 }
 throw Error('Directory depth exceeded');
}
