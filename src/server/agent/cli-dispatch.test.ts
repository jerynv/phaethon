import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/agent.ts";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { updateSettings } from "../settings/settings.ts";
import { errors, FakeLog, fakeBin, setup } from "../cli/__tests__/helpers.ts";
import "../commands.ts";

/** agent_send with a coding agent answering: the turn must run in that agent's own home. */
const env = tempHome("phaethon-agent-cli-");
afterAll(() => env.cleanup());
let log: FakeLog;

beforeAll(() => {
  const s = setup(env.home, "codex");
  log = new FakeLog(s.log);
  process.env.PHAETHON_CODEX_BIN = fakeBin(path.join(env.home, "bin"), "codex");
  updateSettings({ backend: "codex-cli" });
});

describe("agent_send with Codex answering", () => {
  it("runs Codex in the vault's Codex home and ends once", async () => {
    const events = channel<AgentEvent>();
    await call("agent_send", { space: "school", prompt: "tools please", attachments: [], onEvent: events });
    expect(errors(events.messages)).toEqual([]);
    expect(events.messages.filter((e) => e.kind === "end")).toHaveLength(1);
    expect(log.env(1).CODEX_HOME).toBe(path.join(env.appData, "claude-config", "default-codex"));
  });
});
