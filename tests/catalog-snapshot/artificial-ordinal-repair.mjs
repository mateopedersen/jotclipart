import test from 'node:test';
import assert from 'node:assert/strict';
import {artificialOrdinalRoute} from '../../scripts/catalog-snapshot/build-url-repair.mjs';
test('source package counters before and after the scene are removable',()=>{
 assert.deepEqual(artificialOrdinalRoute({id:'andorra-flag-clipart-001-flat-sewn-national-flag',oldSlug:'andorra-flag-clipart-001-flat-sewn-national-flag',topic:'andorra-flag',title:'Andorra Flat Sewn National Flag'}),{ordinal:'001',ordinalKind:'package-ordinal-before-scene'});
 assert.deepEqual(artificialOrdinalRoute({id:'election-day-autumn-vote-wreath-cartoon-086',oldSlug:'election-day-autumn-vote-wreath-cartoon-086',topic:'election-day',title:'Election Day Autumn Vote Wreath'}),{ordinal:'086',ordinalKind:'package-ordinal-after-scene'});
});
test('meaningful product, drawing and year numbers and previously migrated URLs stay stable',()=>{
 for(const [id,topic,title]of [['airbus-a380','airbus','Airbus A380'],['tesla-model-3','tesla','Tesla Model 3'],['number-100','number','Number 100'],['calendar-painted-2025','calendar','Calendar Painted 2025'],['number-clipart-001-red','number','Red Number 1']]) assert.equal(artificialOrdinalRoute({id,oldSlug:id,topic,title}),null);
 assert.equal(artificialOrdinalRoute({id:'election-day-old-086',oldSlug:'election-day-autumn-vote-wreath',topic:'election-day',title:'Election Day Autumn Vote Wreath'}),null);
});
test('internal file versions and typography sequence numbers do not become public identity',()=>{
 for(const [id,topic,title,ordinal,ordinalKind] of [
  ['smart-doorbell-router-connection-kit-v2','smart-doorbell','Doorbell With Router and Chime','2','source-file-version-suffix'],
  ['smart-doorbell-rear-terminal-detail-v3','smart-doorbell','Back of Doorbell With Wire Connectors','3','source-file-version-suffix'],
  ['cyber-monday-typography-10-gift-card-envelope-headline','cyber-monday','Cyber Monday Email Envelope','10','package-ordinal-before-scene'],
 ]) assert.deepEqual(artificialOrdinalRoute({id,oldSlug:id,topic,title}),{ordinal,ordinalKind});
 assert.equal(artificialOrdinalRoute({id:'aircraft-v2',oldSlug:'aircraft-v2',topic:'aircraft',title:'Aircraft V2 Concept'}),null);
});
