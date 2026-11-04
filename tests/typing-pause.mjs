import test from 'node:test';import assert from 'node:assert/strict';import{typingPause}from'../src/lib/search-request.ts';
test('rapid typing cancels the grace period before any artwork work begins',async()=>{const c=new AbortController();let ran=false;const task=(async()=>{await typingPause(c.signal);ran=true})();c.abort();await assert.rejects(task,{name:'AbortError'});assert.equal(ran,false)});
test('a settled short query still performs artwork search',async()=>{const c=new AbortController();await typingPause(c.signal,10);assert(!c.signal.aborted)});
