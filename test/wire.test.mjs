import assert from 'node:assert/strict';
import test from 'node:test';
import { iterFields, decodeVarint } from '../src/wire.ts';

test('rejects truncated protobuf fields rather than silently succeeding', () => {
  for (const bytes of [[10,5,65], [9,1], [13,1], [0,0]]) assert.throws(() => [...iterFields(Buffer.from(bytes))]);
  assert.throws(() => decodeVarint(Buffer.alloc(11, 0x80), 0), /oversized/);
});
