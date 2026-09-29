import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { mapContextToChat } from "../src/context-map.ts";

const tool = (name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});

// Regression for #7: Pi 0.86 moves prompt and tools into system messages.
test("preserves the prompt and tools from a normalized transcript", () => {
  const read = tool("read");
  const context = normalizeContext({
    systemPrompt: "Inspect the repository.",
    tools: [read],
    messages: [{ role: "user", content: "Read README", timestamp: 1 }],
  });
  assert.deepEqual(mapContextToChat(context), {
    systemPrompt: "Inspect the repository.",
    messages: [
      { role: "user", content: "Read README" },
    ],
    tools: [read],
  });
});

test("applies later instruction, section, and tool changes", () => {
  const bash = tool("bash");
  const context = {
    messages: [
      { role: "system", content: "Inspect the repository.", sections: { policy: "Old policy", obsolete: "Remove me" }, toolsAdded: [tool("read")], timestamp: 0 },
      { role: "user", content: "Continue", timestamp: 1 },
      { role: "system", content: "Use bash.", sections: { policy: "Do not edit.", obsolete: null }, toolsRemoved: [{ name: "read" }], toolsAdded: [bash], timestamp: 2 },
    ],
  };
  assert.deepEqual(mapContextToChat(context), {
    systemPrompt: "Inspect the repository.\n\nUse bash.\n\nDo not edit.",
    messages: [
      { role: "user", content: "Continue" },
    ],
    tools: [bash],
  });
});

test("accepts an empty transcript", () => {
  assert.deepEqual(mapContextToChat(normalizeContext({ messages: [] })), {
    systemPrompt: undefined,
    messages: [],
    tools: [],
  });
});
