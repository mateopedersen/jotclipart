// Private incremental recent index. Reuses the tested persistent tree codec.
// All records must already come from the source-bound public resolver.
import {buildMap,mapGet,patchMap,buildOrder,changeOrder,orderedValues,digest,canonical} from '../catalog-search/store.mjs';
import {publicationTime} from '../../src/lib/publication-order.ts';
const idOK=x=>typeof x==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);
function mode(item){if(typeof item.monochrome==='boolean')return item.monochrome;const style=item.style?.toLowerCase();if(!style)return null;if(/black\s*(?:&|and)\s*white|monochrome|silhouette/.test(style))return true;if(/\bcolor(?:ed)?\b|watercolor|full\s*color/.test(style))return false;return null}
async function first(store,root){for await(const row of orderedValues(store,root,'newest',{limit:1}))return row;return null}
const rowFor=(item,n)=>({id:item.id,n,time:publicationTime(item),mode:mode(item)});
const orderRow=(topic,latest)=>({topic,time:latest.time,n:latest.n});
async function summarize(store,topic,value){const [latest,color,monochrome]=await Promise.all([first(store,value.all),first(store,value.color),first(store,value.monochrome)]);return{...value,topic,latest,colorWinner:color,monochromeWinner:monochrome}}
export async function bootstrapRecent(store,records){
 if(!Array.isArray(records)||new Set(records.map(x=>x.id)).size!==records.length)throw Error('Invalid recent baseline');const groups=new Map(),ledger=[],documents=[];
 for(const [n,item] of records.entries()){if(!idOK(item.id)||!idOK(item.topic)||!item.published||!item.indexable)throw Error('Invalid recent item');const row=rowFor(item,n);documents.push(row);ledger.push({key:item.id,value:{n,topic:item.topic,row,sourceSHA256:await digest(JSON.stringify(canonical(item)))}});if(!groups.has(item.topic))groups.set(item.topic,[]);groups.get(item.topic).push(row)}
 const subjects=[],all=[],color=[],monochrome=[];
 for(const [topic,rows] of groups){const value=await summarize(store,topic,{all:await buildOrder(store,'newest',rows),color:await buildOrder(store,'newest',rows.filter(x=>x.mode===false)),monochrome:await buildOrder(store,'newest',rows.filter(x=>x.mode===true))});subjects.push({key:topic,value});const order=orderRow(topic,value.latest);all.push(order);if(value.colorWinner)color.push(order);if(value.monochromeWinner)monochrome.push(order)}
 return store.put({type:'recent-ledger',total:records.length,nextOrdinal:records.length,records:await buildMap(store,'recent-records',ledger),subjects:await buildMap(store,'recent-subjects',subjects),documents:await buildOrder(store,'newest',documents),all:await buildOrder(store,'newest',all),color:await buildOrder(store,'newest',color),monochrome:await buildOrder(store,'newest',monochrome)});
}
export async function applyRecentBatch(store,root,changes){
 const base=await store.get(root);if(base.type!=='recent-ledger'||!Number.isSafeInteger(base.nextOrdinal)||base.nextOrdinal<0||!Array.isArray(changes)||new Set(changes.map(x=>x.id)).size!==changes.length)throw Error('Invalid recent batch');
 let total=base.total,nextOrdinal=base.nextOrdinal,documents=base.documents,all=base.all,color=base.color,monochrome=base.monochrome;const updates=new Map(),subjectUpdates=new Map(),priorSubjects=new Map();
 const subject=async topic=>{if(subjectUpdates.has(topic))return subjectUpdates.get(topic);let value=await mapGet(store,base.subjects,'recent-subjects',topic);priorSubjects.set(topic,value??null);if(!value)value={topic,latest:null,colorWinner:null,monochromeWinner:null,all:await buildOrder(store,'newest',[]),color:await buildOrder(store,'newest',[]),monochrome:await buildOrder(store,'newest',[])};subjectUpdates.set(topic,value);return value};
 for(const change of changes){if(!idOK(change.id)||change.expectedSourceSHA256===undefined)throw Error('Invalid recent change');const prior=await mapGet(store,base.records,'recent-records',change.id);if((prior?.sourceSHA256??null)!==change.expectedSourceSHA256)throw Error('Stale recent source');
  if(prior?.row){let s=await subject(prior.topic);s={...s,all:await changeOrder(store,s.all,'newest',prior.row,true)};if(prior.row.mode===false)s.color=await changeOrder(store,s.color,'newest',prior.row,true);if(prior.row.mode===true)s.monochrome=await changeOrder(store,s.monochrome,'newest',prior.row,true);subjectUpdates.set(prior.topic,s);documents=await changeOrder(store,documents,'newest',prior.row,true);total--}
  const item=change.record;if(item!==null){if(!item||item.id!==change.id||!idOK(item.topic)||!item.published||!item.indexable)throw Error('Invalid recent replacement');const n=prior?.n??nextOrdinal++,row=rowFor(item,n);let s=await subject(item.topic);s={...s,all:await changeOrder(store,s.all,'newest',row)};if(row.mode===false)s.color=await changeOrder(store,s.color,'newest',row);if(row.mode===true)s.monochrome=await changeOrder(store,s.monochrome,'newest',row);subjectUpdates.set(item.topic,s);documents=await changeOrder(store,documents,'newest',row);updates.set(item.id,{n,topic:item.topic,row,sourceSHA256:await digest(JSON.stringify(canonical(item)))});total++}
  else{if(!prior)throw Error('Unknown recent withdrawal');updates.set(change.id,{n:prior.n,topic:prior.topic,row:null,sourceSHA256:null})}
 }
 for(const [topic,value] of subjectUpdates){const prior=priorSubjects.get(topic);if(prior?.latest){const key=orderRow(topic,prior.latest);all=await changeOrder(store,all,'newest',key,true);if(prior.colorWinner)color=await changeOrder(store,color,'newest',key,true);if(prior.monochromeWinner)monochrome=await changeOrder(store,monochrome,'newest',key,true)}const after=await summarize(store,topic,value);subjectUpdates.set(topic,after);if(after.latest){const key=orderRow(topic,after.latest);all=await changeOrder(store,all,'newest',key);if(after.colorWinner)color=await changeOrder(store,color,'newest',key);if(after.monochromeWinner)monochrome=await changeOrder(store,monochrome,'newest',key)}}
 return store.put({...base,total,nextOrdinal,documents,all,color,monochrome,records:await patchMap(store,base.records,'recent-records',updates),subjects:await patchMap(store,base.subjects,'recent-subjects',subjectUpdates)});
}
export async function recentHomeIDs(store,descriptor,limit=15){
 if(!Number.isInteger(limit)||limit<0||limit>100)throw Error('Invalid home recent limit');if(!limit)return[];const root=await store.get(descriptor);if(root.type!=='recent-ledger')throw Error('Invalid recent ledger');
 const lists={};for(const kind of ['all','color','monochrome']){lists[kind]=[];for await(const row of orderedValues(store,root[kind],'newest',{limit}))lists[kind].push(row)}
 const subjects=new Map();for(const row of [...lists.all,...lists.color,...lists.monochrome]){if(subjects.has(row.topic))continue;const value=await mapGet(store,root.subjects,'recent-subjects',row.topic);if(!value?.latest||value.latest.n!==row.n||value.latest.time!==row.time)throw Error('Stale recent subject ordering');subjects.set(row.topic,value)}
 if(!lists.all.length)return[];if(!root.color.count||!root.monochrome.count)return lists.all.map(r=>subjects.get(r.topic).latest.id);
 const used=new Set(),ids=[];let want=subjects.get(lists.all[0].topic).latest.mode??true;
 while(ids.length<limit){let row=(want?lists.monochrome:lists.color).find(r=>!used.has(r.topic)),winner;if(row)winner=want?subjects.get(row.topic).monochromeWinner:subjects.get(row.topic).colorWinner;else{row=lists.all.find(r=>!used.has(r.topic));if(!row)break;winner=subjects.get(row.topic).latest}if(!winner)throw Error('Missing recent mode winner');used.add(row.topic);ids.push(winner.id);want=!want}return ids;
}
export async function newestIDs(store,descriptor,{offset=0,limit=100}={}){if(!Number.isInteger(limit)||limit<0||limit>1000)throw Error('Invalid newest limit');const root=await store.get(descriptor);if(root.type!=='recent-ledger')throw Error('Invalid recent ledger');const ids=[];for await(const row of orderedValues(store,root.documents,'newest',{offset,limit}))ids.push(row.id);return ids}
export async function recentSubjectIDs(store,descriptor,limit=8){
 if(!Number.isInteger(limit)||limit<0||limit>100)throw Error('Invalid recent subject limit');const root=await store.get(descriptor);if(root.type!=='recent-ledger')throw Error('Invalid recent ledger');const result=[];
 for await(const row of orderedValues(store,root.all,'newest',{limit})){const topic=await mapGet(store,root.subjects,'recent-subjects',row.topic);if(!topic?.latest||topic.latest.n!==row.n||topic.latest.time!==row.time)throw Error('Stale recent subject');result.push(topic.latest.id)}return result;
}
export async function updateRecentView(store,directory,changes){
 const root=await store.get(directory);if(root.type!=='recent-directory'||!root.ledger||!root.home)throw Error('Complete recent directory required');
 const ledger=await applyRecentBatch(store,root.ledger,changes),home=await store.get(root.home);if(home.type!=='home-context')throw Error('Invalid homepage record');
 const recentIds=await recentHomeIDs(store,ledger),homeDescriptor=await store.put({...home,recentIds});
 return store.put({...root,ledger,home:homeDescriptor});
}
