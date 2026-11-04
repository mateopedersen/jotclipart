import test from 'node:test';
import assert from 'node:assert/strict';
import {assertKnownTopicDisplaySpelling as check} from '../scripts/catalog-snapshot/display-spelling-guard.mjs';

test('known spelling mistakes fail in every changed public field', () => {
  for (const [topic, bad] of [['jpmorgan-chase','JPMorganChase'],['usb-flash-drive','Usb'],['vr-headset','Vr'],['100th-day-of-school','100Th']]) {
    for (const field of ['title','alt','description','keyword','summary','metaDescription','intro','paragraphs']) {
      const value = `An illustrated ${bad} subject.`;
      assert.throws(() => check(topic, {[field]: field === 'paragraphs' ? [value] : value}), /reviewed display spelling/);
    }
  }
});
test('correct reviewed spellings pass without requiring keyword padding', () => {
  for (const [topic, good] of [['jpmorgan-chase','JPMorgan Chase'],['usb-flash-drive','USB'],['vr-headset','VR'],['100th-day-of-school','100th']]) {
    const fields = {title:`${good} illustration`,alt:'A silver object beside a blue case.',description:'A person holds the object at the counter.',paragraphs:[`Visible details in this ${good} illustration.`, 'The inventory has varied arrangements.']};
    const before = structuredClone(fields);check(topic, fields);assert.deepEqual(fields,before);
  }
});
test('policy uses explicit topic, never an artwork ID, and preserves valid literal names', () => {
  const names = 'SpaceX ExxonMobil AbbVie ChatGPT OpenAI iPhone MacBook WhatsApp WhiteBIT';
  for (const topic of ['spacex','exxonmobil','abbvie','chatgpt','openai','usb-flash-drive']) {
    const fields = {id:'jpmorgan-chase-Usb-Vr-100Th',title:names,alt:'An illustrated USB device.',sourcePath:'/originals/Usb/Vr/100Th.webp',canonical:'https://ultraclipart.com/clipart/usb-flash-drive/'};
    const before=structuredClone(fields);check(topic,fields);assert.deepEqual(fields,before);
  }
  assert.throws(() => check('jpmorgan-chase',{id:'visa-001',description:'A JPMorganChase badge rests on the desk.'}),/reviewed display spelling/);
  assert.doesNotThrow(() => check('unrelated-fictional-topic',{id:'jpmorgan-chase-001',title:'An Unrelated CamelCase Name'}));
});
test('public quoted lettering has no unreviewed spelling exception; addresses remain exact', () => {
  assert.throws(() => check('jpmorgan-chase',{description:'The illustrated badge reads “JPMorganChase”.'}),/reviewed display spelling/);
  const fields={description:'A USB drive. https://ultraclipart.com/clipart/usb-flash-drive/',id:'Usb',sourcePath:'/Usb/original.webp'};
  const before=structuredClone(fields);check('usb-flash-drive',fields);assert.deepEqual(fields,before);
});
test('the check does not invent a subject, a model or a visual approval', () => {
  const fields={title:'Generic device arrangement',description:'A small illustrated object rests beside a plain box.'};
  const before=structuredClone(fields);assert.equal(check('usb-flash-drive',fields),undefined);assert.deepEqual(fields,before);
});
