import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSingleFlight } from '../server/catalog-snapshot/render-single-flight.mjs';
const html = text => new Response(text,{headers:{'content-type':'text/html'}});
test('an unfinished render never holds another invocation open at the same captured route',async()=>{
 const cache={};let release;
 const gate=new Promise(r=>release=r);
 const first=renderSingleFlight(cache,'same-root-route',async()=>{await gate;return html('first')});
 let secondCompleted=false;
 const second=renderSingleFlight(cache,'same-root-route',async()=>html('second')).then(r=>{secondCompleted=true;return r});
 try{await new Promise(r=>setTimeout(r,20));assert.equal(secondCompleted,true)}finally{release();await first}
 assert.equal(await(await second).text(),'second');
});
test('failed and personalized renders do not transfer their result to another request',async()=>{
 const cache={};let release;
 const gate=new Promise(r=>release=r);
 const first=renderSingleFlight(cache,'same',async()=>{await gate;throw Error('read failed')});
 const second=renderSingleFlight(cache,'same',async()=>new Response('visitor two',{headers:{'set-cookie':'private=two'}}));
 release();
 const results=await Promise.allSettled([first,second]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
 assert.equal(await results[1].value.text(),'visitor two');
 assert.equal(results[1].value.headers.get('set-cookie'),'private=two');
});
