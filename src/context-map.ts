import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  withoutInitialSystemMessage,
  type Message,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { unpackThinkingSignature, type ChatThinking } from "./thinking.js";

/**
 * The variant uid that generated each Devin assistant message, remembered by
 * object identity for the lifetime of the process. The wire replays it as
 * ChatMessagePrompt field 22 (`generation_model`); the CLI keeps it in its
 * session store the same way. Across restarts the uid packed into
 * `thinkingSignature` covers thinking messages; other restored messages fall
 * back to omitting the field.
 */
const generationModelUidByMessage = new WeakMap<Message, string>();

export function rememberGenerationModel(message: Message, modelUid: string): void {
  generationModelUidByMessage.set(message, modelUid);
}

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  data?: string;
}

export interface ChatHistoryItem {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_result_is_error?: boolean;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  /** Prior reasoning, replayed so the server can verify and continue it. */
  thinking?: ChatThinking;
  /** Model variant that generated this assistant message (history field 22). */
  generation_model?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface MappedChat {
  /** Sent in GetChatMessageRequest.prompt, separately from conversation history. */
  systemPrompt?: string;
  messages: ChatHistoryItem[];
  tools: ToolDef[];
}

function userContent(content: Message["content"]): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    if (part.type === "image") {
      parts.push({ type: "image", mimeType: part.mimeType, data: part.data });
    }
  }
  return parts;
}

export function mapContextToChat(context: TranscriptContext): MappedChat {
  // Fold later system updates into the single prompt sent separately to Devin.
  const transcript = collapseSystemMessages(context);
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  const messages: ChatHistoryItem[] = [];
  for (const message of withoutInitialSystemMessage(transcript.messages)) {
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let thinking: ChatThinking | undefined;
      let generationModel: string | undefined = generationModelUidByMessage.get(message);
      // Devin thinking replays verbatim on the wire: the summary rides field 11
      // and signature/type attach only when the server minted them (models like
      // swe-2-flash return unsigned reasoning that still replays on that slot).
      // The Devin CLI does not filter by generation model — a signed or unsigned
      // trace replays even when the current family differs — so neither do we.
      const devin = message.provider === "devin" && message.api === "devin-local";
      const thinkingIndexes = devin
        ? message.content.map((part, index) => (part.type === "thinking" ? index : -1)).filter((index) => index >= 0)
        : [];
      const lastThinkingIndex = thinkingIndexes.at(-1) ?? -1;
      // The slot carries one thinking per message. When the newest block is
      // signed its signature seals that block alone, so earlier fragments fall
      // back to inlined text; when it is unsigned the fragments merge the same
      // way the CLI merges a message's thinking into a single unsigned slot.
      const lastPart = lastThinkingIndex >= 0 ? message.content[lastThinkingIndex] : undefined;
      const signedLast = lastPart?.type === "thinking"
        ? Boolean(unpackThinkingSignature(lastPart.thinkingSignature).signature)
        : false;
      const anyRedacted = message.content.some((part) => part.type === "thinking" && part.redacted);
      const unsignedFragments: string[] = [];
      message.content.forEach((part, index) => {
        if (part.type === "text") texts.push(part.text);
        if (part.type === "toolCall") {
          toolCalls.push({
            id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {}),
          });
        }
        if (part.type === "thinking") {
          if (!devin) {
            // A foreign provider's reasoning cannot ride Devin's thinking slot;
            // keep it visible to the model as ordinary transcript text instead.
            if (part.thinking) texts.push(`<thinking>\n${part.thinking}\n</thinking>`);
            return;
          }
          const decoded = unpackThinkingSignature(part.thinkingSignature);
          generationModel ??= decoded.modelUid;
          if (index === lastThinkingIndex) {
            thinking = signedLast
              ? { text: part.thinking, signature: decoded.signature, signatureType: decoded.signatureType, redacted: part.redacted }
              : {
                  text: [...unsignedFragments, part.thinking].filter(Boolean).join("\n"),
                  redacted: anyRedacted || undefined,
                };
          } else if (signedLast) {
            if (part.thinking) texts.push(`<thinking>\n${part.thinking}\n</thinking>`);
          } else {
            unsignedFragments.push(part.thinking);
          }
        }
      });
      messages.push({
        role: "assistant",
        content: texts.join("\n"),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        thinking,
        generation_model: generationModel,
      });
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        content: userContent(message.content),
        tool_call_id: message.toolCallId,
        tool_result_is_error: message.isError,
      });
    }
  }

  const tools: ToolDef[] = getCurrentTools(transcript.messages).map((tool: Tool) => ({
    name: tool.name,
    description: tool.description.length > 6_998 ? `${tool.description.slice(0, 6_995)}...` : tool.description,
    parameters: tool.parameters,
  }));

  return { systemPrompt: systemPrompt || undefined, messages, tools };
}
