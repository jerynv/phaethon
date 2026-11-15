import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/agent.ts";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { resetMemoryKeychain } from "../core/secrets.ts";
import { resetFake } from "../providers/fake.ts";
import { readSettings, updateSettings } from "../settings/settings.ts";
import { updateSpaceMeta } from "../spaces/meta.ts";
import { userMessage } from "../core/thread.ts";
import { claim, release, turnKey } from "../core/runs.ts";
import { effectivePick, parsePick, type ModelPick } from "./pick.ts";
import { listThreadsIn, saveIn } from "./store.ts";
import "./commands.ts";
import "../agent/commands.ts";

const env = tempHome();
beforeAll(() => ensureVault());
afterAll(() => env.cleanup());

const dir = () => spaceDir("school");
const state = (...p: string[]) => path.join(dir(), ".phaethon", ...p);
const view = (thread: string | null = "1000") => call<{ pick: ModelPick; saved: boolean }>("thread_model_get", { space: "school", thread });
const set = (pick: unknown, thread: string | null = "1000") => call<{ pick: ModelPick; saved: boolean }>("thread_model_set", { space: "school", thread, pick });

describe("parsePick", () => {
  it("accepts each backend's own model and effort, normalising Anthropic refs", () => {
    expect(parsePick({ backend: "phaethon", model: "anthropic:claude-opus-5-5", effort: "high" })).toEqual({ backend: "phaethon", model: "claude-opus-5-5", effort: "high" });
    expect(parsePick({ backend: "phaethon", model: "openai:gpt-5.5" })).toEqual({ backend: "phaethon", model: "openai:gpt-5.5", effort: null });
    expect(parsePick({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "xhigh" })).toEqual({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "xhigh" });
    expect(parsePick({ backend: "codex-cli", model: null, effort: null })).toEqual({ backend: "codex-cli", model: null, effort: null });
    expect(parsePick({ backend: "steward", model: null })).toEqual({ backend: "phaethon", model: null, effort: null });
  });

  it("refuses anything it couldn't pass on safely", () => {
    for (const bad of [
      null,
      [],
      "phaethon",
      { backend: "nope" },
      { backend: "phaethon", model: "nobody:model" },
      { backend: "phaethon", model: "claude-x", effort: "ultra" },
      { backend: "gemini-cli", model: null, effort: "high" },
      { backend: "claude-cli", model: "--dangerous" },
      { backend: "claude-cli", model: 5 },
    ]) {
      expect(parsePick(bad)).toBeNull();
    }
  });
});

describe("the conversation's model", () => {
  it("falls back to the space's model for an old conversation, and the last pick for a new one", async () => {
    updateSettings({ backend: "phaethon", provider: "anthropic", model: "claude-opus-5-5" });
    updateSpaceMeta("school", { model: "openai:gpt-5.5" });
    saveIn(dir(), "1000", [userMessage("hello")]);
    // An existing conversation with nothing saved answers as before.
    expect(await view()).toEqual({ pick: { backend: "phaethon", model: "openai:gpt-5.5", effort: null }, saved: false });

    await set({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    expect(await view()).toEqual({ pick: { backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" }, saved: true });
    expect(readSettings().lastModel).toEqual({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    expect(JSON.parse(fs.readFileSync(state("threads", "1000.model"), "utf8"))).toEqual({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    // The vault's backend is not changed by a conversation's choice.
    expect(readSettings().backend).toBe("phaethon");
  });

  it("is each conversation's own, and never shows up as a conversation", async () => {
    saveIn(dir(), "2000", [userMessage("second")]);
    // A conversation that has started but chose nothing answers as before; a new chat starts with the last pick.
    expect(await view("2000")).toEqual({ pick: { backend: "phaethon", model: "openai:gpt-5.5", effort: null }, saved: false });
    expect(await view(null)).toEqual({ pick: { backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" }, saved: false });
    await set({ backend: "phaethon", model: "anthropic:claude-haiku-5-5", effort: null }, "2000");
    expect((await view("1000")).pick).toEqual({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    expect((await view("2000")).pick.model).toBe("claude-haiku-5-5");
    expect(listThreadsIn(dir()).map((t) => t.id).sort()).toEqual(["1000", "2000"]);

    // A new chat's choice is only the default until it is sent: no file for it.
    const fresh = await call<string>("thread_create", { space: "school" });
    await set({ backend: "codex-cli", model: null, effort: null }, fresh);
    expect(fs.existsSync(state("threads", `${fresh}.model`))).toBe(false);
    expect(readSettings().lastModel).toEqual({ backend: "codex-cli", model: null, effort: null });

    await call("thread_delete", { space: "school", thread: "2000" });
    expect(fs.existsSync(state("threads", "2000.model"))).toBe(false);
    expect(fs.existsSync(state("threads", "1000.model"))).toBe(true);
    await call("thread_delete", { space: "school", thread: "1000" });
  });

  it("ignores a damaged choice file rather than failing", async () => {
    saveIn(dir(), "3000", [userMessage("x")]);
    fs.writeFileSync(state("threads", "3000.model"), "{nope");
    expect((await view("3000")).saved).toBe(false);
    await expect(set({ backend: "phaethon", model: "nobody:x" }, "3000")).rejects.toThrow(/isn’t a model/);
    await call("thread_delete", { space: "school", thread: "3000" });
  });
});

describe("agent_send with a model", () => {
  it("saves the pick and answers with it", async () => {
    const script = path.join(env.home, "script.json");
    fs.writeFileSync(script, JSON.stringify({ claude: true, steps: [{ text: "Hi." }] }));
    process.env.PHAETHON_FAKE_PROVIDER = script;
    resetFake();
    resetMemoryKeychain();
    try {
      const ch = channel<AgentEvent>();
      await call("agent_send", {
        space: "school",
        thread: "4000",
        prompt: "hello",
        attachments: [],
        model: { backend: "phaethon", model: "anthropic:claude-opus-5-5", effort: "low" },
        onEvent: ch,
      });
      expect(ch.messages.filter((e) => e.kind === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Hi.");
      expect(effectivePick("school", "4000")).toEqual({ pick: { backend: "phaethon", model: "claude-opus-5-5", effort: "low" }, saved: true });
      const log = fs.readFileSync(`${script}.requests.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(log[0].effort).toBe("low");
    } finally {
      delete process.env.PHAETHON_FAKE_PROVIDER;
    }
  });

  it("leaves a running conversation's model alone when a second send is refused as busy", async () => {
    const before = effectivePick("school", "4000");
    const run = claim(turnKey("school", "4000"))!;
    try {
      const ch = channel<AgentEvent>();
      await call("agent_send", { space: "school", thread: "4000", prompt: "x", attachments: [], model: { backend: "phaethon", model: "openai:gpt-5.5", effort: null }, onEvent: ch });
      expect(ch.messages.map((e) => e.kind)).toEqual(["error", "end"]);
      expect((ch.messages[0] as { code: string }).code).toBe("busy");
    } finally {
      release(run);
    }
    expect(effectivePick("school", "4000")).toEqual(before);
    expect(readSettings().lastModel).not.toEqual({ backend: "phaethon", model: "openai:gpt-5.5", effort: null });
  });

  it("refuses a bad pick with one error and an end", async () => {
    const ch = channel<AgentEvent>();
    await call("agent_send", { space: "school", thread: "4000", prompt: "x", attachments: [], model: { backend: "nope" }, onEvent: ch });
    expect(ch.messages.map((e) => e.kind)).toEqual(["error", "end"]);
  });
});
