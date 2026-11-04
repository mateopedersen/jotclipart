import test from 'node:test';
import assert from 'node:assert/strict';
import {readCollectionRegistries,verifyCollectionOpenings,collectionOpening,normalizeCollectionProse} from '../scripts/collection-editorial.mjs';
const registry=(entries)=>({topics:Object.fromEntries(entries.map(([topic,text])=>[topic,{paragraphs:[text,'Inventory paragraph.']}]))});
test('all674 current openings are distinct beyond a subject-name substitution and contain no prose dashes',()=>{
 const r=readCollectionRegistries(),v=verifyCollectionOpenings(r);assert.equal(v.uniqueOpenings,674);assert.equal(v.uniqueOpeningTemplates,674);
 for(const[topic,record]of Object.entries(r.topics)){assert.doesNotMatch(record.intro+record.paragraphs.join(' '),/[\u2010-\u2015-]/,topic);assert(!record.paragraphs[0].includes('{{artworkCount}}'));assert.equal((record.paragraphs.join(' ').match(/\{\{artworkCount\}\}/g)??[]).length,1,topic)}
});
test('same opening is rejected even if later sentences are different',()=>{
 assert.throws(()=>verifyCollectionOpenings(registry([['one','A familiar opening introduces these drawings. Different tail.'],['two','A familiar opening introduces these drawings. Another tail.']])),/Repeated collection opening/);
});
test('changing only topic names cannot bypass the opening review',()=>{
 assert.throws(()=>verifyCollectionOpenings(registry([['apple','Apple drawings suit many projects. One tail.'],['pear','Pear drawings suit many projects. Another tail.']])),/Topic-name-substituted/);
});
test('new collections cannot use the generic welcome/count opening',()=>{
 for(const first of ['Welcome to our new collection.','Welcome to the new collection.','Choose from {{artworkCount}} illustrations.'])assert.throws(()=>verifyCollectionOpenings(registry([['future',first]])),/generic welcome or count/);
});
test('the sentence boundary keeps country abbreviations intact',()=>{
 assert.equal(collectionOpening('U.S. state shapes appear in voting layouts. Another sentence.'),'U.S. state shapes appear in voting layouts.');
});
test('prose formatting removes compounds and preserves the meaning of numeric ranges',()=>{
 assert.equal(normalizeCollectionProse('Blue-and-Gold artwork — from 1970–1979.'),'Blue and Gold artwork from 1970 to 1979.');
 assert.equal(normalizeCollectionProse('A black-and-white, fabric-covered view.'),'A black and white, fabric covered view.');
});
