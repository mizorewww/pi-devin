import assert from 'node:assert/strict';
import test from 'node:test';
import { modelsFromCatalog, resolveModelUid } from '../src/models.ts';
const family = (variants) => ({ families: [{ family_label: 'Test', family_uid: 'test', slug: 'test.family', variants }] });

test('parses current CLI prices without inventing cache rates', () => {
  const [m] = modelsFromCatalog(family([{ model_uid: 'test-high', label: 'Test High', cost_summary: '$10 / 1M Input · $0.25 / 1M Cached input · $50 / 1M Output' }]));
  assert.deepEqual(m.cost, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 0 });
  const [old] = modelsFromCatalog(family([{ model_uid: 'test', label: 'Test', cost_summary: '$2/MTok In, $8/MTok Out' }]));
  assert.deepEqual(old.cost, { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
});

test('keeps the family ID and resolves a single non-thinking variant', () => {
  const [m] = modelsFromCatalog(family([{ model_uid: 'MODEL_PRIVATE_11', label: 'Test' }]));
  assert.equal(m.id, 'test.family'); assert.equal(m.reasoning, false);
  assert.equal(resolveModelUid(m.id, m.thinkingLevelMap), 'MODEL_PRIVATE_11');
  assert.equal(m.thinkingLevelMap.high, null);
});

test('maps uppercase IDs and private IDs using CLI effort labels', () => {
  const [m] = modelsFromCatalog(family([
    { model_uid: 'MODEL_GEMINI_MINIMAL', label: 'Test Minimal' },
    { model_uid: 'MODEL_PRIVATE_13', label: 'Test Low Thinking' },
    { model_uid: 'MODEL_PRIVATE_12', label: 'Test No Thinking' },
    { model_uid: 'MODEL_PRIVATE_15', label: 'Test High Thinking' },
  ]));
  assert.equal(m.thinkingLevelMap.minimal, 'MODEL_GEMINI_MINIMAL');
  assert.equal(m.thinkingLevelMap.low, 'MODEL_PRIVATE_13');
  assert.equal(m.thinkingLevelMap.off, 'MODEL_PRIVATE_12');
  assert.equal(m.thinkingLevelMap.high, 'MODEL_PRIVATE_15');
  assert.equal(m.thinkingLevelMap.medium, null);
});

test('uses the CLI label for the unsuffixed SWE max variant and excludes premium variants', () => {
  const [m] = modelsFromCatalog(family([
    { model_uid: 'swe-1-7', label: 'SWE-1.7 Max' },
    { model_uid: 'swe-1-7-medium', label: 'SWE-1.7 Medium' },
    { model_uid: 'swe-1-7-high-fast', label: 'SWE-1.7 High Fast' },
  ]));
  assert.equal(m.thinkingLevelMap.max, 'swe-1-7');
  assert.equal(m.thinkingLevelMap.high, null);
});

test('does not advertise a hardcoded cloud catalog when offline or empty', () => {
  assert.deepEqual(modelsFromCatalog(null), []);
  assert.deepEqual(modelsFromCatalog({families: []}), []);
});
