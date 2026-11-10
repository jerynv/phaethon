import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/agent.ts";
import { channel, tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { isRunning } from "../core/runs.ts";
import { agentSend } from "./turn.ts";
import "../commands.ts";

/** A turn waiting on the person stops when the window that started it disconnects. */
const env = tempHome("phaethon-agent-disconnect-");
afterAll(() => env.cleanup());

beforeAll(() => {
  ensureVault();
  const script = path.join(env.home, "fake.json");
  fs.writeFileSync(script, JSON.stringify({ steps: [{ text: "Saving.", tools: [{ name: "write_file", input: { path: "a.md", contents: "x" } }] }, { text: "Done." }] }));
  process.env.PHAETHON_FAKE_PROVIDER = script;
});
afterAll(() => delete process.env.PHAETHON_FAKE_PROVIDER);

describe("disconnecting during an approval", () => {
  it("cancels the turn and frees the space", async () => {
    const connection = new AbortController();
    const events = channel<AgentEvent>((e) => {
      if (e.kind === "approval") connection.abort();
    });
    await agentSend({ space: "school", prompt: "save it", attachments: [], onEvent: events } as never, connection.signal);
    expect(events.messages.some((e) => e.kind === "approval")).toBe(true);
    expect(events.messages.some((e) => e.kind === "cancelled")).toBe(true);
    expect(events.messages.at(-1)).toEqual({ kind: "end", sessionId: null });
    expect(isRunning("school")).toBe(false);
    expect(fs.existsSync(path.join(env.home, "Phaethon/default/spaces/school/a.md"))).toBe(false);
  });
});
