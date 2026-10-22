import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamDevin } from "../src/stream.ts";
import { unpackThinkingSignature } from "../src/thinking.ts";
import { encodeMessage, encodeString, encodeVarintField, frameConnectStream, iterFields } from "../src/wire.ts";

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
const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const user = (content) => ({ role: "user", content, timestamp: 1 });
const fields = (buffer) => [...iterFields(buffer)];
const messages = (request) => request.filter((field) => field.num === 3).map((field) => fields(field.value));
const stringField = (fields, number) => fields.find((field) => field.num === number)?.value.toString("utf8");

function response(body) {
  // Connect's end-of-stream frame contains the JSON trailer {}.
  return new Response(Buffer.concat([frameConnectStream(body, false), Buffer.from([2, 0, 0, 0, 2, 123, 125])]));
}

function mockDevin(t, replies = [Buffer.concat([encodeString(3, "OK"), encodeVarintField(5, 0)])]) {
  const requests = [];
  const headers = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://devin.invalid/exa.api_server_pb.ApiServerService/GetChatMessage");
    const frame = Buffer.from(options.body);
    assert.equal(frame.readUInt32BE(1), frame.length - 5);
    // Large Connect frames arrive gzipped; small ones are sent uncompressed.
    const payload = frame[0] & 1 ? gunzipSync(frame.subarray(5)) : frame.subarray(5);
    requests.push(fields(payload));
    headers.push(options.headers);
    const reply = replies[requests.length - 1];
    assert.ok(reply, "unexpected extra chat request");
    return response(reply);
  });
  return { requests, headers };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z]+-[a-z]+$/;

async function complete(context, options = {}) {
  const stream = streamDevin(model, context, {
    apiKey: "synthetic-test-key",
    env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
    ...options,
  });
  for await (const event of stream) {
    assert.notEqual(event.type, "error", event.error?.errorMessage);
  }
  return stream.result();
}

test("observes the encoded prompt, tools and images before adding transport credentials", async (t) => {
  const { requests } = mockDevin(t);
  const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
  const context = normalizeContext({
    systemPrompt: "Observe this prompt.",
    tools: [{ ...readTool, description: "d".repeat(7_000) }],
    messages: [user([{ type: "text", text: "Inspect this image." }, image])],
  });
  const before = structuredClone(context);
  let observed;
  await complete(context, {
    onPayload: (payload, selectedModel) => {
      assert.equal(selectedModel, model);
      assert.equal(requests.length, 0);
      observed = structuredClone(payload);
    },
  });
  assert.ok(observed, "provider must call Pi's payload hook");
  assert.deepEqual(Object.keys(observed).sort(), ["maxOutputTokens", "messages", "modelUid", "system", "tools"]);
  assert.equal(observed.system, stringField(requests[0], 2));
  assert.equal(observed.tools[0].description, stringField(fields(requests[0].find((field) => field.num === 10).value), 2));
  assert.equal(observed.tools[0].description.length, 6_998);
  assert.deepEqual(observed.messages[0].content[1], image);
  assert.equal(observed.messages[0].content[1].data, stringField(fields(messages(requests[0])[0].find((field) => field.num === 10).value), 1));
  assert.equal(observed.modelUid, stringField(requests[0], 21));
  assert.equal(observed.maxOutputTokens, model.maxTokens);
  assert.deepEqual(context, before, "mapping and inspection must not rewrite the transcript");
});

test("awaits an asynchronous payload replacement and encodes it as the request", async (t) => {
  const { requests } = mockDevin(t);
  await complete(normalizeContext({ systemPrompt: "Original", tools: [readTool], messages: [user("Original user")] }), {
    onPayload: async (payload) => ({
      ...payload,
      system: "Replaced system",
      messages: [{ role: "user", content: "Replaced user" }],
      tools: [{ ...readTool, name: "inspect", description: "Replaced tool" }],
      modelUid: "replacement-model",
      maxOutputTokens: 77,
    }),
  });
  assert.equal(requests.length, 1);
  assert.equal(stringField(requests[0], 2), "Replaced system");
  assert.deepEqual(messages(requests[0]).map((message) => stringField(message, 3)), ["Replaced user"]);
  assert.equal(stringField(fields(requests[0].find((field) => field.num === 10).value), 1), "inspect");
  assert.equal(stringField(requests[0], 21), "replacement-model");
  assert.equal(fields(requests[0].find((field) => field.num === 8).value).find((field) => field.num === 2).value, 77n);
});

test("preserves in-place payload edits when the hook returns undefined", async (t) => {
  const { requests } = mockDevin(t);
  await complete(normalizeContext({ messages: [user("Original")] }), {
    onPayload: async (payload) => {
      await Promise.resolve();
      payload.messages[0].content = "Edited in place";
    },
  });
  assert.equal(stringField(messages(requests[0])[0], 3), "Edited in place");
});

for (const mode of ["throw", "abort"]) {
  test(`a payload hook ${mode} prevents authentication and chat requests`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
    const controller = new AbortController();
    const stream = streamDevin(model, normalizeContext({ messages: [user("Hello")] }), {
      apiKey: "synthetic-test-key",
      signal: controller.signal,
      onPayload: async () => {
        if (mode === "throw") throw new Error("Payload hook failed");
        controller.abort();
      },
    });
    const result = await stream.result();
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(result.stopReason, mode === "throw" ? "error" : "aborted");
    if (mode === "throw") assert.match(result.errorMessage, /Payload hook failed/);
  });
}

// #7: verify the normalized transcript survives the complete request-encoding path.
test("encodes the current system prompt once in field 2, with unchanged user text and images", async (t) => {
  const { requests } = mockDevin(t);
  const text = "  Inspect this: <system>literal user text</system>\nこんにちは  ";
  const image = { type: "image", mimeType: "image/png", data: "aW1hZ2UtZml4dHVyZQ==" };
  const context = normalizeContext({
    systemPrompt: "Initial instructions.",
    tools: [readTool],
    messages: [user([{ type: "text", text }, image])],
  });
  const tools = Array.from({ length: 90 }, (_, i) => ({ ...readTool, name: `read_${i}` }));
  context.messages.push({
    role: "system",
    content: "Updated instructions.",
    sections: { policy: "Do not edit." },
    toolsRemoved: [{ name: "read" }],
    toolsAdded: tools,
    timestamp: 2,
  });
  await complete(context);
  assert.equal(requests.length, 1);
  const request = requests[0];
  const promptFields = request.filter((field) => field.num === 2);
  assert.equal(promptFields.length, 1);
  assert.equal(promptFields[0].wire, 2);
  assert.equal(promptFields[0].value.toString(), "Initial instructions.\n\nUpdated instructions.\n\nDo not edit.");
  const history = messages(request);
  assert.equal(history.length, 1);
  assert.equal(history[0].find((field) => field.num === 2).value, 1n);
  assert.equal(stringField(history[0], 3), text);
  const images = history[0].filter((field) => field.num === 10);
  assert.equal(images.length, 1);
  assert.equal(stringField(fields(images[0].value), 1), image.data);
  assert.equal(stringField(fields(images[0].value), 2), image.mimeType);
  assert.deepEqual(request.filter((field) => field.num === 10).map((field) => {
    const definition = fields(field.value);
    return { name: stringField(definition, 1), description: stringField(definition, 2), parameters: JSON.parse(stringField(definition, 3)) };
  }), tools);
});

test("omits an empty system prompt while preserving tools and user content", async (t) => {
  const { requests } = mockDevin(t);
  await complete(normalizeContext({ systemPrompt: "", tools: [readTool], messages: [user("Read probe.txt")] }));
  assert.equal(requests[0].filter((field) => field.num === 2).length, 0);
  assert.equal(requests[0].filter((field) => field.num === 10).length, 1);
  assert.deepEqual(messages(requests[0]).map((message) => stringField(message, 3)), ["Read probe.txt"]);
});

test("sends a system-only transcript without inventing a user message", async (t) => {
  const { requests } = mockDevin(t);
  await complete(normalizeContext({ systemPrompt: "System-only instructions.", messages: [] }));
  assert.equal(stringField(requests[0], 2), "System-only instructions.");
  assert.deepEqual(messages(requests[0]), []);
});

test("encodes an empty transcript without a prompt or history", async (t) => {
  const { requests } = mockDevin(t);
  await complete(normalizeContext({ messages: [] }));
  assert.equal(stringField(requests[0], 2), undefined);
  assert.deepEqual(messages(requests[0]), []);
});

test("retains the system prompt and replays assistant tool calls and results on the next request", async (t) => {
  const callId = "call-read";
  const args = { path: "probe.txt" };
  const { requests } = mockDevin(t, [
    Buffer.concat([
      encodeMessage(6, Buffer.concat([encodeString(1, callId), encodeString(2, "read"), encodeString(3, JSON.stringify(args))])),
      encodeVarintField(5, 10),
    ]),
    Buffer.concat([encodeString(3, "file-value"), encodeVarintField(5, 0)]),
  ]);
  const context = normalizeContext({ systemPrompt: "Use tools; never guess.", tools: [readTool], messages: [user("Read probe.txt")] });
  const first = await complete(context);
  assert.equal(first.stopReason, "toolUse");
  assert.deepEqual(first.content, [{ type: "toolCall", id: callId, name: "read", arguments: args }]);
  context.messages.push(first, {
    role: "toolResult", toolCallId: callId, toolName: "read",
    content: [{ type: "text", text: "file-value" }], isError: false, timestamp: 3,
  });
  const second = await complete(context);
  assert.equal(second.stopReason, "stop");
  assert.equal(second.content[0].text, "file-value");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.filter((field) => field.num === 2).length, 1);
    assert.equal(stringField(request, 2), "Use tools; never guess.");
  }
  const history = messages(requests[1]);
  assert.deepEqual(history.map((message) => message.find((field) => field.num === 2).value), [1n, 2n, 4n]);
  assert.equal(stringField(history[0], 3), "Read probe.txt");
  const call = fields(history[1].find((field) => field.num === 6).value);
  assert.equal(stringField(call, 1), callId);
  assert.equal(stringField(call, 2), "read");
  assert.deepEqual(JSON.parse(stringField(call, 3)), args);
  assert.equal(stringField(history[2], 7), callId);
  assert.equal(stringField(history[2], 3), "file-value");
});

// The fork's signed reasoning must survive the upstream transcript migration.
test("replays signed thinking after a system update on the next turn", async (t) => {
  const summary = "A prior reasoning summary.";
  const signature = "sealed.v1.synthetic-test-signature";
  const { requests } = mockDevin(t, [
    Buffer.concat([
      encodeString(9, summary),
      encodeString(10, signature),
      encodeString(21, "sealed"),
      encodeVarintField(11, 1),
      encodeString(3, "First answer"),
      encodeVarintField(5, 0),
    ]),
    Buffer.concat([encodeString(3, "Second answer"), encodeVarintField(5, 0)]),
  ]);
  const context = normalizeContext({ systemPrompt: "Initial instructions.", messages: [user("First turn")] });
  const first = await complete(context);
  const thinking = first.content.find((part) => part.type === "thinking");
  assert.equal(thinking.thinking, summary);
  assert.equal(thinking.redacted, true);
  // The signature carries the generating variant so replays can name it later.
  assert.deepEqual(unpackThinkingSignature(thinking.thinkingSignature), {
    signature, signatureType: "sealed", modelUid: "test-model",
  });
  context.messages.push(first,
    { role: "system", content: "Updated instructions.", timestamp: 2 },
    user("Second turn"));
  await complete(context);
  assert.equal(stringField(requests[1], 2), "Initial instructions.\n\nUpdated instructions.");
  const assistant = messages(requests[1]).find((message) => message.find((field) => field.num === 2)?.value === 2n);
  assert.ok(assistant);
  assert.equal(stringField(assistant, 11), summary);
  assert.equal(stringField(assistant, 12), signature);
  assert.equal(assistant.find((field) => field.num === 13)?.value, 1n);
  assert.equal(stringField(assistant, 18), "sealed");
  // Replays name the variant that produced the message (generation_model).
  assert.equal(stringField(assistant, 22), "test-model");
});

test("preserves tool result images and error status on the wire", async (t) => {
  const { requests } = mockDevin(t);
  await complete({ messages: [{ role: "toolResult", toolCallId: "image-call", toolName: "read", isError: true, timestamp: 1,
    content: [{ type: "text", text: "partial screenshot" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }] });
  const message = messages(requests[0])[0];
  assert.equal(stringField(message, 7), "image-call");
  assert.equal(message.find((f) => f.num === 9)?.value, 1n);
  assert.equal(stringField(fields(message.find((f) => f.num === 10).value), 1), "aW1hZ2U=");
});

test("uses model output limits and isolates trajectory IDs by Pi session", async (t) => {
  const { requests } = mockDevin(t, Array(3).fill(encodeString(3, "OK")));
  for (const sessionId of ["one", "one", "two"]) await complete({messages: []}, { sessionId, maxTokens: 5000 });
  for (const request of requests) {
    const config = fields(request.find((f) => f.num === 8).value);
    assert.equal(config.find((f) => f.num === 2).value, 1000n);
    assert.equal(config.find((f) => f.num === 3).value, 400n);
    // 22 is execution_id — a fresh uuid per call, sent on agent turns.
    assert.match(stringField(request, 22), UUID);
  }
  const trajectory = (r) => stringField(fields(r.find((f) => f.num === 15).value), 1);
  assert.equal(trajectory(requests[0]), trajectory(requests[1]));
  assert.notEqual(trajectory(requests[0]), trajectory(requests[2]));
  // Field 28 is the session's petname slug: stable within a Pi session,
  // different across sessions.
  const slug = (r) => stringField(r, 28);
  assert.match(slug(requests[0]), SLUG);
  assert.equal(slug(requests[0]), slug(requests[1]));
  assert.notEqual(slug(requests[0]), slug(requests[2]));
});

test("matches the Devin CLI wire shape (headers, metadata, messages)", async (t) => {
  const { requests, headers } = mockDevin(t, [
    Buffer.concat([encodeString(10, "sealed.v1.sig"), encodeVarintField(5, 0)]),
    encodeString(3, "OK"),
  ]);
  const context = normalizeContext({ systemPrompt: "Prompt.", messages: [user("hi")] });
  const first = await complete(context);
  context.messages.push(first, user("again"));
  await complete(context);

  // Headers mirror the CLI: basic auth with the session token doubled, no JWT.
  for (const header of headers) {
    assert.equal(header.Authorization ?? header.authorization, "Basic synthetic-test-key-synthetic-test-key");
    assert.equal(header["Connect-Protocol-Version"], "1");
    assert.equal(header["Accept-Encoding"], "gzip");
    assert.match(header["Sentry-Trace"] ?? header["sentry-trace"], /^[0-9a-f]{32}-[0-9a-f]{16}-0$/);
  }

  for (const request of requests) {
    const metadata = fields(request.find((f) => f.num === 1).value);
    assert.equal(stringField(metadata, 1), "devin-cli");
    assert.equal(stringField(metadata, 12), "chisel");
    assert.equal(stringField(metadata, 28), "chisel");
    // No user_jwt, request/session/trigger ids — the CLI omits them all.
    for (const num of [9, 10, 16, 21, 25]) assert.equal(metadata.some((f) => f.num === num), false, `metadata.${num}`);
    // Field 31: 366 random bytes rendered as 732 hex chars, fresh per request.
    assert.match(stringField(metadata, 31), /^[0-9a-f]{732}$/);
  }
  const fp = (r) => stringField(fields(r.find((f) => f.num === 1).value), 31);
  assert.notEqual(fp(requests[0]), fp(requests[1]));

  const all = requests.flatMap((r) => messages(r));
  for (const message of all) {
    assert.match(stringField(message, 1), UUID); // message_id on every prompt
    assert.equal(message.some((f) => f.num === 4), false); // no num_tokens
    assert.equal(message.some((f) => f.num === 5), false); // no safe_for_code_telemetry
  }
  // The ephemeral cache breakpoint sits on the newest input message only.
  const second = messages(requests[1]);
  assert.equal(second[second.length - 1].some((f) => f.num === 8), true);
  for (const message of second.slice(0, -1)) assert.equal(message.some((f) => f.num === 8), false);
});

test("does not replay signatures from another provider or model", async (t) => {
  const { requests } = mockDevin(t);
  await complete({ messages: [
    {role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "other", content: [{type: "thinking", thinking: "foreign", thinkingSignature: "foreign-signature"}], timestamp: 1},
    {role: "assistant", api: "devin-local", provider: "devin", model: "other", content: [{type: "thinking", thinking: "other model", thinkingSignature: "sealed.v1.other"}], timestamp: 2},
  ]});
  for (const message of messages(requests[0])) assert.equal(message.some((f) => f.num === 12), false);
});

test("replays a signature-only redacted thinking block", async (t) => {
  const { requests } = mockDevin(t, [Buffer.concat([encodeString(10, "sealed.v1.empty"), encodeVarintField(11, 1)]), encodeString(3, "OK")]);
  const context = { messages: [] };
  const first = await complete(context);
  assert.equal(first.content[0].thinking, "");
  context.messages.push(first);
  await complete(context);
  const assistant = messages(requests[1])[0];
  assert.equal(stringField(assistant, 12), "sealed.v1.empty");
  assert.equal(assistant.find((f) => f.num === 13).value, 1n);
});
