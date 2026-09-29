import assert from 'node:assert/strict';
import test from 'node:test';
import { clearCachedUserJwt, getCachedUserJwt } from '../src/jwt.ts';
import { encodeString } from '../src/wire.ts';

test('concurrent JWT callers can cancel independently while sharing a mint', async (t) => {
  clearCachedUserJwt(); t.after(clearCachedUserJwt);
  let release, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    calls++;
    await new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return new Response(encodeString(1, 'eyJtest.jwt'));
  });
  const first = new AbortController(), second = new AbortController();
  const a = getCachedUserJwt('test-key', 'https://devin.invalid', first.signal);
  const b = getCachedUserJwt('test-key', 'https://devin.invalid', second.signal);
  first.abort();
  await assert.rejects(a, { name: 'AbortError' });
  release(); assert.equal(await b, 'eyJtest.jwt'); assert.equal(calls, 1);
  second.abort();
  await assert.rejects(getCachedUserJwt('test-key', 'https://devin.invalid', second.signal), { name: 'AbortError' });
});
