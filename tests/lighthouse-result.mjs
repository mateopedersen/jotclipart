import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUsableLighthouse,
  hasUsableSummary,
} from '../scripts/performance/lighthouse-result.mjs';

const valid = () => ({
  categories: { performance: { score: 0.98 } },
  audits: {
    'first-contentful-paint': { numericValue: 1200 },
    'largest-contentful-paint': { numericValue: 2100 },
  },
});

test('accepts a complete Lighthouse paint measurement', () => {
  assert.doesNotThrow(() => assertUsableLighthouse(valid()));
});

test('rejects a failed paint audit even when Lighthouse has no runtime error', () => {
  const result = valid();
  result.audits['first-contentful-paint'] = {
    scoreDisplayMode: 'error',
    errorMessage: 'NO_FCP',
  };
  assert.throws(() => assertUsableLighthouse(result), /NO_FCP/);
});

test('rejects a missing paint metric or performance score', () => {
  const missingPaint = valid();
  delete missingPaint.audits['largest-contentful-paint'];
  assert.throws(() => assertUsableLighthouse(missingPaint), /metric unavailable/);
  const missingScore = valid();
  missingScore.categories.performance.score = null;
  assert.throws(() => assertUsableLighthouse(missingScore), /score unavailable/);
});

test('does not resume an old summary with missing paint metrics as a completed run', () => {
  const row = {
    scores: { performance: 0 },
    metrics: { 'first-contentful-paint': 1200 },
  };
  assert.equal(hasUsableSummary(row), false);
  row.metrics['largest-contentful-paint'] = 2100;
  assert.equal(hasUsableSummary(row), true);
  row.error = 'NO_FCP';
  assert.equal(hasUsableSummary(row), false);
});
