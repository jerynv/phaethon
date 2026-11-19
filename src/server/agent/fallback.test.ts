import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/agent.ts";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { fakeBin, FakeLog } from "../cli/__tests__/helpers.ts";
import { INELIGIBLE_MESSAGE } from "../cli/cli.ts";
import { keychainSet, providerAccount, resetMemoryKeychain } from "../core/secrets.ts";
import { load, save } from "../core/thread.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { anthropicReply, fakeServer } from "../providers/testing.ts";
import { updateSettings } from "../settings/settings.ts";
import { effectivePick } from "../threads/pick.ts";
import { toUi, writePickRawIn } from "../threads/store.ts";
import { friendlyModelLabel, isFallbackEligible, shortFailureReason } from "./fallback.ts";
import "./commands.ts";

const env = tempHome("phaethon-fallback-");
const T = "2000";
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

let servers: { close: () => Promise<void> }[] = [];
const envKeys = [
  "PHAETHON_ANTHROPIC_BASE_URL",
  "PHAETHON_CLAUDE_BIN",
  "PHAETHON_GEMINI_BIN",
  "PHAETHON_CODEX_BIN",
  "FAKE_DIR",
  "FAKE_LOGGED_IN",
  "FAKE_GEMINI_ANTIGRAVITY",
];

beforeEach(() => {
  resetMemoryKeychain();
  for (const k of envKeys) delete process.env[k];
  updateSettings({
    backend: "phaethon",
    provider: null,
    model: null,
    lastModel: null,
    providerModels: {},
    providerUrls: {},
    autoFallback: true,
  });
  save("school", T, []);
  writePickRawIn(spaceDir("school"), T, null);
});

afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
  for (const k of envKeys) delete process.env[k];
});

async function send(args: Record<string, unknown> = {}) {
  const ch = channel<AgentEvent>();
  await call("agent_send", { space: "school", thread: T, prompt: "hello", attachments: [], ...args, onEvent: ch });
  return ch.messages;
}

const texts = (events: AgentEvent[]) =>
  events
    .filter((e): e is Extract<AgentEvent, { kind: "text" }> => e.kind === "text")
    .map((e) => e.delta)
    .join("");

describe("fallback helpers", () => {
  it("classifies eligible vs non-eligible error codes and messages", () => {
    for (const code of ["network", "unavailable", "rateLimit", "billing", "noApiKey", "apiKey", "missingCli", "notLoggedIn", "provider", "cli"] as const) {
      expect(isFallbackEligible(code, "anything")).toBe(true);
    }
    expect(isFallbackEligible("badRequest", "Google Gemini couldn’t find the model gemini-old.")).toBe(true);
    expect(isFallbackEligible("badRequest", "model_not_found")).toBe(true);
    expect(isFallbackEligible("badRequest", "message content was invalid")).toBe(false);
    for (const code of ["busy", "storage", "invalidSpace", "attachment"] as const) {
      expect(isFallbackEligible(code, "anything")).toBe(false);
    }
  });

  it("formats calm labels and short failure reasons", () => {
    expect(friendlyModelLabel({ backend: "gemini-cli", model: null, effort: null })).toBe("Gemini CLI");
    expect(friendlyModelLabel({ backend: "claude-cli", model: "claude-sonnet-4-6", effort: null })).toBe("Claude Sonnet");
    expect(friendlyModelLabel({ backend: "phaethon", model: "google:gemini-2.5-pro", effort: null })).toBe("Google Gemini (gemini-2.5-pro)");
    expect(friendlyModelLabel({ backend: "phaethon", model: "claude-sonnet-4-6", effort: null })).toBe("Claude Sonnet");

    expect(shortFailureReason("cli", INELIGIBLE_MESSAGE)).toBe("account isn’t supported");
    expect(shortFailureReason("cli", "This client is no longer supported for Gemini Code Assist. Visit https://antigravity.google.")).toBe("account isn’t supported");
    expect(shortFailureReason("network", "timed out")).toBe("couldn’t be reached");
    expect(shortFailureReason("rateLimit", "429")).toBe("hit its rate limit");
    expect(shortFailureReason("notLoggedIn", "sign in")).toBe("isn’t signed in");
    expect(shortFailureReason("unavailable", "503")).toBe("was unavailable");
    expect(shortFailureReason("cli", "This space has a .gemini folder")).toBe("couldn’t run in this space");
  });
});

describe("automatic model fallback", () => {
  it("switches seamlessly from a failing API provider to another ready API provider without duplicating messages", async () => {
    const brokenCustom = await fakeServer([
      { status: 402, body: JSON.stringify({ error: { message: "Billing quota exceeded." } }) },
    ]);
    const healthyAnthropic = await fakeServer([anthropicReply([{ type: "text", text: "Recovered via Anthropic." }])]);
    servers.push(brokenCustom, healthyAnthropic);

    process.env.PHAETHON_ANTHROPIC_BASE_URL = healthyAnthropic.url;
    keychainSet(providerAccount("anthropic"), "sk-ant-test-key");
    updateSettings({
      provider: "custom",
      model: "claude-sonnet-4-6",
      providerModels: { custom: "demo-model" },
      providerUrls: { custom: brokenCustom.url },
    });

    const events = await send({ prompt: "Summarize chapter 3" });

    expect(brokenCustom.seen).toHaveLength(1);
    expect(healthyAnthropic.seen).toHaveLength(1);
    expect(texts(events)).toBe("Recovered via Anthropic.");
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);

    const sw = events.find((e) => e.kind === "modelSwitch");
    expect(sw).toEqual({
      kind: "modelSwitch",
      from: { backend: "phaethon", model: "custom:demo-model" },
      to: { backend: "phaethon", model: "claude-sonnet-4-6", effort: null },
      fromLabel: "Your own server (demo-model)",
      toLabel: "Claude Sonnet",
      reason: "has a billing issue",
    });

    const handoffEvent = events.find((e) => e.kind === "record" && e.record.kind === "handoff");
    expect(handoffEvent).toEqual({
      kind: "record",
      record: { kind: "handoff", from: "Your own server (demo-model)", to: "Claude Sonnet", reason: "has a billing issue" },
    });

    // Thread pick updated to working model.
    expect(effectivePick("school", T).pick).toEqual({ backend: "phaethon", model: "claude-sonnet-4-6", effort: null });

    // No duplicate user message and handoff record persisted on reload.
    const saved = load("school", T);
    expect(saved.filter((m) => m.role === "user")).toHaveLength(1);
    const ui = toUi(saved);
    expect(ui).toHaveLength(2);
    expect(ui[1]!.records).toContainEqual({ kind: "handoff", from: "Your own server (demo-model)", to: "Claude Sonnet", reason: "has a billing issue" });
  });

  it("hands off cleanly from Gemini CLI Antigravity ineligibility to a ready API provider", async () => {
    const log = new FakeLog(path.join(env.home, "fake-gemini-fallback"));
    fs.mkdirSync(log.dir, { recursive: true });
    process.env.FAKE_DIR = log.dir;
    process.env.FAKE_GEMINI_ANTIGRAVITY = "1";
    process.env.PHAETHON_GEMINI_BIN = fakeBin(path.join(env.home, "bin-gemini"), "gemini");

    const healthyAnthropic = await fakeServer([anthropicReply([{ type: "text", text: "Continued with Claude." }])]);
    servers.push(healthyAnthropic);
    process.env.PHAETHON_ANTHROPIC_BASE_URL = healthyAnthropic.url;
    keychainSet(providerAccount("anthropic"), "sk-ant-test-key");
    updateSettings({
      backend: "gemini-cli",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    // Seed prior turn so we verify conversation context carries across the switch.
    save("school", T, [
      { role: "user", content: [{ type: "text", text: "Earlier context question" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier context answer" }] },
    ]);

    const events = await send({ prompt: "Follow-up question" });

    expect(texts(events)).toBe("Continued with Claude.");
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.find((e) => e.kind === "modelSwitch")).toMatchObject({
      fromLabel: "Gemini CLI",
      toLabel: "Claude Sonnet",
      reason: "account isn’t supported",
    });

    const sentMessages = healthyAnthropic.seen[0]!.json.messages as { role: string; content: { text?: string }[] }[];
    expect(sentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(sentMessages)).toContain("Earlier context question");
    expect(JSON.stringify(sentMessages)).toContain("Follow-up question");
    expect(effectivePick("school", T).pick).toEqual({ backend: "phaethon", model: "claude-sonnet-4-6", effort: null });
  });

  it("falls back from a failing API provider to an installed, signed-in CLI with transcript handoff", async () => {
    const brokenCustom = await fakeServer([
      { status: 400, body: JSON.stringify({ error: { message: "model_not_found: demo-model does not exist" } }) },
    ]);
    servers.push(brokenCustom);

    const log = new FakeLog(path.join(env.home, "fake-claude-fallback"));
    fs.mkdirSync(log.dir, { recursive: true });
    process.env.FAKE_DIR = log.dir;
    process.env.FAKE_LOGGED_IN = "1";
    process.env.PHAETHON_CLAUDE_BIN = fakeBin(path.join(env.home, "bin-claude"), "claude");

    updateSettings({
      provider: "custom",
      providerModels: { custom: "demo-model" },
      providerUrls: { custom: brokenCustom.url },
    });

    save("school", T, [
      { role: "user", content: [{ type: "text", text: "FIRST_TURN_CONTEXT" }] },
      { role: "assistant", content: [{ type: "text", text: "FIRST_TURN_REPLY" }] },
    ]);

    const events = await send({ prompt: "Second turn prompt" });

    expect(brokenCustom.seen).toHaveLength(1);
    expect(texts(events)).toBe("Reply 1.");
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.find((e) => e.kind === "modelSwitch")).toMatchObject({
      fromLabel: "Your own server (demo-model)",
      toLabel: "Claude Code",
      reason: "couldn’t use that model",
    });
    expect(effectivePick("school", T).pick).toEqual({ backend: "claude-cli", model: null, effort: null });
    // Verify portable context handoff reached the CLI prompt.
    const cliPrompt = log.text("stdin-1");
    expect(cliPrompt).toContain("FIRST_TURN_CONTEXT");
    expect(cliPrompt).toContain("Second turn prompt");
  });

  it("does not switch when autoFallback is disabled", async () => {
    const brokenCustom = await fakeServer([
      { status: 401, body: JSON.stringify({ error: { message: "Invalid key." } }) },
    ]);
    const healthyAnthropic = await fakeServer([anthropicReply([{ type: "text", text: "Should not be called." }])]);
    servers.push(brokenCustom, healthyAnthropic);

    process.env.PHAETHON_ANTHROPIC_BASE_URL = healthyAnthropic.url;
    keychainSet(providerAccount("anthropic"), "sk-ant-test-key");
    updateSettings({
      provider: "custom",
      model: "claude-sonnet-4-6",
      providerModels: { custom: "demo-model" },
      providerUrls: { custom: brokenCustom.url },
      autoFallback: false,
    });

    const events = await send({ prompt: "hello" });

    expect(brokenCustom.seen).toHaveLength(1);
    expect(healthyAnthropic.seen).toHaveLength(0);
    expect(events.find((e) => e.kind === "modelSwitch")).toBeUndefined();
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
  });

  it("does not switch if the primary model already streamed output before failing", async () => {
    const midStreamFail = await fakeServer([
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body:
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial answer"}}\n\n' +
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded mid-stream"}}\n\n',
      },
    ]);
    const secondaryCustom = await fakeServer([
      { status: 200, headers: { "content-type": "text/event-stream" }, body: "" },
    ]);
    servers.push(midStreamFail, secondaryCustom);

    process.env.PHAETHON_ANTHROPIC_BASE_URL = midStreamFail.url;
    keychainSet(providerAccount("anthropic"), "sk-ant-test-key");
    updateSettings({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      providerModels: { custom: "demo-model" },
      providerUrls: { custom: secondaryCustom.url },
    });

    const events = await send({ prompt: "hello" });

    expect(texts(events)).toBe("Partial answer");
    expect(secondaryCustom.seen).toHaveLength(0);
    expect(events.find((e) => e.kind === "modelSwitch")).toBeUndefined();
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
  });

  it("emits the original error without a bogus modelSwitch if all fallback candidates also fail", async () => {
    const brokenCustom = await fakeServer([
      { status: 401, body: JSON.stringify({ error: { message: "Invalid API key." } }) },
    ]);
    const brokenAnthropic = await fakeServer([
      { status: 401, body: JSON.stringify({ error: { message: "Invalid Anthropic key." } }) },
    ]);
    servers.push(brokenCustom, brokenAnthropic);

    process.env.PHAETHON_ANTHROPIC_BASE_URL = brokenAnthropic.url;
    keychainSet(providerAccount("anthropic"), "sk-ant-test-key");
    updateSettings({
      provider: "custom",
      model: "claude-sonnet-4-6",
      providerModels: { custom: "demo-model" },
      providerUrls: { custom: brokenCustom.url },
    });

    const events = await send({ prompt: "hello" });

    expect(brokenCustom.seen).toHaveLength(1);
    expect(brokenAnthropic.seen).toHaveLength(1);
    expect(events.find((e) => e.kind === "modelSwitch")).toBeUndefined();
    expect(events.find((e) => e.kind === "record" && e.record.kind === "handoff")).toBeUndefined();
    const errs = events.filter((e): e is Extract<AgentEvent, { kind: "error" }> => e.kind === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("apiKey");
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
    // Original thread state cleanly restored without duplicate user messages.
    expect(load("school", T)).toEqual([]);
  });
});
