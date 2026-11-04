// Private path-only writer. An authenticated immutable baseline is prerequisite.
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export async function updateHashedRecord(context,facet,root,{name,expectedValue,newValue},{maxBytes=65536,leafLimit=256}={}){
 if(!['artworks','collections','search','recent','related','counts','sitemaps'].includes(facet)||typeof name!=='string'||!name.length||name.length>512||(!expectedValue&&expectedValue!==null)||(!newValue&&newValue!==null)||!Number.isInteger(leafLimit)||leafLimit<1||leafLimit>256)throw Error('Invalid directory change');
 const encode=new TextEncoder(),keyHash=await digest(encode.encode(name)),created=new Map();let reads=0;
 async function pack(value){const bytes=encode.encode(JSON.stringify(value));if(bytes.length>maxBytes)throw Error('Directory node too large');const sha256=await digest(bytes),descriptor={key:`catalog/objects/${facet}/${sha256}.json`,sha256,bytes:bytes.length};created.set(descriptor.key,bytes);return descriptor}
 async function split(rows,prefix){rows=[...rows].sort((a,b)=>a.name.localeCompare(b.name,'en'));const node={schema:1,type:'record-leaf',prefix,entries:rows};if(rows.length<=leafLimit&&encode.encode(JSON.stringify(node)).length<=maxBytes)return pack(node);if(prefix.length===64)throw Error('Directory hash collision');const groups=new Map();for(const row of rows){const part=(await digest(encode.encode(row.name))).slice(0,prefix.length+1);if(!groups.has(part))groups.set(part,[]);groups.get(part).push(row)}const children={};for(const [p,r] of [...groups].sort(([a],[b])=>a.localeCompare(b)))children[p]=await split(r,p);return pack({schema:1,type:'record-branch',prefix,children})}
 async function update(descriptor,prefix){const node=await context.read(facet,descriptor,{maxBytes});reads++;if(node.schema!==1||node.prefix!==prefix)throw Error('Invalid directory identity');
  if(node.type==='record-leaf'){
   if(!Array.isArray(node.entries)||node.entries.length>leafLimit||new Set(node.entries.map(x=>x.name)).size!==node.entries.length)throw Error('Invalid directory leaf');for(const row of node.entries){if(typeof row.name!=='string'||!row.name.length||row.name.length>512||!(await digest(encode.encode(row.name))).startsWith(prefix)||!row.value)throw Error('Invalid directory row')}
   const before=node.entries.find(x=>x.name===name)?.value??null;if(!same(before,expectedValue))throw Error('Stale directory source');const rows=node.entries.filter(x=>x.name!==name);if(newValue!==null)rows.push({name,value:newValue});return split(rows,prefix);
  }
  if(node.type!=='record-branch'||!node.children||Array.isArray(node.children)||Object.keys(node.children).length>16||Object.keys(node.children).some(k=>!k.startsWith(prefix)||k.length!==prefix.length+1||!/^[a-f0-9]+$/.test(k)))throw Error('Invalid directory branch');
  const part=keyHash.slice(0,prefix.length+1),children={...node.children};if(children[part])children[part]=await update(children[part],part);else{if(expectedValue!==null)throw Error('Missing directory source');if(newValue===null)return descriptor;children[part]=await split([{name,value:newValue}],part)}return pack({schema:1,type:'record-branch',prefix,children:Object.fromEntries(Object.keys(children).sort().map(k=>[k,children[k]]))});
 }
 return{root:await update(root,''),created,reads,status:'PRIVATE_DIRECTORY_DELTA_ONLY_NOT_PUBLISHABLE'};
}
