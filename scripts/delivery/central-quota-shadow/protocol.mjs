// Private shadow implementation. No function in this module grants R2 access.
export const LIMIT_BYTES=10_000_000_000_000;
export const MAX_REQUEST_BYTES=16_384;
export const MAX_COMMAND_AGE_MS=45_000;
export const ROLE_KEYS=Object.freeze({auditor:'QUOTA_AUDITOR_KEY',writer:'QUOTA_WRITER_KEY',verifier:'QUOTA_VERIFIER_KEY',viewer:'QUOTA_VIEWER_KEY'});
export const ROLES=Object.freeze({initialize:'auditor',reserve:'writer',start:'writer',cancel:'writer',commit:'verifier',status:'viewer',get:'viewer',list:'viewer',audit:'viewer'});
const encoder=new TextEncoder();
export class ProtocolError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
export const fail=(code,status=400)=>{throw new ProtocolError(code,status);};
export const isSha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const isAccount=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
export const isId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x)&&!['__proto__','constructor','prototype'].includes(x);
export const isBucket=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(x);
export const isKey=x=>typeof x==='string'&&x.length>0&&!x.includes('\0')&&x.normalize('NFC')===x&&
 !Array.from(x).some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff)&&encoder.encode(x).length<=1024;
export const isNatural=x=>Number.isSafeInteger(x)&&x>=0;
export const isPositive=x=>Number.isSafeInteger(x)&&x>0;
export const JURISDICTIONS=Object.freeze(['default','eu','us','fedramp','fedramp-high']);
export function exactKeys(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail('INVALID_FIELDS');
}
function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isSafeInteger(value))return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object'){
  const keys=Object.keys(value).sort();if(keys.some(k=>['__proto__','constructor','prototype'].includes(k)))fail('INVALID_FIELDS');
  return `{${keys.map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
 }
 fail('INVALID_VALUE');
}
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const unhex=text=>Uint8Array.from(text.match(/../g),x=>parseInt(x,16));
export async function semanticDigest(command){return hex(await crypto.subtle.digest('SHA-256',encoder.encode(canonical({role:command.role,operation:command.operation,payload:command.payload}))));}
export async function authenticate(command,raw,signature,env,now=Date.now()){
 exactKeys(command,['role','commandId','at','operation','payload']);
 if(!isId(command.commandId)||!Number.isSafeInteger(command.at)||command.at>now+5000||now-command.at>MAX_COMMAND_AGE_MS)fail('STALE_OR_INVALID_COMMAND',409);
 if(typeof command.operation!=='string'||ROLES[command.operation]!==command.role)fail('UNAUTHORIZED',403);
 const keys=Object.values(ROLE_KEYS).map(name=>env[name]);
 if(keys.some(k=>!isSha(k))||new Set(keys).size!==keys.length)fail('INVALID_SECRET_CONFIGURATION',503);
 if(!isSha(signature))fail('UNAUTHORIZED',403);
 const key=await crypto.subtle.importKey('raw',unhex(env[ROLE_KEYS[command.role]]),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const valid=await crypto.subtle.verify('HMAC',key,unhex(signature),encoder.encode(`UC-R2-CAPACITY-SHADOW-V1\n${raw}`));
 if(!valid)fail('UNAUTHORIZED',403);
 return semanticDigest(command);
}
export async function readBoundedText(request){
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_REQUEST_BYTES))fail('REQUEST_TOO_LARGE',413);
 if(!request.body)fail('INVALID_BODY');const reader=request.body.getReader(),parts=[];let size=0;
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>MAX_REQUEST_BYTES){await reader.cancel();fail('REQUEST_TOO_LARGE',413);}parts.push(item.value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('INVALID_BODY');}
}
