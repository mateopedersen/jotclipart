// Private path-update experiment. Sibling summaries require an independently
// authenticated baseline graph; this module alone is not publication proof.
import {createHash} from 'node:crypto';import {makePostingSubtree} from './related-posting-tree.mjs';
const compare=(a,b)=>(b.createdAt??'').localeCompare(a.createdAt??'')||b.id.localeCompare(a.id), best=rows=>[...rows].sort(compare).slice(0,96),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=id=>createHash('sha256').update(id).digest('hex'),valid=x=>x&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x.id??'')&&(x.createdAt===undefined||typeof x.createdAt==='string');
function pack(value,created,maxBytes){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>maxBytes)throw Error('Posting node too large');const sha256=createHash('sha256').update(bytes).digest('hex'),descriptor={key:`catalog/objects/related/${sha256}.json`,sha256,bytes:bytes.length};created.set(descriptor.key,bytes);return descriptor}
export function serializeRemotePosting(root,{maxBytes=524288}={}){const created=new Map();function visit(node){let value;if(node.type==='leaf')value={schema:1,type:'posting-leaf-v2',prefix:node.prefix,entries:node.entries,top:node.top};else if(node.type==='branch'){const children={};for(const key of Object.keys(node.children).sort())children[key]={...visit(node.children[key]),top:node.children[key].top};value={schema:1,type:'posting-branch-v2',prefix:node.prefix,children,top:node.top}}else throw Error('Invalid posting node');return pack(value,created,maxBytes)}return {root:visit(root),created}}
export async function updateRemotePosting(context,root,change,{leafLimit=64,maxBytes=524288}={}){
 const {oldItem,newItem}=change??{};if((!oldItem&&!newItem)||(oldItem&&!valid(oldItem))||(newItem&&!valid(newItem))||(oldItem&&newItem&&oldItem.id!==newItem.id))throw Error('Invalid posting change');
 const id=(oldItem??newItem).id,digest=hash(id),created=new Map();let reads=0;
 function buildSubtree(prefix,rows){const built=serializeRemotePosting(makePostingSubtree(prefix,rows,{leafLimit}),{maxBytes});for(const [key,bytes] of built.created)created.set(key,bytes);return {...built.root,top:best(rows)}}
 async function update(descriptor,prefix){const node=await context.read('related',descriptor,{maxBytes});reads++;if(node.schema!==1||node.prefix!==prefix||!Array.isArray(node.top)||node.top.length>96)throw Error('Invalid posting node');
  if(node.type==='posting-leaf-v2'){if(!Array.isArray(node.entries)||node.entries.length>leafLimit||node.entries.some(x=>!valid(x)||!hash(x.id).startsWith(prefix))||new Set(node.entries.map(x=>x.id)).size!==node.entries.length||!same(node.top,best(node.entries)))throw Error('Invalid posting leaf');const current=node.entries.find(x=>x.id===id);if(oldItem&&(!current||current.createdAt!==oldItem.createdAt))throw Error('Stale posting source');if(!oldItem&&current)throw Error('Duplicate posting');const rows=node.entries.filter(x=>x.id!==id);if(newItem)rows.push({id:newItem.id,...(newItem.createdAt!==undefined?{createdAt:newItem.createdAt}:{})});if(!rows.length&&prefix)return null;return buildSubtree(prefix,rows)}
  if(node.type!=='posting-branch-v2'||!node.children||Object.keys(node.children).length>16)throw Error('Invalid posting branch');const children={...node.children};for(const [key,d] of Object.entries(children)){if(!/^[a-f0-9]+$/.test(key)||key.length!==prefix.length+1||!key.startsWith(prefix)||!Array.isArray(d.top)||d.top.length>96)throw Error('Invalid posting child')}
  if(!same(node.top,best(Object.values(children).flatMap(x=>x.top))))throw Error('Invalid posting summary');const key=digest.slice(0,prefix.length+1),child=children[key];let next;if(child)next=await update(child,key);else{if(oldItem)throw Error('Missing posting');next=buildSubtree(key,[{id:newItem.id,...(newItem.createdAt!==undefined?{createdAt:newItem.createdAt}:{})}])}
  if(next)children[key]=next;else delete children[key];if(!Object.keys(children).length)return buildSubtree(prefix,[]);
  const ordered=Object.fromEntries(Object.keys(children).sort().map(k=>[k,children[k]])),top=best(Object.values(ordered).flatMap(x=>x.top));return {...pack({schema:1,type:'posting-branch-v2',prefix,children:ordered,top},created,maxBytes),top};
 }
 const result=await update(root,'');return {root:{key:result.key,sha256:result.sha256,bytes:result.bytes},top:result.top,created,reads,status:'PRIVATE_DELTA_ONLY_NOT_PUBLISHABLE'};
}

// One-time semantic baseline check. Path updates may reuse sibling summaries
// only if this full graph and its immutable storage were independently trusted.
export async function verifyRemotePostingGraph(context,root,{leafLimit=64,maxBytes=524288,maxNodes=50000}={}){
 let nodes=0,records=0;const seen=new Set();
 async function visit(descriptor,prefix){if(++nodes>maxNodes||prefix.length>64||seen.has(descriptor.key))throw Error('Invalid posting graph');seen.add(descriptor.key);const node=await context.read('related',descriptor,{maxBytes});
  if(node.schema!==1||node.prefix!==prefix||!Array.isArray(node.top)||node.top.length>96)throw Error('Invalid posting node');
  if(node.type==='posting-leaf-v2'){if(!Array.isArray(node.entries)||node.entries.length>leafLimit||node.entries.some(x=>!valid(x)||!hash(x.id).startsWith(prefix))||new Set(node.entries.map(x=>x.id)).size!==node.entries.length||!same(node.top,best(node.entries)))throw Error('Invalid posting leaf');records+=node.entries.length;return node.top}
  if(node.type!=='posting-branch-v2'||!node.children||Object.keys(node.children).length>16)throw Error('Invalid posting branch');const children=Object.entries(node.children);for(const [key,d] of children){if(!/^[a-f0-9]+$/.test(key)||key.length!==prefix.length+1||!key.startsWith(prefix)||!Array.isArray(d.top)||d.top.length>96)throw Error('Invalid posting child');const actual=await visit(d,key);if(!same(actual,d.top))throw Error('Child summary mismatch')}
  if(!same(node.top,best(children.flatMap(([,d])=>d.top))))throw Error('Invalid posting summary');return node.top;
 }
 const top=await visit(root,'');return {status:'PRIVATE_POSTING_GRAPH_ONLY_NOT_PUBLISHABLE',nodes,records,top};
}
