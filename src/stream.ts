import { randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { mapContextToChat, type ChatHistoryItem, type ContentPart, type ToolDef } from "./context-map.js";
import { getCachedUserJwt } from "./jwt.js";
import { buildMetadata } from "./metadata.js";
import { resolveModelUid } from "./models.js";
import { packThinkingSignature, type ChatThinking } from "./thinking.js";
import {
  encodeFixed64Field,
  encodeMessage,
  encodeString,
  encodeVarintField,
  frameConnectStream,
  iterFields,
} from "./wire.js";

const SOURCE_BY_ROLE: Record<string, number> = {
  user: 1,
  assistant: 2,
  tool: 4,
};

export type CloudChatEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "reasoning_signature"; signature: string; signatureType?: string }
  | { kind: "reasoning_redacted" }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; argsDelta: string; id?: string }
  | { kind: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" }
  | {
      kind: "usage";
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
    };

function normalizeContent(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

function encodeImageData(img: { mimeType?: string; base64Data?: string }): Buffer {
  return Buffer.concat([
    encodeString(1, img.base64Data ?? ""),
    encodeString(2, img.mimeType ?? "image/png"),
  ]);
}

function encodeChatToolCall(tc: { id: string; name: string; arguments: string }): Buffer {
  return Buffer.concat([encodeString(1, tc.id), encodeString(2, tc.name), encodeString(3, tc.arguments)]);
}

function encodeChatMessagePrompt(
  content: ContentPart[],
  source: number,
  opts?: {
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    thinking?: ChatThinking;
  },
): Buffer {
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const parts: Buffer[] = [
    encodeVarintField(2, source),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1),
  ];
  if (opts?.toolCallId) parts.push(encodeString(7, opts.toolCallId));
  for (const tc of opts?.toolCalls ?? []) parts.push(encodeMessage(6, encodeChatToolCall(tc)));
  for (const img of content.filter((part) => part.type === "image")) {
    parts.push(encodeMessage(10, encodeImageData(img)));
  }
  // 11 thinking / 12 signature / 13 thinking_redacted / 18 signature_type — the
  // same quartet the Devin CLI replays so the model keeps its own reasoning.
  if (opts?.thinking) {
    parts.push(encodeString(11, opts.thinking.text));
    parts.push(encodeString(12, opts.thinking.signature));
    if (opts.thinking.redacted) parts.push(encodeVarintField(13, 1));
    if (opts.thinking.signatureType) parts.push(encodeString(18, opts.thinking.signatureType));
  }
  return Buffer.concat(parts);
}

/** Mirrors the Devin CLI: num_completions / max_tokens / max_newlines plus
 * temperature / top_k / top_p, and nothing else. */
function encodeCompletionConfiguration(maxOutputTokens?: number): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, maxOutputTokens ?? 128_000),
    encodeVarintField(3, 400),
    encodeFixed64Field(5, 1.0),
    encodeVarintField(7, 40),
    encodeFixed64Field(8, 0.95),
  ]);
}

/** CortexTrajectoryReference: cascade trajectory, user-input step. */
function encodeTrajectoryReference(trajectoryId: string): Buffer {
  return Buffer.concat([
    encodeString(1, trajectoryId),
    encodeVarintField(3, 4),
    encodeVarintField(4, 14),
  ]);
}

function encodeToolDef(tool: ToolDef): Buffer {
  const description = tool.description.length > 6_998 ? `${tool.description.slice(0, 6_995)}...` : tool.description;
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, description),
    encodeString(3, JSON.stringify(tool.parameters ?? {})),
  ]);
}

function buildGetChatMessageRequest(args: {
  apiKey: string;
  userJwt: string;
  modelUid: string;
  systemPrompt?: string;
  messages: ChatHistoryItem[];
  tools?: ToolDef[];
  cascadeId: string;
  trajectoryId: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  maxOutputTokens?: number;
}): Buffer {
  const metadata = buildMetadata({
    apiKey: args.apiKey,
    userJwt: args.userJwt,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId,
  });
  const prompts = args.messages.map((message) =>
    encodeMessage(
      3,
      encodeChatMessagePrompt(normalizeContent(message.content), SOURCE_BY_ROLE[message.role] ?? 1, {
        toolCallId: message.role === "tool" ? message.tool_call_id : undefined,
        toolCalls: message.role === "assistant" ? message.tool_calls : undefined,
        thinking: message.role === "assistant" ? message.thinking : undefined,
      }),
    ),
  );
  return Buffer.concat([
    encodeMessage(1, metadata),
    // 2 prompt — the server's system slot, same place the Devin CLI puts its own
    // system prompt. Collapsing it into the first user turn is not equivalent.
    ...(args.systemPrompt ? [encodeString(2, args.systemPrompt)] : []),
    ...prompts,
    encodeVarintField(7, 5),
    encodeMessage(8, encodeCompletionConfiguration(args.maxOutputTokens)),
    ...(args.tools ?? []).map((tool) => encodeMessage(10, encodeToolDef(tool))),
    encodeMessage(15, encodeTrajectoryReference(args.trajectoryId)),
    encodeString(16, args.cascadeId),
    encodeVarintField(20, 1),
    encodeString(21, args.modelUid),
  ]);
}

function* decodeChatFrame(proto: Buffer): Generator<CloudChatEvent> {
  let signature: string | undefined;
  let signatureType: string | undefined;
  for (const field of iterFields(proto)) {
    if (field.num === 3 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) yield { kind: "text", text };
    } else if (field.num === 9 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) yield { kind: "reasoning", text };
    } else if (field.num === 11 && field.wire === 0) {
      // GetChatMessageResponse.thinking_redacted
      if (Number(field.value) !== 0) yield { kind: "reasoning_redacted" };
    } else if (field.num === 10 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) signature = text;
    } else if (field.num === 21 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) signatureType = text;
    } else if (field.num === 6 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      let id: string | undefined;
      let name: string | undefined;
      let argsDelta: string | undefined;
      for (const inner of iterFields(field.value)) {
        if (inner.wire === 2 && Buffer.isBuffer(inner.value)) {
          const text = inner.value.toString("utf8");
          if (inner.num === 1) id = text;
          else if (inner.num === 2) name = text;
          else if (inner.num === 3) argsDelta = text;
        }
      }
      if (id !== undefined && name !== undefined) yield { kind: "tool_call_start", id, name };
      if (argsDelta !== undefined) yield { kind: "tool_call_args", argsDelta, ...(id ? { id } : {}) };
    } else if (field.num === 5 && field.wire === 0) {
      const value = Number(field.value);
      let reason: Extract<CloudChatEvent, { kind: "finish" }>['reason'] = "stop";
      if (value === 10) reason = "tool_calls";
      else if (value === 11) reason = "content_filter";
      else if (value === 1 || value === 3) reason = "length";
      yield { kind: "finish", reason };
    } else if (field.num === 28 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const usage = decodeUsage(field.value);
      if (usage) yield usage;
    }
  }
  // The signature trails the thinking text, so it is yielded once the frame is
  // fully read and gets attached to the block that is already closed.
  if (signature) yield { kind: "reasoning_signature", signature, signatureType };
}

function decodeUsage(buf: Buffer): CloudChatEvent | null {
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  for (const field of iterFields(buf)) {
    if (field.num !== 2 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    let metric: string | undefined;
    let value: number | undefined;
    for (const inner of iterFields(field.value)) {
      if (inner.num === 5 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
        metric = inner.value.toString("utf8");
      } else if (inner.num === 4 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
        for (const dim of iterFields(inner.value)) {
          if (dim.num === 2 && dim.wire === 5 && Buffer.isBuffer(dim.value)) {
            value = dim.value.readFloatLE(0);
          }
        }
      }
    }
    if (!metric || value === undefined || !Number.isFinite(value)) continue;
    const n = Math.round(value);
    if (metric === "input_tokens") promptTokens = n;
    else if (metric === "output_tokens") completionTokens = n;
    else if (metric.includes("cached") || metric.includes("cache_read")) cachedInputTokens = n;
    else if (metric.includes("cache_creation")) cacheCreationInputTokens = n;
  }
  if (promptTokens === undefined && completionTokens === undefined) return null;
  return {
    kind: "usage",
    promptTokens,
    completionTokens,
    totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
    cachedInputTokens,
    cacheCreationInputTokens,
  };
}

const sessionCache = new Map<string, { sessionId: string; cascadeId: string; trajectoryId: string }>();

function sessionIds(apiKey: string, host: string) {
  const key = `${host}\x1f${apiKey}`;
  let ids = sessionCache.get(key);
  if (!ids) {
    ids = { sessionId: randomUUID(), cascadeId: randomUUID(), trajectoryId: randomUUID() };
    sessionCache.set(key, ids);
  }
  return ids;
}

async function* streamChatEvents(args: {
  apiKey: string;
  host: string;
  modelUid: string;
  systemPrompt?: string;
  messages: ChatHistoryItem[];
  tools?: ToolDef[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<CloudChatEvent> {
  const host = args.host.replace(/\/$/, "");
  const userJwt = await getCachedUserJwt(args.apiKey, host, args.signal);
  const ids = sessionIds(args.apiKey, host);
  const proto = buildGetChatMessageRequest({
    apiKey: args.apiKey,
    userJwt,
    modelUid: args.modelUid,
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    tools: args.tools,
    cascadeId: ids.cascadeId,
    trajectoryId: ids.trajectoryId,
    sessionId: ids.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: randomUUID(),
    maxOutputTokens: args.maxOutputTokens,
  });

  const resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "gzip",
      "Connect-Accept-Encoding": "gzip",
    },
    body: new Uint8Array(frameConnectStream(proto, true)),
    signal: args.signal,
  });
  if (!resp.ok) {
    throw new Error(`GetChatMessage HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  if (!resp.body) throw new Error("GetChatMessage returned an empty body");

  const reader = resp.body.getReader();
  // reader.closed rejects with the stream's storedError when the socket dies
  // mid-response; nothing awaits it -> unhandledRejection crashes the process.
  void reader.closed.catch(() => {});
  const queue: Buffer[] = [];
  let queued = 0;
  let sawEos = false;
  let trailerError: string | null = null;

  const peek = (n: number): Buffer | null => {
    if (queued < n) return null;
    if (queue.length === 1 && queue[0].length >= n) return queue[0].subarray(0, n);
    const parts: Buffer[] = [];
    let remaining = n;
    for (const chunk of queue) {
      if (remaining <= 0) break;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, remaining));
        remaining = 0;
      }
    }
    return Buffer.concat(parts, n);
  };

  const drop = (n: number): void => {
    queued -= n;
    let remaining = n;
    while (remaining > 0 && queue.length > 0) {
      const head = queue[0];
      if (head.length <= remaining) {
        queue.shift();
        remaining -= head.length;
      } else {
        queue[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        queue.push(Buffer.from(value));
        queued += value.length;
      }
      while (queued >= 5) {
        const header = peek(5);
        if (!header) break;
        const flags = header[0];
        const len = header.readUInt32BE(1);
        if (queued < 5 + len) break;
        drop(5);
        const raw = peek(len) ?? Buffer.alloc(0);
        drop(len);
        let payload = raw;
        if (flags & 0x01) payload = zlib.gunzipSync(raw);
        if (flags & 0x02) {
          sawEos = true;
          const text = payload.toString("utf8");
          if (text.includes('"error"')) {
            try {
              const parsed = JSON.parse(text) as { error?: { message?: string } };
              trailerError = parsed.error?.message ?? text;
            } catch {
              trailerError = text;
            }
          }
          continue;
        }
        yield* decodeChatFrame(payload);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    try {
      // await: on an errored stream cancel() returns a rejected promise;
      // `void`-ing it escapes the try/catch as an unhandled rejection.
      await resp.body?.cancel();
    } catch {
      // ignore
    }
  }

  if (trailerError) throw new Error(trailerError);
  if (!sawEos) throw new Error("Devin stream ended without an EOS trailer");
}

export function streamDevin(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let textOpen = false;
    let thinkingOpen = false;
    let thinkingIndex = -1;
    let toolIndex = -1;
    let partialJson = "";
    let toolId = "";
    let toolName = "";

    const closeText = () => {
      if (!textOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "text") {
        stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
      }
      textOpen = false;
    };
    const closeThinking = () => {
      if (!thinkingOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "thinking") {
        stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
      }
      thinkingOpen = false;
    };
    const closeTool = () => {
      if (toolIndex < 0) return;
      const block = output.content[toolIndex];
      if (block.type === "toolCall") {
        try {
          block.arguments = JSON.parse(partialJson);
        } catch {
          // keep last parsed object
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: toolIndex,
          toolCall: { type: "toolCall", id: toolId, name: toolName, arguments: block.arguments },
          partial: output,
        });
      }
      toolIndex = -1;
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) throw new Error("No Devin credentials. Run /login devin (uses the local Devin CLI).");
      const host = (options?.env?.DEVIN_API_SERVER_URL || "https://server.codeium.com").replace(/\/$/, "");
      const modelUid = resolveModelUid(model.id, model.thinkingLevelMap, options?.reasoning);
      const mapped = mapContextToChat(context);
      stream.push({ type: "start", partial: output });

      for await (const event of streamChatEvents({
        apiKey,
        host,
        modelUid,
        systemPrompt: mapped.systemPrompt,
        messages: mapped.messages,
        tools: mapped.tools.length > 0 ? mapped.tools : undefined,
        maxOutputTokens: options?.maxTokens,
        signal: options?.signal,
      })) {
        if (event.kind === "text") {
          closeThinking();
          if (!textOpen) {
            output.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
            textOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "text") {
            block.text += event.text;
            stream.push({ type: "text_delta", contentIndex: idx, delta: event.text, partial: output });
          }
        } else if (event.kind === "reasoning") {
          closeText();
          if (!thinkingOpen) {
            output.content.push({ type: "thinking", thinking: "" });
            thinkingIndex = output.content.length - 1;
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
            thinkingOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "thinking") {
            block.thinking += event.text;
            stream.push({ type: "thinking_delta", contentIndex: idx, delta: event.text, partial: output });
          }
        } else if (event.kind === "reasoning_signature") {
          const block = thinkingIndex >= 0 ? output.content[thinkingIndex] : undefined;
          if (block?.type === "thinking") {
            block.thinkingSignature = packThinkingSignature(event.signature, event.signatureType);
          }
        } else if (event.kind === "reasoning_redacted") {
          const block = thinkingIndex >= 0 ? output.content[thinkingIndex] : undefined;
          if (block?.type === "thinking") block.redacted = true;
        } else if (event.kind === "tool_call_start") {
          closeText();
          closeThinking();
          closeTool();
          toolId = event.id;
          toolName = event.name;
          partialJson = "";
          output.content.push({ type: "toolCall", id: event.id, name: event.name, arguments: {} });
          toolIndex = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
        } else if (event.kind === "tool_call_args") {
          if (toolIndex < 0) continue;
          partialJson += event.argsDelta;
          const block = output.content[toolIndex];
          if (block.type === "toolCall") {
            try {
              block.arguments = JSON.parse(partialJson);
            } catch {
              // incomplete json
            }
          }
          stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: event.argsDelta, partial: output });
        } else if (event.kind === "finish") {
          closeText();
          closeThinking();
          closeTool();
          output.stopReason =
            event.reason === "tool_calls" ? "toolUse" : event.reason === "length" ? "length" : "stop";
        } else if (event.kind === "usage") {
          output.usage.input = event.promptTokens ?? 0;
          output.usage.output = event.completionTokens ?? 0;
          output.usage.cacheRead = event.cachedInputTokens ?? 0;
          output.usage.cacheWrite = event.cacheCreationInputTokens ?? 0;
          output.usage.totalTokens = event.totalTokens ?? output.usage.input + output.usage.output;
          calculateCost(model, output.usage);
        }
      }

      closeText();
      closeThinking();
      closeTool();
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
      stream.end();
    }
  })();

  return stream;
}
