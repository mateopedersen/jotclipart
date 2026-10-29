// Resume only the same interrupted operation, never an arbitrary prior dist.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {configuredToken} from '../r2/cloudflare-api.mjs';
import {execFileSync} from 'node:child_process';
export async function verifyReviewedResume(root,file,revision){
 const resolved=path.resolve(root,file);assert(resolved.startsWith(path.join(root,'work')+path.sep));
 const p=JSON.parse(fs.readFileSync(resolved));assert.equal(p.schema,1);assert.equal(p.status,'OWNER_REAPPROVED_SAME_FRESH_BUILD');assert.equal(p.revision,revision);
 const dirty=execFileSync('git',['diff','HEAD','--name-only'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);assert(dirty.every(f=>['scripts/deploy.mjs','docs/content/marvel-completion-backlog.md'].includes(f)),'Content source differs from the reviewed build');
 const unknown=execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);assert(unknown.every(f=>['data/publication-approval.json','scripts/publication-approval.mjs','scripts/delivery/reviewed-resume.mjs'].includes(f)),'Unexpected uncommitted content source');
 const read=f=>JSON.parse(fs.readFileSync(path.resolve(root,f))),state=read(p.state),stop=read(p.stopProof),approval=read('data/publication-approval.json');assert.equal(state.newOwnerApprovalMessage,p.ownerMessageId);assert.equal(stop.status,'ACTIVATION_PARENT_TERMINATED_BEFORE_STAGE_FINISH');assert(approval.batches.some(b=>b.approval?.ownerMessageId===p.ownerMessageId&&b.status==='APPROVED_FOR_EXACT_SOURCE'));
 const log=fs.readFileSync(path.resolve(root,p.gateLog),'utf8');for(const [field,value]of [['tests',671],['pass',671],['fail',0],['skipped',0]])assert.equal(Number(log.match(new RegExp('^ℹ '+field+' (\\d+)$','m'))?.[1]),value);
 for(const f of ['reports/image-seo/audit.json','reports/linking/audit.json','reports/seo-final/audit.json']){const audit=read(f);assert.deepEqual(audit.errors,[]);assert(Date.parse(audit.date)>=Date.parse(state.deployStartedAt));assert(Date.now()-Date.parse(audit.date)<2*3600_000,'Reviewed build is too old for operation resume');}
 assert.deepEqual(read('reports/seo-final/audit.json').duplicateTitleReview,[]);
 const manifest=read('work/delivery/'+revision+'/verified-manifest.json');assert.equal(manifest.status,'remote-byte-verified');assert.equal(manifest.revision,revision);assert.equal(manifest.verified,117880);assert.equal(manifest.files.length,117880);
 const liveProcess=(()=>{try{process.kill(p.finishedStagePid,0);return true}catch{return false}})();assert(!liveProcess,'Existing R2 stage is still running; do not start a parallel writer');
 const lock=path.resolve(process.env.UC_R2_LOCK_ROOT??path.join(process.env.HOME,'Documents/Codex'),'.ultraclipart-r2-writer.lock');assert(!fs.existsSync(lock),'Existing account writer must release itself');
 const response=await fetch('https://api.cloudflare.com/client/v4/accounts/48c779c8eaa80234e0bb9d57f96e588b/pages/projects/ultraclipart',{headers:{Authorization:'Bearer '+configuredToken()},signal:AbortSignal.timeout(30000)}),body=await response.json();assert(response.ok&&body.success);assert.equal(body.result.canonical_deployment.id,p.expectedCanonicalDeployment,'Live baseline changed: merge current production and rebuild');
 const live=await fetch('https://ultraclipart.com/delivery-release.json',{cache:'no-store',signal:AbortSignal.timeout(30000)}),delivery=await live.json();assert.equal(delivery.renderedRevision,p.expectedRenderedRevision);assert.equal(delivery.controlRevision,p.expectedRenderedRevision);assert.equal(delivery.verifiedRoot,p.expectedVerifiedRoot);
 return {status:'SAME_FRESH_REVIEWED_OPERATION_RESUMED',revision,ownerMessageId:p.ownerMessageId,fullTests:671,verifiedDeliveryFiles:manifest.verified};
}
