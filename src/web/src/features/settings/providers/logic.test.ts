import { describe, expect, it, vi } from "vitest";

import type { ProviderInfo, Settings } from "./api";
import { addedProviders, canSaveUnchecked, checkAndSave, isAdded, isValidModelFor, matchModels, outcomeText, providerNeed, readableModel, splitRef, toRef } from "./logic";

const base: ProviderInfo = {
  id: "openai",
  name: "OpenAI",
  key: "required",
  local: false,
  editableBase: false,
  hasKey: false,
  baseUrl: "https://api.openai.com/v1",
  defaultBaseUrl: "https://api.openai.com/v1",
  model: null,
  keysUrl: "",
  keyPrefix: "",
  ready: false,
};
const p = (over: Partial<ProviderInfo>): ProviderInfo => ({ ...base, ...over });

describe("model references", () => {
  it("saves Anthropic plain and others as provider:model", () => {
    expect(toRef("anthropic", "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(toRef("openrouter", "openai/gpt-5")).toBe("openrouter:openai/gpt-5");
  });
  it("splits on a known provider head only", () => {
    expect(splitRef("openrouter:openai/gpt-5")).toEqual({ provider: "openrouter", model: "openai/gpt-5" });
    expect(splitRef("ollama:llama3.2:3b")).toEqual({ provider: "ollama", model: "llama3.2:3b" });
    expect(splitRef("claude-haiku-5-5")).toEqual({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(splitRef("nope:model")).toEqual({ provider: "anthropic", model: "nope:model" });
  });
  it("checks names the way the core does", () => {
    expect(isValidModelFor("anthropic", "claude-opus-5-5")).toBe(true);
    expect(isValidModelFor("anthropic", "gpt-5")).toBe(false);
    expect(isValidModelFor("openai", "gpt-5")).toBe(true);
    expect(isValidModelFor("openai", "../x")).toBe(false);
    expect(isValidModelFor("openai", "-x")).toBe(false);
    expect(isValidModelFor("openai", "has space")).toBe(false);
  });
  it("reads Claude ids", () => {
    expect(readableModel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(readableModel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(readableModel("claude-opus-5")).toBe("Claude Opus 5");
    expect(readableModel("gpt-5")).toBe("gpt-5");
  });
});

describe("which providers show", () => {
  it("counts a key, or a model or own address for keyless ones", () => {
    expect(isAdded(p({ hasKey: true }))).toBe(true);
    expect(isAdded(p({ model: "gpt-5" }))).toBe(false);
    const ollama = p({ id: "ollama", key: "none", local: true, editableBase: true, baseUrl: "http://127.0.0.1:11434/v1", defaultBaseUrl: "http://127.0.0.1:11434/v1" });
    expect(isAdded(ollama)).toBe(false);
    expect(isAdded({ ...ollama, model: "llama3.2:3b" })).toBe(true);
    expect(isAdded({ ...ollama, baseUrl: "http://10.0.0.2:11434/v1" })).toBe(true);
  });
  it("puts the default first, and always lists it", () => {
    const settings = {
      provider: "openai",
      model: "claude-opus-5-5",
      providers: [p({ id: "anthropic", name: "Anthropic", hasKey: true, model: "claude-opus-5-5" }), p({})],
    } as unknown as Settings;
    expect(addedProviders(settings).map((x) => x.id)).toEqual(["openai", "anthropic"]);
  });
  it("names what's missing, address first", () => {
    const s = { model: "claude-opus-5-5" };
    expect(providerNeed(p({ id: "custom", key: "optional", editableBase: true, baseUrl: "" }), s)?.field).toBe("url");
    expect(providerNeed(p({}), s)?.field).toBe("key");
    expect(providerNeed(p({ hasKey: true }), s)?.field).toBe("model");
    expect(providerNeed(p({ hasKey: true, model: "gpt-5" }), s)).toBeNull();
    expect(providerNeed(p({ id: "anthropic", hasKey: true, model: null }), s)).toBeNull();
  });
});

describe("check and save", () => {
  const ok = { check: vi.fn(async () => ({ ok: true, message: "" })), save: vi.fn(async () => {}) };
  it("refuses an empty key without asking anyone", async () => {
    const calls = { check: vi.fn(), save: vi.fn() };
    expect(await checkAndSave("   ", "openai", calls)).toEqual({ kind: "problem", problem: "empty" });
    expect(calls.check).not.toHaveBeenCalled();
  });
  it("trims, checks, then saves", async () => {
    expect(await checkAndSave("  sk-abc  ", "openai", ok)).toEqual({ kind: "saved" });
    expect(ok.save).toHaveBeenCalledWith("openai", "sk-abc");
  });
  it("saves a real key on an account without credit", async () => {
    const save = vi.fn(async () => {});
    const r = await checkAndSave("k", "openai", { check: async () => ({ ok: false, problem: "billing" as const, message: "" }), save });
    expect(r).toEqual({ kind: "no-credit" });
    expect(save).toHaveBeenCalled();
  });
  it("doesn't save a rejected key, and offers saving unchecked only on network trouble", async () => {
    const save = vi.fn(async () => {});
    const r = await checkAndSave("k", "openai", { check: async () => ({ ok: false, problem: "rejected" as const, message: "Nope." }), save });
    expect(r).toEqual({ kind: "problem", problem: "rejected", detail: "Nope." });
    expect(save).not.toHaveBeenCalled();
    expect(canSaveUnchecked(r)).toBe(false);
    const n = await checkAndSave("k", "openai", { check: async () => ({ ok: false, problem: "network" as const, message: "" }), save });
    expect(canSaveUnchecked(n)).toBe(true);
    expect(await checkAndSave("k", "openai", { check: vi.fn(), save }, true)).toEqual({ kind: "saved" });
  });
  it("passes on the core's refusal", async () => {
    const r = await checkAndSave("k", "openai", { check: ok.check, save: async () => Promise.reject("That provider doesn’t take a key.") });
    expect(r).toEqual({ kind: "problem", problem: "not-saved", detail: "That provider doesn’t take a key." });
    expect(outcomeText(r, base)).toBe("The key wasn’t saved. That provider doesn’t take a key.");
  });
  it("words outcomes per provider", () => {
    expect(outcomeText({ kind: "problem", problem: "network" }, { id: "custom", name: "Your own server", keyPrefix: "" })).toContain("your server");
    expect(outcomeText({ kind: "problem", problem: "empty" }, { id: "anthropic", name: "Anthropic", keyPrefix: "sk-ant-" })).toContain("sk-ant-");
    expect(outcomeText({ kind: "no-credit" }, base)).toBe("Key saved. Add OpenAI credit before it can answer.");
  });
});

describe("model search", () => {
  it("matches every word in id or name", () => {
    const models = [
      { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5" },
      { id: "google/gemini-3.1-pro", name: "Google: Gemini 3.1 Pro" },
    ];
    expect(matchModels(models, "gemini pro").map((m) => m.id)).toEqual(["google/gemini-3.1-pro"]);
    expect(matchModels(models, "  ").length).toBe(2);
    expect(matchModels(models, "GPT").length).toBe(1);
  });
});
