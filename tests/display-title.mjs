import test from 'node:test';import assert from 'node:assert/strict';
import {displayTitle} from '../src/lib/display-title.ts';
test('all topic and image headings share initial capitals without rewriting identity',()=>{
 for(const [a,b]of [['Lesotho flag clipart','Lesotho Flag Clipart'],['Netherlands flag clipart','Netherlands Flag Clipart'],['Nauru Flag clipart','Nauru Flag Clipart'],['Namibia Flag clipart','Namibia Flag Clipart'],["a child's blue and gold drawing","A Child's Blue And Gold Drawing"],['iPhone 17 Pro and MacBook','iPhone 17 Pro And MacBook'],['USA NASA WebP PDF','USA NASA WebP PDF'],['ChatGPT and OpenAI','ChatGPT And OpenAI'],['100th day of school 3d','100th Day Of School 3D']]){assert.equal(displayTitle(a),b);assert.equal(displayTitle(b),b)}
});
