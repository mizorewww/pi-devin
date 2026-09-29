import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { streamDevin } from "../src/stream.ts";
import { clearCachedUserJwt } from "../src/jwt.ts";
import { encodeMessage, encodeString, encodeTag, encodeVarintField, frameConnectStream } from "../src/wire.ts";

const model = {
  id: "test-model", name: "Test", api: "devin-local", provider: "devin",
  baseUrl: "https://devin.invalid", reasoning: false, input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 1_000_000, maxTokens: 1000,
};

async function run(t, frames) {
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeString(1, "eyJtest.jwt"));
    }
    assert.equal(url, "https://devin.invalid/exa.api_server_pb.ApiServerService/GetChatMessage");
    const chunks = [...frames.map((frame) => frameConnectStream(frame, false)), Buffer.from([2, 0, 0, 0, 2, 123, 125])];
    return new Response(new ReadableStream({
      async pull(controller) {
        await setImmediate();
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      },
    }));
  });
  const stream = streamDevin(model, { messages: [] }, {
    apiKey: "synthetic-test-key", env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
  });
  const events = [];
  for await (const event of stream) events.push(structuredClone(event));
  const result = await stream.result();
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  return { events, result };
}

function usage(metrics) {
  return encodeMessage(28, Buffer.concat(Object.entries(metrics).map(([name, value]) => {
    const float = Buffer.alloc(4);
    float.writeFloatLE(value);
    return encodeMessage(2, Buffer.concat([
      encodeString(5, name), encodeMessage(4, Buffer.concat([encodeTag(2, 5), float])),
    ]));
  })));
}

const metrics = { input_tokens: 461, output_tokens: 262, cached_input_tokens: 228_162, cache_creation_input_tokens: 17 };

test("counts all four usage components and preserves them after an empty frame (#3, #4)", async (t) => {
  const { result } = await run(t, [usage(metrics), usage(Object.fromEntries(Object.keys(metrics).map((key) => [key, 0])))]);
  assert.deepEqual({ ...result.usage, cost: undefined }, {
    input: 461, output: 262, cacheRead: 228_162, cacheWrite: 17, totalTokens: 228_902, cost: undefined,
  });
  assert.equal(result.usage.cost.input, 461 / 1_000_000);
  assert.equal(result.usage.cost.cacheRead, 228_162 * 0.1 / 1_000_000);
});

test("accepts cache-only usage and combines separate component snapshots without double counting", async (t) => {
  const { result } = await run(t, [
    usage({ cached_input_tokens: 58_905 }), usage({ input_tokens: 280, output_tokens: 118 }),
    usage({ input_tokens: 280, output_tokens: 118 }), usage({ cache_creation_input_tokens: 17 }),
  ]);
  assert.equal(result.usage.totalTokens, 59_320);
  assert.equal(result.usage.cacheRead, 58_905);
  assert.equal(result.usage.cacheWrite, 17);
});

test("keeps growing tool arguments across split keys, strings, and Unicode escapes (#2)", async (t) => {
  const fragments = ['{"path":"file.txt","cont', 'ent":"hello ', '\\u26', '3a"}'];
  const frames = fragments.map((part, index) => encodeMessage(6, Buffer.concat([
    ...(index === 0 ? [encodeString(1, "call-1"), encodeString(2, "write")] : []), encodeString(3, part),
  ])));
  frames.push(encodeVarintField(5, 10));
  const { events, result } = await run(t, frames);
  const deltas = events.filter((event) => event.type === "toolcall_delta");
  assert.equal(deltas.length, 4);
  for (const event of deltas) assert.equal(event.partial.content[0].arguments.path, "file.txt");
  assert.equal(deltas[1].partial.content[0].arguments.content, "hello");
  assert.deepEqual(result.content[0].arguments, { path: "file.txt", content: "hello ☺" });
  assert.equal(result.stopReason, "toolUse");
});
