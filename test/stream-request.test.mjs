import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { normalizeContext } from "@earendil-works/pi-ai";
import { clearCachedUserJwt } from "../src/jwt.ts";
import { streamDevin } from "../src/stream.ts";
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
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    assert.equal(url, "https://devin.invalid/exa.api_server_pb.ApiServerService/GetChatMessage");
    const frame = Buffer.from(options.body);
    assert.equal(frame[0], 1, "request uses Connect gzip compression");
    assert.equal(frame.readUInt32BE(1), frame.length - 5);
    requests.push(fields(gunzipSync(frame.subarray(5))));
    const reply = replies[requests.length - 1];
    assert.ok(reply, "unexpected extra chat request");
    return response(reply);
  });
  return requests;
}

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

// #7: verify the normalized transcript survives the complete request-encoding path.
test("encodes the current system prompt once in field 2, with unchanged user text and images", async (t) => {
  const requests = mockDevin(t);
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
  const requests = mockDevin(t);
  await complete(normalizeContext({ systemPrompt: "", tools: [readTool], messages: [user("Read probe.txt")] }));
  assert.equal(requests[0].filter((field) => field.num === 2).length, 0);
  assert.equal(requests[0].filter((field) => field.num === 10).length, 1);
  assert.deepEqual(messages(requests[0]).map((message) => stringField(message, 3)), ["Read probe.txt"]);
});

test("sends a system-only transcript without inventing a user message", async (t) => {
  const requests = mockDevin(t);
  await complete(normalizeContext({ systemPrompt: "System-only instructions.", messages: [] }));
  assert.equal(stringField(requests[0], 2), "System-only instructions.");
  assert.deepEqual(messages(requests[0]), []);
});

test("encodes an empty transcript without a prompt or history", async (t) => {
  const requests = mockDevin(t);
  await complete(normalizeContext({ messages: [] }));
  assert.equal(stringField(requests[0], 2), undefined);
  assert.deepEqual(messages(requests[0]), []);
});

test("retains the system prompt and replays assistant tool calls and results on the next request", async (t) => {
  const callId = "call-read";
  const args = { path: "probe.txt" };
  const requests = mockDevin(t, [
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
  const requests = mockDevin(t, [
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
  assert.deepEqual(first.content.find((part) => part.type === "thinking"), {
    type: "thinking", thinking: summary, thinkingSignature: signature, redacted: true,
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
});

test("preserves tool result images and error status on the wire", async (t) => {
  const requests = mockDevin(t);
  await complete({ messages: [{ role: "toolResult", toolCallId: "image-call", toolName: "read", isError: true, timestamp: 1,
    content: [{ type: "text", text: "partial screenshot" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }] });
  const message = messages(requests[0])[0];
  assert.equal(stringField(message, 7), "image-call");
  assert.equal(message.find((f) => f.num === 9)?.value, 1n);
  assert.equal(stringField(fields(message.find((f) => f.num === 10).value), 1), "aW1hZ2U=");
});

test("uses model output limits and isolates trajectory IDs by Pi session", async (t) => {
  const requests = mockDevin(t, Array(3).fill(encodeString(3, "OK")));
  for (const sessionId of ["one", "one", "two"]) await complete({messages: []}, { sessionId, maxTokens: 5000 });
  for (const request of requests) {
    const config = fields(request.find((f) => f.num === 8).value);
    assert.equal(config.find((f) => f.num === 2).value, 1000n);
    assert.equal(config.find((f) => f.num === 3).value, 400n);
    assert.equal(request.some((f) => f.num === 22), false);
  }
  const trajectory = (r) => stringField(fields(r.find((f) => f.num === 15).value), 1);
  assert.equal(trajectory(requests[0]), trajectory(requests[1]));
  assert.notEqual(trajectory(requests[0]), trajectory(requests[2]));
});

test("does not replay signatures from another provider or model", async (t) => {
  const requests = mockDevin(t);
  await complete({ messages: [
    {role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "other", content: [{type: "thinking", thinking: "foreign", thinkingSignature: "foreign-signature"}], timestamp: 1},
    {role: "assistant", api: "devin-local", provider: "devin", model: "other", content: [{type: "thinking", thinking: "other model", thinkingSignature: "sealed.v1.other"}], timestamp: 2},
  ]});
  for (const message of messages(requests[0])) assert.equal(message.some((f) => f.num === 12), false);
});

test("replays a signature-only redacted thinking block", async (t) => {
  const requests = mockDevin(t, [Buffer.concat([encodeString(10, "sealed.v1.empty"), encodeVarintField(11, 1)]), encodeString(3, "OK")]);
  const context = { messages: [] };
  const first = await complete(context);
  assert.equal(first.content[0].thinking, "");
  context.messages.push(first);
  await complete(context);
  const assistant = messages(requests[1])[0];
  assert.equal(stringField(assistant, 12), "sealed.v1.empty");
  assert.equal(assistant.find((f) => f.num === 13).value, 1n);
});
