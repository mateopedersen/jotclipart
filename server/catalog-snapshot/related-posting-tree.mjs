// Private persistent ordered-posting model. External authenticated node storage,
// taxonomy bindings, transaction orchestration and live routing are not included.
import {createHash} from 'node:crypto';
const idPattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const digest=id=>createHash('sha256').update(id).digest('hex');
const cmp=(a,b)=>(b.createdAt??'').localeCompare(a.createdAt??'')||b.id.localeCompare(a.id);
const valid=x=>x&&idPattern.test(x.id??'')&&(x.createdAt===undefined||typeof x.createdAt==='string');
const best=rows=>[...rows].sort(cmp).slice(0,96);
function makeLeaf(prefix,rows){return Object.freeze({type:'leaf',prefix,entries:Object.freeze([...rows].sort(cmp)),top:Object.freeze(best(rows))})}
function build(prefix,rows,leafLimit){
 if(rows.length<=leafLimit)return makeLeaf(prefix,rows);
 if(prefix.length>=64)throw Error('Posting hash collision');const groups=new Map();
 for(const row of rows){const key=digest(row.id).slice(0,prefix.length+1);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}
 const children=Object.fromEntries([...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,build(key,value,leafLimit)]));
 return Object.freeze({type:'branch',prefix,children:Object.freeze(children),top:Object.freeze(best(Object.values(children).flatMap(node=>node.top)))});
}
export function makePostingTree(rows,{leafLimit=64}={}){
 if(!Array.isArray(rows)||!Number.isInteger(leafLimit)||leafLimit<1||leafLimit>256||rows.some(x=>!valid(x))||new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('Invalid posting list');
 return build('',rows.map(({id,createdAt})=>Object.freeze({id,createdAt})),leafLimit);
}
export function makePostingSubtree(prefix,rows,{leafLimit=64}={}){
 if(!/^[a-f0-9]*$/.test(prefix??'')||prefix.length>64||!Array.isArray(rows)||!Number.isInteger(leafLimit)||leafLimit<1||leafLimit>256||rows.some(x=>!valid(x)||!digest(x.id).startsWith(prefix))||new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('Invalid posting subtree');
 return build(prefix,rows.map(({id,createdAt})=>Object.freeze({id,createdAt})),leafLimit);
}
export function getPosting(root,id){if(!idPattern.test(id??''))throw Error('Invalid posting ID');const h=digest(id);let node=root;while(node?.type==='branch'){node=node.children[h.slice(0,node.prefix.length+1)];if(!node)return undefined}if(!node||node.type!=='leaf'||!h.startsWith(node.prefix))throw Error('Invalid posting node');return node.entries.find(row=>row.id===id)}
export function patchPosting(root,{oldItem,newItem},{leafLimit=64}={}){
 if(!Number.isInteger(leafLimit)||leafLimit<1||leafLimit>256)throw Error('Invalid posting leaf limit');
 if((!oldItem&&!newItem)||(oldItem&&!valid(oldItem))||(newItem&&!valid(newItem))||(oldItem&&newItem&&oldItem.id!==newItem.id))throw Error('Invalid posting change');
 if(newItem)newItem=Object.freeze({id:newItem.id,createdAt:newItem.createdAt});const id=(oldItem??newItem).id,old=getPosting(root,id);
 if(oldItem&&(!old||old.createdAt!==oldItem.createdAt))throw Error('Stale posting source');if(!oldItem&&old)throw Error('Duplicate posting ID');
 const h=digest(id);
 function update(node){if(!node||!h.startsWith(node.prefix))throw Error('Invalid posting path');if(node.type==='leaf'){const entries=node.entries.filter(x=>x.id!==id);if(newItem)entries.push(newItem);return build(node.prefix,entries,leafLimit)}
  if(node.type!=='branch')throw Error('Invalid posting node');const key=h.slice(0,node.prefix.length+1),child=node.children[key];if(!child&&!newItem)throw Error('Missing posting');const replacement=child?update(child):makeLeaf(key,[newItem]);const children={...node.children};if(replacement.type==='leaf'&&!replacement.entries.length)delete children[key];else children[key]=replacement;
  return Object.freeze({type:'branch',prefix:node.prefix,children:Object.freeze(children),top:Object.freeze(best(Object.values(children).flatMap(x=>x.top)))});
 }
 return update(root);
}
