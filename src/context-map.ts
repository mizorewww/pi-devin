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

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  base64Data?: string;
}

export interface ChatHistoryItem {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  /** Prior reasoning, replayed so the server can verify and continue it. */
  thinking?: ChatThinking;
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
      parts.push({ type: "image", mimeType: part.mimeType, base64Data: part.data });
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
          if (part.thinking && decoded.signature) {
            thinking = {
              text: part.thinking,
              signature: decoded.signature,
              signatureType: decoded.signatureType,
              redacted: part.redacted,
            };
          }
        }
      }
      messages.push({
        role: "assistant",
        content: texts.join("\n"),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        thinking,
      });
      continue;
    }
    if (message.role === "toolResult") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      messages.push({
        role: "tool",
        content: text,
        tool_call_id: message.toolCallId,
      });
    }
  }

  const tools: ToolDef[] = getCurrentTools(transcript.messages).map((tool: Tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return { systemPrompt: systemPrompt || undefined, messages, tools };
}
