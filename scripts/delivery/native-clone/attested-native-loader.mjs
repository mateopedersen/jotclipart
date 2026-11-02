/** Pinned macOS/arm64 native loader. No writable or network fallback. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url)),expected={
 'clonefile.c':'1fbfdde415ff8ea4d0ab1f158bf055240d6ede9c04aa67d5b14a20ae712a6283',
 'clonefile.node':'627ccf8c494b1dcae9914321dfd65c5fabb380dd985ce3ac36f8a775407a2b04',
 'node-api-headers/node_api.h':'2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a',
 'node-api-headers/node_api_types.h':'a25356630d3058f0a0c8937d9f297e9471e037fda58c2696d8a505c2bd99cb00',
 'node-api-headers/js_native_api.h':'8808ef8899a1691411928ef5dd7dae0537aedc93d3a34e223b2d89692e79c788',
 'node-api-headers/js_native_api_types.h':'4f19cb90d240765cc0961d92a1ee20f65fdc50db7de1ab0a5cb6bc227224e1a0',
 'node-api-headers/LICENSE':'ec62dc96da0099b87f4511736c87309335527fb7031639493e06c95728dc8c54',
};
const statKey=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
function verifyOpened(file,expectedSha,load){assert.equal(fs.realpathSync(file),file,'Native input path traverses a symlink');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd,{bigint:true});assert(before.isFile());const hash=createHash('sha256').update(fs.readFileSync(fd)).digest('hex');assert.equal(hash,expectedSha,`Native attestation mismatch: ${path.basename(file)}`);assert.equal(statKey(fs.fstatSync(fd,{bigint:true})),statKey(before));const current=fs.lstatSync(file,{bigint:true});assert.equal(statKey(current),statKey(before));if(!load)return;const module={exports:{}};process.dlopen(module,`/dev/fd/${fd}`);assert.equal(statKey(fs.fstatSync(fd,{bigint:true})),statKey(before));return module.exports;}finally{fs.closeSync(fd);}}
export function loadPinnedNative(){assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');assert(Number(process.versions.napi)>=8,'Node-API 8 is required');for(const [file,hash]of Object.entries(expected))if(file!=='clonefile.node')verifyOpened(path.join(dir,file),hash,false);const module=verifyOpened(path.join(dir,'clonefile.node'),expected['clonefile.node'],true);assert.equal(typeof module.cloneFd,'function');assert.equal(typeof module.createTargetFd,'function');assert.equal(typeof module.freeBytesFd,'function');assert.equal(typeof module.replaceFd,'function');return module;}
