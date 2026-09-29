import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { clearCachedUserJwt } from "../src/jwt.ts";
import { streamDevin } from "../src/stream.ts";
import { encodeMessage } from "../src/wire.ts";

const model = {
  id: "test-model",
  name: "Test model",
  api: "devin-local",
  provider: "devin",
  baseUrl: "https://devin.invalid",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_000,
  maxTokens: 1_000,
};
const user = (content) => ({ role: "user", content, timestamp: 1 });

test("aborting an in-flight stream reports aborted without leaking a rejection", async (t) => {
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  const ac = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    assert.equal(url, "https://devin.invalid/exa.api_server_pb.ApiServerService/GetChatMessage");
    // Mirror undici: an aborted fetch errors the response body with signal.reason.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        const onAbort = () => controller.error(options.signal.reason);
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      },
    });
    return new Response(body);
  });

  const stream = streamDevin(model, normalizeContext({ messages: [user("hello")] }), {
    apiKey: "synthetic-test-key",
    env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
    signal: ac.signal,
  });

  const events = [];
  const consume = (async () => {
    for await (const event of stream) events.push(event);
  })();
  ac.abort();
  await consume;
  // Give any floating rejection a chance to surface.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.reason, "aborted");
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.deepEqual(rejections, []);
});

test("real fetch cancellation after a response chunk leaves the process usable", { timeout: 10_000 }, async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { encodeString, encodeVarintField, frameConnectStream } = await import("../src/wire.ts");
  clearCachedUserJwt(); t.after(clearCachedUserJwt);
  let chats = 0;
  const server = createServer((req, res) => {
    if (req.url.endsWith("/GetUserJwt")) {
      res.end(encodeString(1, "eyJtest.jwt")); return;
    }
    chats++;
    res.writeHead(200, { "Content-Type": "application/connect+proto" });
    res.write(frameConnectStream(encodeString(3, "started"), false));
    if (chats > 1) {
      res.write(frameConnectStream(encodeVarintField(5, 0), false));
      res.end(Buffer.from([2, 0, 0, 0, 2, 123, 125]));
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const ac = new AbortController();
  const options = { apiKey: "synthetic-test-key", env: { DEVIN_API_SERVER_URL: `http://127.0.0.1:${server.address().port}` } };
  const stream = streamDevin(model, normalizeContext({ messages: [user("hello")] }), { ...options, signal: ac.signal });
  let sawText = false;
  for await (const event of stream) {
    if (event.type === "text_delta") { sawText = true; ac.abort(); }
  }
  assert.equal(sawText, true);
  assert.equal((await stream.result()).stopReason, "aborted");
  const next = streamDevin(model, normalizeContext({ messages: [user("again")] }), options);
  for await (const event of next) assert.notEqual(event.type, "error");
  assert.equal((await next.result()).stopReason, "stop");
  assert.equal(chats, 2);
});
