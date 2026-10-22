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

export function mapContextToChat(context: TranscriptContext, modelId?: string): MappedChat {
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
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        if (part.type === "toolCall") {
          toolCalls.push({
            id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {}),
          });
        }
        if (part.type === "thinking") {
          const decoded = unpackThinkingSignature(part.thinkingSignature);
          // One thinking slot per message on the wire, and an unsigned trace is
          // not replayable — keep the newest block that the server can verify.
          if (decoded.signature && message.provider === "devin" && message.api === "devin-local"
            && (!modelId || message.model === modelId)) {
            thinking = {
              text: part.thinking,
              signature: decoded.signature,
              signatureType: decoded.signatureType,
              redacted: part.redacted,
            };
            generationModel ??= decoded.modelUid;
          } else if (part.thinking) {
            // Not replayable in the signed slot — a foreign provider's plain
            // reasoning, an unsigned trace, or a different Devin family.
            // Silently dropping it loses whatever the reasoning concluded, so
            // keep it visible to the model as ordinary assistant text instead.
            texts.push(`<thinking>\n${part.thinking}\n</thinking>`);
          }
        }
      }
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
