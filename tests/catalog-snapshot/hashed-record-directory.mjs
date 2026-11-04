import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildHashedRecordDirectory} from '../../server/catalog-snapshot/hashed-record-directory-build.mjs';
import {lookupHashedRecord} from '../../server/catalog-snapshot/hashed-record-directory.mjs';
function reader(objects){return{read:async(facet,d,{maxBytes})=>{assert.equal(d.key,`catalog/objects/${facet}/${d.sha256}.json`);const bytes=objects.get(d.key);if(!bytes||bytes.length!==d.bytes||bytes.length>maxBytes||createHash('sha256').update(bytes).digest('hex')!==d.sha256)throw Error('Invalid bytes');return JSON.parse(bytes)}}}
test('bounded directory retrieves arbitrary posting keys across hashed partitions',async()=>{
 const entries=Array.from({length:5000},(_,i)=>({name:`subject-${i}:tech:ink`,value:{id:i}})),built=buildHashedRecordDirectory('related',entries,{leafLimit:32}),context=reader(built.created);
 assert(built.created.size>100);for(const i of [0,1,137,2400,4999])assert.deepEqual(await lookupHashedRecord(context,'related',built.root,entries[i].name),{id:i});assert.equal(await lookupHashedRecord(context,'related',built.root,'missing:posting'),undefined);
 assert([...built.created.values()].every(x=>x.length<=65536));
});
test('directory rejects ambiguous keys and altered or cross-facet bytes',async()=>{
 assert.throws(()=>buildHashedRecordDirectory('related',[{name:'duplicate',value:1},{name:'duplicate',value:2}]));
 const built=buildHashedRecordDirectory('related',[{name:'source',value:1}]),ctx=reader(built.created);
 await assert.rejects(lookupHashedRecord(ctx,'search',built.root,'source'));
 built.created.set(built.root.key,Buffer.from('corrupt'));await assert.rejects(lookupHashedRecord(ctx,'related',built.root,'source'));
});
test('hash-valid directory with wrong leaf identity still fails',async()=>{
 const body=Buffer.from(JSON.stringify({schema:1,type:'record-leaf',prefix:'a',entries:[{name:'source',value:1}]})),sha256=createHash('sha256').update(body).digest('hex'),root={key:`catalog/objects/related/${sha256}.json`,sha256,bytes:body.length};
 await assert.rejects(lookupHashedRecord(reader(new Map([[root.key,body]])),'related',root,'source'));
});
