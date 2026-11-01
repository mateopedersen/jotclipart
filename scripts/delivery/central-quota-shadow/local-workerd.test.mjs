// Local workerd + SQLite, synthetic account and secrets, optional local-only R2.
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHmac,createHash} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {build} from 'esbuild';
const require=createRequire(import.meta.resolve('wrangler')),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
const source=path.join(import.meta.dirname,'authority.mjs'),account='a'.repeat(32),limit=10_000_000_000_000;
const secrets={auditor:'11'.repeat(32),writer:'22'.repeat(32),verifier:'33'.repeat(32),viewer:'44'.repeat(32)};
const bundled=await build({entryPoints:[source],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],write:false});
const verifierBundle=await build({stdin:{contents:`import {CapacityAuthority} from './authority.mjs';import {verifyAndCommit} from './shadow-verifier.mjs';export {CapacityAuthority};
 export default {async fetch(request,env){if(new URL(request.url).pathname!=='/fixture-verify')return new Response('Not found',{status:404});try{const p=await request.json();const result=await verifyAndCommit({namespace:env.QUOTA,accountId:env.QUOTA_ACCOUNT_ID,bucketFor:(b,j)=>b==='fixture-bucket'&&j==='default'?env.TEST_BUCKET:null,viewerKey:env.QUOTA_VIEWER_KEY,verifierKey:env.QUOTA_VERIFIER_KEY,reservationId:p.reservationId,attemptId:p.attemptId});return Response.json(result);}catch(e){return Response.json({error:e.message},{status:409});}}};`,resolveDir:import.meta.dirname},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],write:false});
async function runtime(persist,withVerifier=false){
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,unsafeInspectDurableObjects:true,resourcePersistencePath:persist,workers:[{name:'capacity-shadow-fixture',modules:true,script:(withVerifier?verifierBundle:bundled).outputFiles[0].text,compatibilityDate:'2026-10-23',
  durableObjects:{QUOTA:{className:'CapacityAuthority',useSQLite:true}},bindings:{QUOTA_ACCOUNT_ID:account,QUOTA_AUDITOR_KEY:secrets.auditor,QUOTA_WRITER_KEY:secrets.writer,QUOTA_VERIFIER_KEY:secrets.verifier,QUOTA_VIEWER_KEY:secrets.viewer},
  ...(withVerifier?{r2Buckets:['TEST_BUCKET']}:{}),
  outboundService:()=>{throw Error('External network is forbidden in this local fixture');}}]}));
 const ns=await mf.getDurableObjectNamespace('QUOTA');return {mf,ns,stub:ns.get(ns.idFromName(account))};
}
let serial=0;
function signed(role,operation,payload,{commandId=`cmd-${++serial}`,at=Date.now(),key=secrets[role]}={}){
 const body=JSON.stringify({role,commandId,at,operation,payload}),signature=createHmac('sha256',Buffer.from(key,'hex')).update(`UC-R2-CAPACITY-SHADOW-V1\n${body}`).digest('hex');
 return {body,signature,commandId};
}
async function send(stub,role,operation,payload,options){const c=signed(role,operation,payload,options),response=await stub.fetch('https://local.invalid/quota',{method:'POST',headers:{'X-Quota-Signature':c.signature},body:c.body});return {status:response.status,body:await response.json(),command:c};}
const baseline=(bytes=0)=>{const now=Date.now();return {accountId:account,baselineBytes:bytes,baselineSha256:'a'.repeat(64),scopeSha256:'b'.repeat(64),fenceSha256:'c'.repeat(64),observedAt:now,completedAt:now};};
const reservation=(id='r1',maxBytes=10,key='source/item')=>({reservationId:id,bucket:'fixture-bucket',jurisdiction:'default',key,maxBytes,sha256:'d'.repeat(64)});
async function withRuntime(fn){const dir=await mkdtemp(path.join(os.tmpdir(),'quota-local-'));let r;try{r=await runtime(dir);await fn(r,dir);}finally{if(r)await r.mf.dispose();await rm(dir,{recursive:true,force:true});}}

test('isolated singleton and separated HMAC roles fail closed',async()=>withRuntime(async({mf,ns,stub})=>{
 const pub=await mf.dispatchFetch('https://local.invalid/quota',{method:'POST',body:'{}'});assert.equal(pub.status,404);
 const bad=await ns.get(ns.idFromName('b'.repeat(32))).fetch('https://local.invalid/quota',{method:'POST',body:'{}'});assert.equal(bad.status,503);
 const command=signed('auditor','initialize',baseline());let response=await stub.fetch('https://local.invalid/quota',{method:'POST',body:command.body});assert.equal(response.status,403);
 response=await stub.fetch('https://local.invalid/quota',{method:'POST',headers:{'X-Quota-Signature':'00'.repeat(32)},body:command.body});assert.equal(response.status,403);
 assert.equal((await send(stub,'writer','initialize',baseline())).status,403);
 assert.equal((await send(stub,'auditor','initialize',baseline(),{at:Date.now()-50_000})).status,409);
 response=await stub.fetch('https://local.invalid/quota',{method:'POST',body:'x'.repeat(17000)});assert.equal(response.status,413);
 const future=baseline();future.observedAt=Date.now()+10000;future.completedAt=future.observedAt;assert.equal((await send(stub,'auditor','initialize',future)).status,400);
 const init=await send(stub,'auditor','initialize',baseline());assert.equal(init.status,200);assert.equal(init.body.authorizesR2Write,false);assert.equal(init.body.coverageVerified,false);
 await assert.rejects(async()=>stub.perform({operation:'reserve',payload:reservation()},Date.now()));
 await assert.rejects(async()=>stub.one('SELECT * FROM account'));
}));

test('transactional lifecycle holds ambiguous starts and validates role-bound readbacks',async()=>withRuntime(async({stub})=>{
 assert.equal((await send(stub,'auditor','initialize',baseline())).status,200);
 let result=await send(stub,'writer','reserve',reservation());assert.equal(result.status,200);assert.equal(result.body.reservation.state,'RESERVED');assert.equal(result.body.authorizesR2Write,false);
 assert.equal((await send(stub,'writer','reserve',reservation('other',10,'source/item'))).status,409);
 assert.equal((await send(stub,'writer','start',{reservationId:'r1',attemptId:'attempt1'})).body.reservation.state,'STARTED');
 assert.equal((await send(stub,'writer','cancel',{reservationId:'r1'})).body.error,'ATTEMPT_MAY_BE_IN_FLIGHT');
 const receipt={...reservation(),attemptId:'attempt1',bytes:7,etag:'fixture-etag',verifiedAt:Date.now()};delete receipt.maxBytes;
 assert.equal((await send(stub,'writer','commit',receipt)).status,403);
 assert.equal((await send(stub,'verifier','commit',{...receipt,sha256:'e'.repeat(64)})).status,409);
 assert.equal((await send(stub,'verifier','commit',{...receipt,bytes:11})).status,409);
 assert.equal((await send(stub,'verifier','commit',receipt)).body.reservation.state,'COMMITTED');
 result=await send(stub,'viewer','status',{});assert.deepEqual([result.body.baselineBytes,result.body.committedBytes,result.body.heldBytes],[0,7,0]);assert.equal(result.body.authorizesR2Write,false);
 const again=await send(stub,'verifier','commit',receipt);assert.equal(again.status,200);result=await send(stub,'viewer','status',{});assert.equal(result.body.committedBytes,7);
 const holdPayload=reservation('r2',8,'source/other'),hold=await send(stub,'writer','reserve',holdPayload,{commandId:'cancelled-reservation'});assert.equal(hold.status,200);
 assert.equal((await send(stub,'writer','cancel',{reservationId:'r2'})).body.reservation.state,'CANCELLED');assert.equal((await send(stub,'viewer','status',{})).body.heldBytes,0);
 const oldResponse=await send(stub,'writer','reserve',holdPayload,{commandId:'cancelled-reservation'});assert.equal(oldResponse.body.reservation.state,'CANCELLED');assert.equal(oldResponse.body.authorizesR2Write,false);
}));

test('concurrent reservations serialize at the exact account ceiling',async()=>withRuntime(async({stub})=>{
 assert.equal((await send(stub,'auditor','initialize',baseline(limit-25))).status,200);
 const results=await Promise.all(Array.from({length:100},(_,i)=>send(stub,'writer','reserve',reservation(`r-${i}`,1,`key-${i}`))));
 assert.equal(results.filter(r=>r.status===200).length,25);assert.equal(results.filter(r=>r.body.error==='CAPACITY_EXCEEDED').length,75);
 const snapshot=await send(stub,'viewer','status',{});assert.equal(snapshot.body.heldBytes,25);assert.equal(snapshot.body.remainingBytes,0);assert.equal(snapshot.body.authorizesR2Write,false);
}));

test('durable restart preserves pending writes, idempotency and completed balance',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'quota-restart-'));let r;
 try{
  r=await runtime(dir);assert.equal((await send(r.stub,'auditor','initialize',baseline())).status,200);
  const req=reservation('restart-id',10,'same-key'),first=await send(r.stub,'writer','reserve',req,{commandId:'stable-reserve'});assert.equal(first.status,200);
  assert.equal((await send(r.stub,'writer','start',{reservationId:req.reservationId,attemptId:'attempt-1'},{commandId:'stable-start'})).status,200);
  await r.mf.dispose();r=await runtime(dir);
  const snapshot=await send(r.stub,'viewer','status',{});assert.equal(snapshot.status,200,JSON.stringify(snapshot.body));assert.equal(snapshot.body.heldBytes,10);
  const pending=await send(r.stub,'viewer','get',{reservationId:'restart-id'});assert.equal(pending.body.reservation.state,'STARTED');
  assert.equal((await send(r.stub,'writer','cancel',{reservationId:'restart-id'})).status,409);
  const replay=await send(r.stub,'writer','reserve',req,{commandId:'stable-reserve'});assert.equal(replay.body.reservation.state,'STARTED');assert.equal(replay.body.authorizesR2Write,false);
  assert.equal((await send(r.stub,'writer','reserve',{...req,maxBytes:9},{commandId:'stable-reserve'})).body.error,'COMMAND_CONFLICT');
  const receipt={reservationId:'restart-id',attemptId:'attempt-1',bucket:req.bucket,jurisdiction:req.jurisdiction,key:req.key,bytes:8,sha256:req.sha256,etag:'test-etag',verifiedAt:Date.now()};
  const committed=await send(r.stub,'verifier','commit',receipt,{commandId:'stable-commit'});assert.equal(committed.status,200);
  await r.mf.dispose();r=await runtime(dir);
  const recovered=await send(r.stub,'verifier','commit',receipt,{commandId:'stable-commit'});assert.deepEqual(recovered.body,committed.body);
  const after=await send(r.stub,'viewer','status',{});assert.equal(after.body.committedBytes,8);assert.equal(after.body.heldBytes,0);
 }finally{if(r)await r.mf.dispose();await rm(dir,{recursive:true,force:true});}
});

test('SQLite transaction rollback leaves no reservation, command or held bytes',async()=>withRuntime(async({mf,stub})=>{
 assert.equal((await send(stub,'auditor','initialize',baseline())).status,200);
 const storage=await mf.unsafeGetDurableObjectStorage('capacity-shadow-fixture','CapacityAuthority',{name:account});
 await storage.exec("CREATE TRIGGER fixture_abort AFTER INSERT ON reservations BEGIN SELECT RAISE(ABORT, 'fixture'); END");
 const failed=await send(stub,'writer','reserve',reservation('rollback',10,'rollback-key'),{commandId:'rollback-command'});assert.equal(failed.status,503);
 assert.equal((await send(stub,'viewer','status',{})).body.heldBytes,0);assert.equal((await send(stub,'viewer','get',{reservationId:'rollback'})).status,404);
 await storage.exec('DROP TRIGGER fixture_abort');
 const retried=await send(stub,'writer','reserve',reservation('rollback',10,'rollback-key'),{commandId:'rollback-command'});assert.equal(retried.status,200);
 assert.equal((await send(stub,'viewer','status',{})).body.heldBytes,10);assert.equal((await send(stub,'viewer','audit',{})).body.consistent,true);
}));

test('integrity mismatch remains blocked after local durable-object eviction',async()=>withRuntime(async({mf,stub,ns})=>{
 assert.equal((await send(stub,'auditor','initialize',baseline())).status,200);assert.equal((await send(stub,'writer','reserve',reservation())).status,200);
 const storage=await mf.unsafeGetDurableObjectStorage('capacity-shadow-fixture','CapacityAuthority',{name:account});await storage.exec('UPDATE account SET held_bytes=0 WHERE singleton=1');
 const audit=await send(stub,'viewer','audit',{});assert.equal(audit.status,503);assert.equal(audit.body.error,'INTEGRITY_MISMATCH');
 assert.equal((await send(stub,'viewer','status',{})).status,503);
 await mf.unsafeEvictDurableObject('capacity-shadow-fixture','CapacityAuthority',{name:account});
 assert.equal((await send(ns.get(ns.idFromName(account)),'viewer','status',{})).status,503);
}));

test('inconsistent reservation state and damaged baseline remain fail-closed',async()=>withRuntime(async({mf,stub,ns})=>{
 assert.equal((await send(stub,'auditor','initialize',baseline())).status,200);
 assert.equal((await send(stub,'writer','reserve',reservation())).status,200);
 const storage=await mf.unsafeGetDurableObjectStorage('capacity-shadow-fixture','CapacityAuthority',{name:account});
 // The byte balance is unchanged: a STARTED state without an attempt is still invalid.
 await storage.exec("UPDATE reservations SET state='STARTED' WHERE id='r1'");
 assert.equal((await send(stub,'viewer','audit',{})).body.error,'INTEGRITY_MISMATCH');
 await storage.exec("UPDATE reservations SET state='RESERVED' WHERE id='r1'");
 await storage.exec("UPDATE account SET baseline_sha='not-a-hash' WHERE singleton=1");
 await mf.unsafeEvictDurableObject('capacity-shadow-fixture','CapacityAuthority',{name:account});
 assert.equal((await send(ns.get(ns.idFromName(account)),'viewer','status',{})).body.error,'INTEGRITY_MISMATCH');
}));

test('viewer pagination and Unicode key validation preserve stable identities',async()=>withRuntime(async({stub})=>{
 assert.equal((await send(stub,'auditor','initialize',baseline())).status,200);
 for(const [i,key] of ['one/😀','two/é','three/x'].entries())assert.equal((await send(stub,'writer','reserve',reservation(`p-${i}`,1,key))).status,200);
 for(const key of ['bad/\ud800','bad/e\u0301','bad/\0'])assert.equal((await send(stub,'writer','reserve',reservation(`bad-${++serial}`,1,key))).status,400);
 const first=await send(stub,'viewer','list',{state:'RESERVED',cursor:'',limit:2});assert.equal(first.body.reservations.length,2);assert(first.body.nextCursor);
 const second=await send(stub,'viewer','list',{state:'RESERVED',cursor:first.body.nextCursor,limit:2});assert.equal(second.body.reservations.length,1);assert.equal(second.body.nextCursor,null);
 assert.equal((await send(stub,'viewer','list',{state:'RESERVED',cursor:'',limit:101})).status,400);
}));

test('independent full-object verification commits only matching local R2 bytes',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'quota-r2-fixture-'));let r;
 try{
  r=await runtime(dir,true);const data=Buffer.from('independently verified fixture'),sha=createHash('sha256').update(data).digest('hex'),req={...reservation('verify-id',data.length,'source/image.webp'),sha256:sha};
  assert.equal((await send(r.stub,'auditor','initialize',baseline())).status,200);assert.equal((await send(r.stub,'writer','reserve',req)).status,200);
  assert.equal((await send(r.stub,'writer','start',{reservationId:req.reservationId,attemptId:'attempt-verify'})).status,200);
  const verify=async(attemptId='attempt-verify')=>{const response=await r.mf.dispatchFetch('https://local.invalid/fixture-verify',{method:'POST',body:JSON.stringify({reservationId:req.reservationId,attemptId})});return {status:response.status,body:await response.json()};};
  assert.equal((await verify('incorrect-attempt')).body.error,'RESERVATION_NOT_VERIFIABLE');
  assert.equal((await verify()).body.error,'OBJECT_UNAVAILABLE_OR_TOO_LARGE');
  const bucket=await r.mf.getR2Bucket('TEST_BUCKET');await bucket.put(req.key,Buffer.from('wrong-content'));
  assert.equal((await verify()).body.error,'OBJECT_HASH_MISMATCH');assert.equal((await send(r.stub,'viewer','status',{})).body.heldBytes,data.length);
  await bucket.put(req.key,Buffer.alloc(data.length+1));assert.equal((await verify()).body.error,'OBJECT_UNAVAILABLE_OR_TOO_LARGE');
  assert.equal((await send(r.stub,'viewer','status',{})).body.heldBytes,data.length);
  await bucket.put(req.key,data);const accepted=await verify();assert.equal(accepted.status,200);assert.equal(accepted.body.reservation.state,'COMMITTED');assert.equal(accepted.body.authorizesR2Write,false);
  const retry=await verify();assert.equal(retry.status,200);const snapshot=await send(r.stub,'viewer','status',{});assert.equal(snapshot.body.committedBytes,data.length);assert.equal(snapshot.body.heldBytes,0);
 }finally{if(r)await r.mf.dispose();await rm(dir,{recursive:true,force:true});}
});
