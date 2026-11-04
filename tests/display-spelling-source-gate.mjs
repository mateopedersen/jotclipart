// Synthetic transport/source fixtures only. These tests approve no real image.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createReviewedDeltaValidators} from '../scripts/catalog-snapshot/validate-delta-source.mjs';
import {metadataSignature,reviewContextSignature} from '../scripts/artwork-editorial.mjs';
import {incomingManifestSHA256} from '../scripts/catalog-snapshot/incoming-media-plan.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/catalog-delta-source.json',import.meta.url)));
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
function input(phase,label='USB'){
 const f=structuredClone(fixture);f.raw.topic=f.record.topic='usb-flash-drive';f.raw.title=f.record.title=label+' Source Gate Fixture';f.review.copy.title=f.raw.title;
 f.review.inputMetadataSha256=metadataSignature(f.raw);f.review.inputContextSha256=reviewContextSignature(f.raw);
 const row={id:f.raw.id,raw:f.raw,review:f.review,expectedOldPublicSHA256:hash(f.record),monochromeReceipt:{sourceSHA256:f.raw.files.thumb.sha256,monochrome:f.record.monochrome,kind:f.record.monochromeKind,receiptSHA256:'1'.repeat(64)}};
 const options={artworkRows:[row],topicRows:[],incomingMediaManifest:f.media,phase,...(phase==='local-preflight'?{mediaPlanSHA256:incomingManifestSHA256(f.media)}:{mediaReceiptSHA256:'3'.repeat(64)})};
 return {...f,row,options,change:{id:f.raw.id,expectedPublicSHA256:hash(f.record),record:f.record},oldRecord:structuredClone(f.record)};
}
test('reviewed known spelling is checked in both source phases',async()=>{
 for(const phase of ['local-preflight','verified-media']){
  const good=input(phase);assert.equal((await createReviewedDeltaValidators(good.options).validateSourceChange(good)).newPublicSHA256,hash(good.record));
  const bad=input(phase,'Usb');await assert.rejects(()=>createReviewedDeltaValidators(bad.options).validateSourceChange(bad),/reviewed display spelling/);
 }
});
test('changed source bytes and retained stale copy review still fail after a spelling pass',async()=>{
 for(const phase of ['local-preflight','verified-media']){
  const changedSource=input(phase);changedSource.raw.files.webp.sha256='f'.repeat(64);await assert.rejects(()=>createReviewedDeltaValidators(changedSource.options).validateSourceChange(changedSource));
  const stale=input(phase);stale.record.description+=' A new sentence.';await assert.rejects(()=>createReviewedDeltaValidators(stale.options).validateSourceChange(stale));
  const unseen=input(phase);unseen.review.observations=[];await assert.rejects(()=>createReviewedDeltaValidators(unseen.options).validateSourceChange(unseen));
 }
});
test('topic guard runs in both phases and cannot bypass the existing scoped inventory gate',async()=>{
 for(const phase of ['local-preflight','verified-media']){
  const f=input(phase),slug='vr-headset',row={slug,rawItems:[],resolvedItems:[],editorial:{intro:'A Vr fixture.',paragraphs:['A Vr fixture.','Another sentence.']}};
  f.options.artworkRows=[];f.options.topicRows=[row];
  await assert.rejects(()=>createReviewedDeltaValidators(f.options).validateSourceTopic({change:{slug,record:{title:'Vr Headset Clipart'}},oldRecord:null}),/reviewed display spelling/);
  row.editorial={intro:'A VR fixture.',paragraphs:['A VR fixture.','Another sentence.']};
  await assert.rejects(()=>createReviewedDeltaValidators(f.options).validateSourceTopic({change:{slug,record:{title:'VR Headset Clipart'}},oldRecord:null}),/Exact scoped topic inventory/);
 }
});
