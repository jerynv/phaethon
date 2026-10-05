import type { ChatModelAdapter } from "@assistant-ui/react";

/**
 * Placeholder model adapter: replies with the text of the latest user message.
 * No network, no model. Used when the UI runs in a plain browser (no Tauri IPC).
 */
export const echoAdapter: ChatModelAdapter = {
  async run({ messages }) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text =
      lastUser?.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim() ?? "";
    const files = lastUser?.role === "user" ? lastUser.attachments.length : 0;
    const note = files ? ` (with ${files} file${files === 1 ? "" : "s"})` : "";

    return {
      content: [{ type: "text", text: `echo: ${text || "(empty message)"}${note}` }],
    };
  },
};
