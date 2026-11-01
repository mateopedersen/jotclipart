import {DurableObject} from 'cloudflare:workers';
import {LIMIT_BYTES,MAX_COMMAND_AGE_MS,JURISDICTIONS,ProtocolError,authenticate,exactKeys,fail,isAccount,isBucket,isId,isKey,isNatural,isPositive,isSha,readBoundedText} from './protocol.mjs';

// Shadow-only Durable Object. There is deliberately no R2 binding, no upload
// gateway, and no command which emits a live write authorization.
export class CapacityAuthority extends DurableObject{
 #sql;#integrity;
 constructor(ctx,env){
  super(ctx,env);this.#sql=ctx.storage.sql;
  this.#sql.exec(`CREATE TABLE IF NOT EXISTS account (
   singleton INTEGER PRIMARY KEY CHECK(singleton=1),account_id TEXT NOT NULL,baseline_bytes INTEGER NOT NULL CHECK(baseline_bytes>=0),
   committed_bytes INTEGER NOT NULL CHECK(committed_bytes>=0),held_bytes INTEGER NOT NULL CHECK(held_bytes>=0),
   baseline_sha TEXT NOT NULL,scope_sha TEXT NOT NULL,fence_sha TEXT NOT NULL,observed_at INTEGER NOT NULL,completed_at INTEGER NOT NULL,
   CHECK(baseline_bytes+committed_bytes+held_bytes<=10000000000000))`);
  this.#sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
   id TEXT PRIMARY KEY,bucket TEXT NOT NULL,jurisdiction TEXT NOT NULL,object_key TEXT NOT NULL,max_bytes INTEGER NOT NULL CHECK(max_bytes>0),
   sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('RESERVED','STARTED','CANCELLED','COMMITTED')),
   attempt_id TEXT,actual_bytes INTEGER,etag TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
  this.#sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_object ON reservations(jurisdiction,bucket,object_key) WHERE state IN ('RESERVED','STARTED')`);
  this.#sql.exec(`CREATE TABLE IF NOT EXISTS commands(role TEXT NOT NULL,command_id TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(role,command_id))`);
  this.#sql.exec(`CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT NOT NULL,reservation_id TEXT,command_id TEXT NOT NULL,created_at INTEGER NOT NULL)`);
  this.#integrity=this.#balanceConsistent();
 }
 #one(query,...params){const rows=[...this.#sql.exec(query,...params)];if(rows.length>1)fail('INTERNAL_STATE',503);return rows[0];}
 #balanceConsistent(){
  const account=this.#one('SELECT * FROM account WHERE singleton=1'),sum=this.#one(`SELECT COUNT(*) AS count,
   COALESCE(SUM(CASE WHEN state IN ('RESERVED','STARTED') THEN max_bytes ELSE 0 END),0) AS held,
   COALESCE(SUM(CASE WHEN state='COMMITTED' THEN actual_bytes ELSE 0 END),0) AS committed,
   COALESCE(SUM(CASE WHEN
    (state IN ('RESERVED','CANCELLED') AND (attempt_id IS NOT NULL OR actual_bytes IS NOT NULL OR etag IS NOT NULL)) OR
    (state='STARTED' AND (attempt_id IS NULL OR actual_bytes IS NOT NULL OR etag IS NOT NULL)) OR
    (state='COMMITTED' AND (attempt_id IS NULL OR actual_bytes IS NULL OR actual_bytes<=0 OR actual_bytes>max_bytes OR etag IS NULL OR length(etag)=0)) OR
    (attempt_id IS NOT NULL AND (length(attempt_id)>128 OR attempt_id GLOB '*[^a-zA-Z0-9_-]*')) OR
    created_at<0 OR updated_at<created_at
    THEN 1 ELSE 0 END),0) AS invalid FROM reservations`);
  if(!account)return sum.count===0&&this.#one('SELECT COUNT(*) AS count FROM commands').count===0&&this.#one('SELECT COUNT(*) AS count FROM events').count===0;
  return account.account_id===this.env.QUOTA_ACCOUNT_ID&&isNatural(account.baseline_bytes)&&isNatural(account.held_bytes)&&isNatural(account.committed_bytes)&&
   isSha(account.baseline_sha)&&isSha(account.scope_sha)&&isSha(account.fence_sha)&&isNatural(account.observed_at)&&isNatural(account.completed_at)&&
   account.observed_at<=account.completed_at&&account.completed_at-account.observed_at<=MAX_COMMAND_AGE_MS&&account.completed_at<=Date.now()&&
   sum.invalid===0&&account.held_bytes===sum.held&&account.committed_bytes===sum.committed&&account.baseline_bytes+account.held_bytes+account.committed_bytes<=LIMIT_BYTES;
 }
 #account(){const a=this.#one('SELECT * FROM account WHERE singleton=1');if(!a)fail('NOT_INITIALIZED',409);if(a.account_id!==this.env.QUOTA_ACCOUNT_ID)fail('ACCOUNT_MISMATCH',503);return a;}
 #reservation(id){return this.#one('SELECT * FROM reservations WHERE id=?',id);}
 #asReservation(r){return {reservationId:r.id,bucket:r.bucket,jurisdiction:r.jurisdiction,key:r.object_key,maxBytes:r.max_bytes,sha256:r.sha256,state:r.state,
  attemptId:r.attempt_id??null,actualBytes:r.actual_bytes??null,etag:r.etag??null,createdAt:r.created_at,updatedAt:r.updated_at};}
 #event(operation,id,commandId,now){this.#sql.exec('INSERT INTO events(operation,reservation_id,command_id,created_at) VALUES(?,?,?,?)',operation,id??null,commandId,now);}
 #perform(command,now){
  const p=command.payload;
  if(command.operation==='initialize'){
   exactKeys(p,['accountId','baselineBytes','baselineSha256','scopeSha256','fenceSha256','observedAt','completedAt']);
   if(p.accountId!==this.env.QUOTA_ACCOUNT_ID||!isNatural(p.baselineBytes)||p.baselineBytes>LIMIT_BYTES||!isSha(p.baselineSha256)||!isSha(p.scopeSha256)||!isSha(p.fenceSha256)||
      !Number.isSafeInteger(p.observedAt)||!Number.isSafeInteger(p.completedAt)||p.observedAt>p.completedAt||p.completedAt>now||now-p.observedAt>MAX_COMMAND_AGE_MS)fail('INVALID_BASELINE');
   const existing=this.#one('SELECT * FROM account WHERE singleton=1');
   if(existing){if(existing.account_id!==p.accountId||existing.baseline_bytes!==p.baselineBytes||existing.baseline_sha!==p.baselineSha256||existing.scope_sha!==p.scopeSha256||existing.fence_sha!==p.fenceSha256||existing.observed_at!==p.observedAt||existing.completed_at!==p.completedAt)fail('ALREADY_INITIALIZED',409);}
   else{this.#sql.exec('INSERT INTO account VALUES(1,?,?,0,0,?,?,?,?,?)',p.accountId,p.baselineBytes,p.baselineSha256,p.scopeSha256,p.fenceSha256,p.observedAt,p.completedAt);this.#event('initialize',null,command.commandId,now);}
   return {state:'INITIALIZED',mode:'SHADOW',authorizesR2Write:false,coverageVerified:false};
  }
  const account=this.#account();
  if(command.operation==='reserve'){
   exactKeys(p,['reservationId','bucket','jurisdiction','key','maxBytes','sha256']);
   if(!isId(p.reservationId)||!isBucket(p.bucket)||!JURISDICTIONS.includes(p.jurisdiction)||!isKey(p.key)||!isPositive(p.maxBytes)||p.maxBytes>LIMIT_BYTES||!isSha(p.sha256))fail('INVALID_RESERVATION');
   const previous=this.#reservation(p.reservationId);
   if(previous){if(previous.bucket!==p.bucket||previous.jurisdiction!==p.jurisdiction||previous.object_key!==p.key||previous.max_bytes!==p.maxBytes||previous.sha256!==p.sha256)fail('RESERVATION_CONFLICT',409);return {reservation:this.#asReservation(previous),mode:'SHADOW',authorizesR2Write:false};}
   if(this.#one("SELECT id FROM reservations WHERE jurisdiction=? AND bucket=? AND object_key=? AND state IN ('RESERVED','STARTED')",p.jurisdiction,p.bucket,p.key))fail('OBJECT_ALREADY_HELD',409);
   if(account.baseline_bytes+account.committed_bytes+account.held_bytes+p.maxBytes>LIMIT_BYTES)fail('CAPACITY_EXCEEDED',409);
   this.#sql.exec('INSERT INTO reservations VALUES(?,?,?,?,?,?,\'RESERVED\',NULL,NULL,NULL,?,?)',p.reservationId,p.bucket,p.jurisdiction,p.key,p.maxBytes,p.sha256,now,now);
   this.#sql.exec('UPDATE account SET held_bytes=held_bytes+? WHERE singleton=1',p.maxBytes);this.#event('reserve',p.reservationId,command.commandId,now);
   return {reservation:this.#asReservation(this.#reservation(p.reservationId)),mode:'SHADOW',authorizesR2Write:false};
  }
  if(command.operation==='start'){
   exactKeys(p,['reservationId','attemptId']);if(!isId(p.reservationId)||!isId(p.attemptId))fail('INVALID_ATTEMPT');const row=this.#reservation(p.reservationId);if(!row)fail('NOT_FOUND',404);
   if(row.state==='STARTED'){if(row.attempt_id!==p.attemptId)fail('ATTEMPT_CONFLICT',409);return {reservation:this.#asReservation(row),mode:'SHADOW',authorizesR2Write:false};}
   if(row.state!=='RESERVED')fail('NOT_RESERVABLE',409);
   this.#sql.exec("UPDATE reservations SET state='STARTED',attempt_id=?,updated_at=? WHERE id=?",p.attemptId,now,p.reservationId);this.#event('start',p.reservationId,command.commandId,now);
   return {reservation:this.#asReservation(this.#reservation(p.reservationId)),mode:'SHADOW',authorizesR2Write:false};
  }
  if(command.operation==='cancel'){
   exactKeys(p,['reservationId']);if(!isId(p.reservationId))fail('INVALID_RESERVATION');const row=this.#reservation(p.reservationId);if(!row)fail('NOT_FOUND',404);
   if(row.state==='CANCELLED')return {reservation:this.#asReservation(row),mode:'SHADOW',authorizesR2Write:false};
   // An attempted write may still complete after an absent HEAD; never free it.
   if(row.state!=='RESERVED')fail('ATTEMPT_MAY_BE_IN_FLIGHT',409);
   this.#sql.exec("UPDATE reservations SET state='CANCELLED',updated_at=? WHERE id=?",now,p.reservationId);this.#sql.exec('UPDATE account SET held_bytes=held_bytes-? WHERE singleton=1',row.max_bytes);this.#event('cancel',p.reservationId,command.commandId,now);
   return {reservation:this.#asReservation(this.#reservation(p.reservationId)),mode:'SHADOW',authorizesR2Write:false};
  }
  if(command.operation==='commit'){
   exactKeys(p,['reservationId','attemptId','bucket','jurisdiction','key','bytes','sha256','etag','verifiedAt']);
   if(!isId(p.reservationId)||!isId(p.attemptId)||!isBucket(p.bucket)||!JURISDICTIONS.includes(p.jurisdiction)||!isKey(p.key)||!isPositive(p.bytes)||!isSha(p.sha256)||typeof p.etag!=='string'||!p.etag||p.etag.length>256||/[\x00-\x1f\x7f]/.test(p.etag)||!Number.isSafeInteger(p.verifiedAt)||p.verifiedAt>now||now-p.verifiedAt>MAX_COMMAND_AGE_MS)fail('INVALID_READBACK');
   const row=this.#reservation(p.reservationId);if(!row||row.attempt_id!==p.attemptId||row.bucket!==p.bucket||row.jurisdiction!==p.jurisdiction||row.object_key!==p.key||row.sha256!==p.sha256||p.bytes>row.max_bytes)fail('READBACK_MISMATCH',409);
   if(row.state==='COMMITTED'){if(row.actual_bytes!==p.bytes||row.etag!==p.etag)fail('READBACK_CONFLICT',409);return {reservation:this.#asReservation(row),mode:'SHADOW',authorizesR2Write:false};}
   if(row.state!=='STARTED')fail('NOT_STARTED',409);
   this.#sql.exec("UPDATE reservations SET state='COMMITTED',actual_bytes=?,etag=?,updated_at=? WHERE id=?",p.bytes,p.etag,now,p.reservationId);
   this.#sql.exec('UPDATE account SET held_bytes=held_bytes-?,committed_bytes=committed_bytes+? WHERE singleton=1',row.max_bytes,p.bytes);this.#event('commit',p.reservationId,command.commandId,now);
   return {reservation:this.#asReservation(this.#reservation(p.reservationId)),mode:'SHADOW',authorizesR2Write:false};
  }
  if(command.operation==='status'){
   exactKeys(p,[]);return {accountId:account.account_id,limitBytes:LIMIT_BYTES,baselineBytes:account.baseline_bytes,committedBytes:account.committed_bytes,heldBytes:account.held_bytes,
    remainingBytes:LIMIT_BYTES-account.baseline_bytes-account.committed_bytes-account.held_bytes,mode:'SHADOW',authorizesR2Write:false,coverageVerified:false};
  }
  if(command.operation==='get'){
   exactKeys(p,['reservationId']);if(!isId(p.reservationId))fail('INVALID_RESERVATION');const row=this.#reservation(p.reservationId);if(!row)fail('NOT_FOUND',404);
   return {reservation:this.#asReservation(row),mode:'SHADOW',authorizesR2Write:false};
  }
  if(command.operation==='list'){
   exactKeys(p,['state','cursor','limit']);if(!['RESERVED','STARTED','CANCELLED','COMMITTED'].includes(p.state)||typeof p.cursor!=='string'||(p.cursor&&!isId(p.cursor))||!Number.isInteger(p.limit)||p.limit<1||p.limit>100)fail('INVALID_PAGE');
   const rows=[...this.#sql.exec('SELECT * FROM reservations WHERE state=? AND id>? ORDER BY id LIMIT ?',p.state,p.cursor,p.limit+1)],hasMore=rows.length>p.limit,items=rows.slice(0,p.limit).map(r=>this.#asReservation(r));
   return {reservations:items,nextCursor:hasMore?items.at(-1).reservationId:null,mode:'SHADOW',authorizesR2Write:false};
  }
  if(command.operation==='audit'){
   exactKeys(p,[]);if(!this.#balanceConsistent()){this.#integrity=false;fail('INTEGRITY_MISMATCH',503);}
   return {consistent:true,mode:'SHADOW',authorizesR2Write:false,coverageVerified:false};
  }
  fail('UNKNOWN_OPERATION',404);
 }
 async fetch(request){
  if(request.method!=='POST'||new URL(request.url).pathname!=='/quota')return new Response('Not found',{status:404});
  try{
   if(!isAccount(this.env.QUOTA_ACCOUNT_ID)||this.ctx.id.name!==this.env.QUOTA_ACCOUNT_ID||this.ctx.id.jurisdiction!==undefined)fail('INVALID_SINGLETON',503);
   if(!this.#integrity)fail('INTEGRITY_MISMATCH',503);
   const raw=await readBoundedText(request);let command;try{command=JSON.parse(raw);}catch{fail('INVALID_BODY');}
   const digest=await authenticate(command,raw,request.headers.get('X-Quota-Signature'),this.env,Date.now()),now=Date.now();
   if(command.at>now+5000||now-command.at>MAX_COMMAND_AGE_MS)fail('STALE_OR_INVALID_COMMAND',409);
   const readOnly=['status','get','list','audit'].includes(command.operation);
   const result=this.ctx.storage.transactionSync(()=>{
    if(!readOnly){const prev=this.#one('SELECT digest,response FROM commands WHERE role=? AND command_id=?',command.role,command.commandId);
     if(prev){if(prev.digest!==digest)fail('COMMAND_CONFLICT',409);
      if(command.operation!=='initialize'){const row=this.#reservation(command.payload.reservationId);if(!row)fail('INTERNAL_STATE',503);return {reservation:this.#asReservation(row),mode:'SHADOW',authorizesR2Write:false};}
      return JSON.parse(prev.response);}}
    const value=this.#perform(command,now);if(!readOnly)this.#sql.exec('INSERT INTO commands(role,command_id,digest,response) VALUES(?,?,?,?)',command.role,command.commandId,digest,JSON.stringify(value));return value;
   });
   return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){const status=error instanceof ProtocolError?error.status:503,code=error instanceof ProtocolError?error.code:'INTERNAL_ERROR';return Response.json({error:code,mode:'SHADOW',authorizesR2Write:false},{status,headers:{'Cache-Control':'no-store'}});}
 }
}

// Deliberately no public route or service binding is exposed by this shadow.
export default {fetch(){return new Response('Not found',{status:404});}};
