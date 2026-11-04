// Private deterministic initial conversion. Future writes require path updates.
import {createHash} from 'node:crypto';
export function buildHashedRecordDirectory(facet,entries,{maxBytes=65536,leafLimit=256}={}){
 if(!['artworks','collections','search','recent','related','counts','sitemaps'].includes(facet)||!Array.isArray(entries)||!Number.isInteger(leafLimit)||leafLimit<1||leafLimit>256)throw Error('Invalid directory input');
 const digest=s=>createHash('sha256').update(s).digest('hex'),seen=new Set(),created=new Map();
 for(const e of entries){if(typeof e?.name!=='string'||e.name.length<1||e.name.length>512||seen.has(e.name)||!e.value)throw Error('Invalid directory entry');seen.add(e.name)}
 function pack(value){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>maxBytes)throw Error('Directory node too large');const sha256=digest(bytes),d={key:`catalog/objects/${facet}/${sha256}.json`,sha256,bytes:bytes.length};created.set(d.key,bytes);return d}
 function visit(rows,prefix){const node={schema:1,type:'record-leaf',prefix,entries:[...rows].sort((a,b)=>a.name.localeCompare(b.name,'en'))};if(rows.length<=leafLimit&&Buffer.byteLength(JSON.stringify(node))<=maxBytes)return pack(node);if(prefix.length===64)throw Error('Directory hash collision');const groups=new Map();for(const row of rows){const key=digest(row.name).slice(0,prefix.length+1);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}return pack({schema:1,type:'record-branch',prefix,children:Object.fromEntries([...groups].sort(([a],[b])=>a.localeCompare(b)).map(([p,r])=>[p,visit(r,p)]))})}
 return{root:visit(entries,''),created};
}
