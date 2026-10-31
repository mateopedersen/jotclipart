import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reviewedImportCatalog } from '../scripts/reviewed-imports.mjs';
import { defaults, searchArtwork } from '../src/lib/search.ts';
import { pageSitemap } from '../src/lib/sitemaps.ts';

// The same assertions can check the isolated candidate before it is promoted.
const root = process.env.UC_CORRECTION_CANDIDATE || '.';
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name)));
const art = read('data/art.json');
const reviews = read('data/editorial/reviews.json');
const topics = [
  ...JSON.parse(fs.readFileSync('data/topics.json')).topics,
  ...read('data/extra-topics.json'),
];
const reviewed = reviewedImportCatalog(art, reviews);

test('the 300 movie collection has one canonical topic and a permanent old-address redirect', () => {
  const movie = topics.filter((topic) => topic.slug === '300-movie');
  assert.equal(movie.length, 1);
  assert.equal(movie[0].keyword, '300 Movie clipart');
  assert.equal(topics.some((topic) => topic.slug === '300'), false);
  const items = reviewed.filter((item) => /^300-\d{3}$/.test(item.id));
  assert.equal(items.length, 50);
  assert.ok(items.every((item) => item.topic === '300-movie'));
  assert.equal(new Set(items.map((item) => item.title.toLowerCase())).size, 50);
  const sitemap = pageSitemap(items, topics);
  assert.match(sitemap, /<loc>https:\/\/ultraclipart\.com\/clipart\/300-movie\/<\/loc>/);
  assert.doesNotMatch(sitemap, /<loc>https:\/\/ultraclipart\.com\/clipart\/300\/<\/loc>/);
  const redirects = fs.readFileSync(path.join(root, 'public/_redirects'), 'utf8');
  assert.match(redirects, /^\/clipart\/300 \/clipart\/300-movie\/ 301$/m);
  assert.match(redirects, /^\/clipart\/300\/ \/clipart\/300-movie\/ 301$/m);
});

test('film illustrations remain discoverable by the corrected topic name', () => {
  const movie = reviewed.filter((item) => item.topic === '300-movie');
  const results = searchArtwork(movie, { ...defaults, q: '300 movie', size: 100 });
  assert.equal(results.total, 50);
  assert.ok(results.items.every((item) => item.topic === '300-movie'));
});

test('Xbox repair retains its ID and previous source lineage with newly reviewed formats', () => {
  const item = reviewed.find((row) => row.id === 'xbox-014');
  assert.ok(item);
  assert.equal(item.topic, 'xbox');
  assert.equal(item.revision, 2);
  assert.equal(item.width, 1254);
  assert.equal(item.height, 1254);
  assert.match(item.alt, /Xbox controller/);
  assert.match(item.description, /Xbox controller/);
  assert.equal(item.replacesArtwork.revision, 1);
  assert.notEqual(item.replacesArtwork.webpSha256, item.files.webp.sha256);
  assert.notEqual(item.replacesArtwork.pdfSha256, item.files.pdf.sha256);
  assert.ok(item.alpha && item.pdfPrint.ppi === 300);
});
