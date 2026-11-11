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
import { effectivePick, parsePick, type ModelPick } from "./pick.ts";
import { listThreadsIn, saveIn } from "./store.ts";
import "./commands.ts";
import "../agent/commands.ts";

const env = tempHome();
beforeAll(() => ensureVault());
afterAll(() => env.cleanup());

const dir = () => spaceDir("school");
const state = (...p: string[]) => path.join(dir(), ".phaethon", ...p);
const view = (space = "school") => call<{ pick: ModelPick; saved: boolean }>("thread_model_get", { space });
const set = (pick: unknown, space = "school") => call<{ pick: ModelPick; saved: boolean }>("thread_model_set", { space, pick });

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
    saveIn(dir(), [userMessage("hello")]);
    // An existing conversation with nothing saved answers as before.
    expect(await view()).toEqual({ pick: { backend: "phaethon", model: "openai:gpt-5.5", effort: null }, saved: false });

    await set({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    expect(await view()).toEqual({ pick: { backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" }, saved: true });
    expect(readSettings().lastModel).toEqual({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    expect(JSON.parse(fs.readFileSync(state("model"), "utf8"))).toEqual({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    // The vault's backend is not changed by a conversation's choice.
    expect(readSettings().backend).toBe("phaethon");
  });

  it("travels with its conversation through new, open and delete, and never shows up as one", async () => {
    // The conversation from the previous test is current, with Claude Code picked.
    await call("thread_new", { space: "school" });
    const [, archived] = listThreadsIn(dir());
    expect(archived).toBeDefined();
    expect(fs.existsSync(state("threads", `${archived!.id}.model`))).toBe(true);
    expect(fs.existsSync(state("model"))).toBe(false);
    expect(listThreadsIn(dir()).map((t) => t.id)).toEqual(["current", archived!.id]);

    // A new conversation starts with the last pick, unsaved until changed or sent.
    expect(await view()).toEqual({ pick: { backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" }, saved: false });
    saveIn(dir(), [userMessage("second")]);
    await set({ backend: "phaethon", model: "anthropic:claude-haiku-5-5", effort: null });

    await call("thread_open", { space: "school", id: archived!.id });
    expect((await view()).pick).toEqual({ backend: "claude-cli", model: "claude-sonnet-5-5", effort: "high" });
    const second = listThreadsIn(dir()).find((t) => !t.current)!;
    expect(JSON.parse(fs.readFileSync(state("threads", `${second.id}.model`), "utf8")).model).toBe("claude-haiku-5-5");

    await call("thread_delete", { space: "school", id: second.id });
    expect(fs.existsSync(state("threads", `${second.id}.model`))).toBe(false);
    await call("thread_delete", { space: "school", id: "current" });
    expect(fs.existsSync(state("model"))).toBe(false);
  });

  it("ignores a damaged choice file rather than failing", async () => {
    saveIn(dir(), [userMessage("x")]);
    fs.writeFileSync(state("model"), "{nope");
    expect((await view()).saved).toBe(false);
    await expect(set({ backend: "phaethon", model: "nobody:x" })).rejects.toThrow(/isn’t a model/);
    await call("thread_delete", { space: "school", id: "current" });
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
        prompt: "hello",
        attachments: [],
        model: { backend: "phaethon", model: "anthropic:claude-opus-5-5", effort: "low" },
        onEvent: ch,
      });
      expect(ch.messages.filter((e) => e.kind === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Hi.");
      expect(effectivePick("school")).toEqual({ pick: { backend: "phaethon", model: "claude-opus-5-5", effort: "low" }, saved: true });
      const log = fs.readFileSync(`${script}.requests.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(log[0].effort).toBe("low");
    } finally {
      delete process.env.PHAETHON_FAKE_PROVIDER;
    }
  });

  it("refuses a bad pick with one error and an end", async () => {
    const ch = channel<AgentEvent>();
    await call("agent_send", { space: "school", prompt: "x", attachments: [], model: { backend: "nope" }, onEvent: ch });
    expect(ch.messages.map((e) => e.kind)).toEqual(["error", "end"]);
  });
});
