import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeMessage, encodeString, encodeVarintField } from '../src/wire.ts';
import { parseClientModelConfigs } from '../src/model-configs.ts';

// ClientModelConfig: model_uid = field 22, supports_images = field 5 (absent = false).
const clientModelConfig = (uid, supportsImages) =>
  Buffer.concat([encodeString(22, uid), ...(supportsImages ? [encodeVarintField(5, 1)] : [])]);

test('parses supports_images from GetCliModelConfigs responses', () => {
  const proto = Buffer.concat([
    encodeMessage(1, clientModelConfig('swe-2-high', true)),
    encodeMessage(1, clientModelConfig('glm-5-2', false)),
    encodeMessage(1, clientModelConfig('deepseek-v4-1-flash-high', true)),
  ]);
  const caps = parseClientModelConfigs(proto);
  assert.equal(caps.size, 3);
  assert.equal(caps.get('swe-2-high').supportsImages, true);
  assert.equal(caps.get('glm-5-2').supportsImages, false);
  assert.equal(caps.get('deepseek-v4-1-flash-high').supportsImages, true);
  assert.equal(caps.has('other-model'), false);
});

test('skips entries without a model_uid and ignores unrelated top-level fields', () => {
  const proto = Buffer.concat([
    encodeVarintField(3, 1),
    encodeMessage(4, encodeString(1, 'unrelated')),
    encodeMessage(1, encodeVarintField(5, 1)),
    encodeMessage(1, clientModelConfig('swe-2-max', true)),
  ]);
  const caps = parseClientModelConfigs(proto);
  assert.equal(caps.size, 1);
  assert.equal(caps.get('swe-2-max').supportsImages, true);
});

test('returns an empty map for an empty or malformed-free response', () => {
  assert.equal(parseClientModelConfigs(Buffer.alloc(0)).size, 0);
});
