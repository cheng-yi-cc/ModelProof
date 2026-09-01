import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, resolveClaimed, percentileBelow } from '../src/core/analyze.js';

// Synthetic mini reference DB: model A is sharply biased to "7", model B to "3".
function makeCell(p, n = 30) {
  return { n, p };
}
const refDb = {
  models: {
    'vendor/model-a': {
      family: 'a',
      cells: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`t${i}|en`, makeCell({ 7: 0.9, 3: 0.1 })])
      ),
    },
    'vendor/model-b': {
      family: 'b',
      cells: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`t${i}|en`, makeCell({ 3: 0.9, 7: 0.1 })])
      ),
    },
  },
};
const context = { distances: [0.1, 0.2, 0.3, 0.4, 0.5] };

// Probe behaves exactly like A (finite-sample noise at n=12/cell keeps JSD small).
const probeA = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`t${i}|en`, { n: 12, p: { 7: 0.917, 3: 0.083 } }])
);
// Probe behaves like B.
const probeB = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`t${i}|en`, { n: 12, p: { 3: 0.917, 7: 0.083 } }])
);

test('probe matching claimed A -> match', () => {
  const out = analyze({ fingerprint: probeA, refDb, context, claimedModel: 'vendor/model-a' });
  assert.equal(out.verdict.level, 'match');
  assert.ok(out.distanceToClaimed < 0.05);
});

test('probe A but claimed B -> mismatch with A ranked first', () => {
  const out = analyze({ fingerprint: probeA, refDb, context, claimedModel: 'vendor/model-b' });
  assert.equal(out.verdict.level, 'mismatch');
  assert.equal(out.top[0].model, 'vendor/model-a');
  assert.ok(out.distanceToClaimed > 0.35);
});

test('substitution suspicion fires when top candidate is tight', () => {
  const out = analyze({ fingerprint: probeB, refDb, context, claimedModel: 'vendor/model-a' });
  assert.equal(out.verdict.label, '高概率注水');
  assert.equal(out.top[0].model, 'vendor/model-b');
});

test('unknown claim -> no-reference verdict but ranking still present', () => {
  const out = analyze({ fingerprint: probeA, refDb, context, claimedModel: 'vendor/ghost' });
  assert.equal(out.verdict.level, 'no-reference');
  assert.equal(out.top[0].model, 'vendor/model-a');
});

test('insufficient data flagged', () => {
  const thin = { 't0|en': { n: 3, p: { 7: 1 } } };
  const out = analyze({ fingerprint: thin, refDb, context, claimedModel: 'vendor/model-a' });
  assert.equal(out.verdict.level, 'insufficient-data');
});

test('resolveClaimed alias rules', () => {
  const ids = [
    'openai/gpt-4o-mini',
    'openai/gpt-4o-mini-2024-07-18',
    'z-ai/glm-4.5-air',
    'deepseek/deepseek-chat',
  ];
  assert.deepEqual(resolveClaimed('openai/gpt-4o-mini', ids), { id: 'openai/gpt-4o-mini', how: 'exact' });
  assert.equal(resolveClaimed('gpt-4o-mini', ids).id, 'openai/gpt-4o-mini');
  assert.equal(resolveClaimed('GPT-4o-Mini ', ids).id, 'openai/gpt-4o-mini');
  assert.equal(resolveClaimed('glm-4.5-air', ids).id, 'z-ai/glm-4.5-air');
  // relay-style :free suffix stripped
  assert.equal(resolveClaimed('deepseek-chat:free', ids).id, 'deepseek/deepseek-chat');
  // ambiguous prefix (undated preferred over dated)
  assert.equal(resolveClaimed('gpt-4o-mini-2024-07-18', ids).id, 'openai/gpt-4o-mini-2024-07-18');
  assert.equal(resolveClaimed('totally-unknown-model', ids).id, null);
});

test('percentileBelow binary search', () => {
  assert.equal(percentileBelow([0.1, 0.2, 0.3, 0.4, 0.5], 0.25), 0.4);
  assert.equal(percentileBelow([0.1, 0.2], 0.05), 0);
  assert.equal(percentileBelow([], 0.5), null);
});
