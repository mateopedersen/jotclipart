import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySocialImages } from '../verify-social-images.mjs';

// Bounded isolated tamper fixtures; no real source, font, PNG or user data write.
const original = process.cwd(),
  dir = mkdtempSync(join(original, '.astro/social-verifier-'));
const json = (path) => JSON.parse(readFileSync(join(original, path)));
const files = [
  'scripts/build-social-images.mjs',
  'scripts/social/render.mjs',
  'scripts/social/compositions.mjs',
  'scripts/social/pages.mjs',
  'scripts/social/sources.mjs',
  'data/social-source-artworks.json',
];
const manifest = json('data/social-images.json'),
  proof = json('data/social-image-provenance.json'),
  sources = json('data/social-source-artworks.json');
const copy = (path) => {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(original, path), target);
};
const writeJSON = (path, value) => writeFileSync(join(dir, path), JSON.stringify(value));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const results = [];
try {
  for (const path of [
    ...files,
    'data/social-images.json',
    'data/social-image-provenance.json',
    'config/catalog-snapshot-public.json',
  ])
    copy(path);
  const used = new Set(Object.values(proof.pages).flatMap((p) => p.sources.map((s) => s.path)));
  for (const path of used) if (!path.startsWith('public/catalog/')) copy(path);
  for (const image of Object.values(manifest.pages)) copy('public' + image.src);
  for (const weight of [400, 600, 700])
    copy(`node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff`);
  const IDs = new Set(sources.items.map((s) => s.id));
  const records = json('data/art.json').filter((a) => IDs.has(a.id));
  for (const item of sources.items)
    if (item.catalogRecord && !records.some((a) => a.id === item.id))
      records.push(item.catalogRecord);
  writeJSON('data/art.json', records);
  globalThis.fetch = () => {
    throw Error('Artifact verification must be offline');
  };
  assert.equal(verifySocialImages({ root: dir }).status, 'passed');
  results.push('clean bounded source subset, originals absent, offline PASS');
  const path = 'public' + Object.values(manifest.pages)[0].src,
    bytes = readFileSync(join(dir, path)),
    changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  writeFileSync(join(dir, path), changed);
  assert.throws(() => verifySocialImages({ root: dir }), /PNG bytes changed/);
  writeFileSync(join(dir, path), bytes);
  results.push('changed PNG byte rejected');
  const font = 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff',
    fontBytes = readFileSync(join(dir, font)),
    fontChanged = Buffer.from(fontBytes);
  fontChanged[16] ^= 1;
  writeFileSync(join(dir, font), fontChanged);
  assert.throws(() => verifySocialImages({ root: dir }), /font changed/);
  writeFileSync(join(dir, font), fontBytes);
  results.push('changed font byte rejected');
  const bad = structuredClone(sources),
    signature = bad.productionSnapshot.authorization.signature;
  bad.productionSnapshot.authorization.signature =
    (signature.startsWith('0') ? '1' : '0') + signature.slice(1);
  bad.signedCatalogRoot = sha(JSON.stringify(canonical(bad.productionSnapshot)));
  writeJSON('data/social-source-artworks.json', bad);
  const forged = structuredClone(proof),
    rendererSha = sha(Buffer.concat(files.map((p) => readFileSync(join(dir, p)))));
  for (const page of Object.values(forged.pages)) page.rendererSha = rendererSha;
  writeJSON('data/social-image-provenance.json', forged);
  assert.throws(() => verifySocialImages({ root: dir }), /Invalid signed social source snapshot/);
  results.push(
    'forged signature rejected even after recomputing root and artifact renderer hashes',
  );
  console.log(
    JSON.stringify({
      status: 'PASS_ISOLATED_SOCIAL_GUARD_CHECKS',
      checks: results.length,
      results,
      fixtureScope: 'selected cover-source catalog subset; not a full-catalog audit',
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
