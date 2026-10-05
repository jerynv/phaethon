import type { ChatModelAdapter } from "@assistant-ui/react";

/**
 * Placeholder model adapter: replies with the text of the latest user message.
 * No network, no model. Swapped for the CLI / API-key backends later.
 */
export const echoAdapter: ChatModelAdapter = {
  async run({ messages }) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text =
      lastUser?.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim() ?? "";

    return {
      content: [{ type: "text", text: text ? `echo: ${text}` : "echo: (empty message)" }],
    };
  },
};
