import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../../tests/harness.ts";
import { cancel, claim, release } from "../../core/runs.ts";
import { ensureVault } from "../../core/vault.ts";
import "../commands.ts";
import { INELIGIBLE_MESSAGE } from "../cli.ts";
import { claudeFallback, geminiAliases, listModels, parseClaudeModels, parseCodexAppModels, parseCodexDebug } from "../models.ts";
import { catalogSupportsReasoning } from "../reasoning.ts";
import { geminiOutcome, instanceRunKey, prepareGeminiHome, runKey, signIn } from "../signin.ts";
import { alive, FakeLog, fakeBin, waitFor } from "./helpers.ts";

const env = tempHome("phaethon-cli-signin-");
afterAll(() => env.cleanup());
let log: FakeLog;

beforeAll(() => {
  ensureVault();
  log = new FakeLog(path.join(env.home, "fake"));
  fs.mkdirSync(log.dir, { recursive: true });
  process.env.FAKE_DIR = log.dir;
  const bins = path.join(env.home, "bin");
  process.env.PHAETHON_CLAUDE_BIN = fakeBin(bins, "claude");
  process.env.PHAETHON_CODEX_BIN = fakeBin(bins, "codex");
  process.env.PHAETHON_GEMINI_BIN = fakeBin(bins, "gemini");
});

describe("sign-in", () => {
  it("keeps its run under a NUL-prefixed key, and a second one is busy", async () => {
    expect(runKey("codex")).toBe("\0sign-in:codex");
    expect(instanceRunKey("claude-work")).toBe("\0sign-in:instance:claude-work");
    const held = claim(runKey("codex"))!;
    expect(await signIn("codex", path.join(env.home, "codex-home"))).toEqual({ status: "busy", message: "Phaethon is already waiting for you to sign in to Codex." });
    release(held);
  });

  it("signs in to Codex with the vault's home and checks with codex login status", async () => {
    const home = path.join(env.appData, "claude-config", "default-codex");
    expect(await call("agent_cli_sign_in", { cli: "codex" })).toEqual({ status: "signedIn", message: "Signed in to Codex for this Phaethon folder." });
    const calls = log.text("login.log").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.map((c) => c.args)).toEqual([["login"], ["login", "status"]]);
    expect(calls.every((c) => c.home === home)).toBe(true);
    process.env.FAKE_LOGGED_IN = "0";
    expect((await call<{ status: string }>("agent_cli_sign_in", { cli: "codex" })).status).toBe("notSignedIn");
    delete process.env.FAKE_LOGGED_IN;
    await expect(call("agent_cli_sign_in", { cli: "claude" })).rejects.toThrow("Phaethon signs in only to Codex and Gemini CLI.");
  });

  it("signs in to Gemini CLI by answering its consent, with Google chosen in its settings", async () => {
    const home = path.join(env.appData, "claude-config", "default-gemini");
    const n = log.runs() + 1;
    expect(await call("agent_cli_sign_in", { cli: "gemini" })).toEqual({ status: "signedIn", message: "Signed in to Gemini CLI for this Phaethon folder." });
    expect(log.text(`consent-${n}`)).toBe("y\n");
    expect(log.env(n)).toMatchObject({ GEMINI_CLI_HOME: home, GEMINI_CLI_TRUST_WORKSPACE: "true", cwd: path.join(home, "sign-in") });
    expect(log.args(n).slice(0, 2)).toEqual(["--output-format", "text"]);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"))).toEqual({ security: { auth: { selectedType: "oauth-personal" } } });
    process.env.FAKE_SIGN_IN = "fail";
    expect(await call("agent_cli_sign_in", { cli: "gemini" })).toEqual({ status: "notSignedIn", message: "Gemini CLI didn’t finish signing in: Error: Login was cancelled in the browser" });
    delete process.env.FAKE_SIGN_IN;
  });

  it("stops promptly when cancelled, and the group is gone", async () => {
    process.env.FAKE_SIGN_IN = "hang";
    const n = log.runs() + 1;
    const pending = call<{ status: string; message: string }>("agent_cli_sign_in", { cli: "gemini" });
    expect(await waitFor(() => log.has(`pid-${n}`))).toBe(true);
    const started = Date.now();
    expect(await call("agent_cli_sign_in_cancel", { cli: "gemini" })).toBe(true);
    expect(await pending).toEqual({ status: "cancelled", message: "Signing in to Gemini CLI was stopped." });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(alive(Number(log.text(`pid-${n}`)))).toBe(false);
    expect(cancel(runKey("gemini"))).toBe(false);
    delete process.env.FAKE_SIGN_IN;
  });

  it("signs in a named Claude Code connection with claude auth login and its own folder", async () => {
    await call("agent_instance_save", { instance: { id: "claude-work", cli: "claude", name: "Work" } });
    const out = await call("agent_instance_sign_in", { id: "claude-work" });
    expect(out).toEqual({ status: "signedIn", message: "Signed in to Claude Code." });
    const calls = log.text("auth.log").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["auth", "login"],
      ["auth", "status"],
    ]);
    expect(calls[0].configDir).toBe(path.join(env.appData, "claude-config", "default-instance-claude-work"));
    process.env.FAKE_LOGGED_IN = "0";
    expect(await call("agent_instance_sign_in", { id: "claude-work" })).toEqual({ status: "notSignedIn", message: "Claude Code did not finish signing in." });
    delete process.env.FAKE_LOGGED_IN;
    await expect(call("agent_instance_sign_in", { id: "nope" })).rejects.toThrow("Assistant instance not found.");
  });

  it("reads Gemini CLI's words", () => {
    expect(geminiOutcome("x IneligibleTierError y")).toEqual({ status: "notSignedIn", message: INELIGIBLE_MESSAGE });
    expect(geminiOutcome("Error authenticating: FatalAuthenticationError: Error: Token expired\n").message).toBe("Gemini CLI didn’t finish signing in: Error: Token expired");
    expect(geminiOutcome("Error authenticating: Error: Token expired\n").message).toBe("Gemini CLI didn’t finish signing in: Token expired");
    expect(geminiOutcome("No input provided via stdin.").status).toBe("signedIn");
    expect(geminiOutcome("")).toEqual({ status: "notSignedIn", message: "Gemini CLI didn’t finish signing in. Try again." });
  });

  it("prepares Gemini CLI's settings only when nothing is chosen, leaving unreadable files alone", () => {
    const home = path.join(env.home, "g");
    prepareGeminiHome(home);
    const file = path.join(home, ".gemini", "settings.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ security: { auth: { selectedType: "oauth-personal" } } });
    fs.writeFileSync(file, JSON.stringify({ ui: 1, security: { auth: { selectedType: "gemini-api-key" } } }));
    prepareGeminiHome(home);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).security.auth.selectedType).toBe("gemini-api-key");
    fs.writeFileSync(file, JSON.stringify({ ui: 1, security: "x" }));
    prepareGeminiHome(home);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ui: 1, security: { auth: { selectedType: "oauth-personal" } } });
    fs.writeFileSync(file, "// comment\n{}");
    prepareGeminiHome(home);
    expect(fs.readFileSync(file, "utf8")).toBe("// comment\n{}");
  });
});

describe("model catalogs", () => {
  it("come from Claude Code's initialize only, with canonical ids, names, aliases and its own levels", async () => {
    const models = await listModels("claude", null);
    expect(models).toEqual({
      defaultModel: "claude-opus-5-5",
      models: [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", description: "Most capable", aliases: ["opus", "claude-opus-5.5"], reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" },
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", aliases: ["haiku"] },
      ],
    });
    const sent = log.text("control.log").trim().split("\n").map((l) => JSON.parse(l));
    expect(sent).toEqual([{ type: "control_request", request_id: "phaethon-models", request: { subtype: "initialize" } }]);
    expect(parseClaudeModels({ models: [] })).toBeNull();
    expect(catalogSupportsReasoning(models, null, "max")).toBe(true);
    expect(catalogSupportsReasoning(models, "opus", "medium")).toBe(false);
  });

  it("fall back to a version-gated list for Claude Code", () => {
    const old = claudeFallback("2.1.200 (Claude Code)").map((m) => m.id);
    expect(old).toContain("claude-opus-4-8");
    expect(old).not.toContain("claude-opus-5-5");
    expect(claudeFallback(null).every((m) => m.id !== "claude-fable-5")).toBe(true);
    expect(claudeFallback("v2.1.300").find((m) => m.id === "claude-opus-5-5")).toEqual({ id: "claude-opus-5-5", name: "Claude Opus 5.5", aliases: ["opus", "opus-5.5", "claude-opus-5.5"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] });
  });

  it("page through Codex's app-server catalog without starting a turn", async () => {
    const n = log.runs() + 1;
    const models = await call("agent_cli_models", { cli: "codex" });
    expect(models).toEqual({
      defaultModel: "gpt-6.1-sol",
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: "Flagship", reasoningEfforts: ["low", "ultra"], defaultReasoningEffort: "ultra" },
        { id: "gpt-6.1-mini", name: "gpt-6.1-mini", aliases: ["mini"] },
      ],
    });
    expect(log.rpc(n).map((m) => m.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
    process.env.FAKE_CYCLE = "1";
    const cyclic = await listModels("codex", path.join(env.appData, "claude-config", "default-codex"));
    delete process.env.FAKE_CYCLE;
    // A cycling catalog is refused; `codex debug models` is the fallback, in Codex's own order.
    expect(cyclic).toEqual({ models: [{ id: "gpt-a", name: "gpt-a", reasoningEfforts: ["high"] }, { id: "gpt-b", name: "B" }] });
    expect(parseCodexAppModels({ data: [{ model: "a", isDefault: true }, { model: "b", isDefault: true }] })).toBeNull();
    expect(parseCodexDebug("not json")).toBeNull();
    await expect(call("agent_cli_models", { cli: "opencode" })).rejects.toThrow("Phaethon doesn’t know that assistant.");
  });

  it("read Gemini CLI's aliases from its bundle", () => {
    const dir = path.join(env.home, "gemini-bundle");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), 'var GEMINI_MODEL_ALIAS_X = "x";');
    fs.writeFileSync(path.join(dir, "gemini.js"), 'var GEMINI_MODEL_ALIAS_AUTO = "auto";\nvar GEMINI_MODEL_ALIAS_PRO = "pro";\nvar GEMINI_MODEL_ALIAS_FLASH_LITE = "flash-lite";\nvar GEMINI_MODEL_ALIAS_BAD = "--x";');
    expect(geminiAliases(dir)).toEqual([
      { id: "auto", name: "Auto" },
      { id: "pro", name: "Pro" },
      { id: "flash-lite", name: "Flash-Lite" },
    ]);
  });

  it("say when a CLI isn't installed", async () => {
    await call("agent_instance_save", { instance: { id: "gemini-gone", cli: "gemini", name: "Gone", binary: path.join(env.home, "none", "gemini") } });
    expect(await call("agent_instance_models", { id: "gemini-gone" })).toEqual({ models: [], note: "Gemini CLI isn’t installed." });
  });
});

describe("status", () => {
  it("lists every CLI with what it can say about its sign-in", async () => {
    const info = await call<{ id: string; installed: boolean; loggedIn: boolean | null; loginCommand: string; ownHome: boolean }[]>("agent_clis_status");
    expect(info.map((i) => i.id)).toEqual(["claude", "codex", "gemini", "opencode"]);
    expect(info[0]).toMatchObject({ installed: true, loggedIn: true, loginCommand: "claude", ownHome: false });
    expect(info[1]).toMatchObject({ installed: true, loggedIn: true, ownHome: true, loginCommand: `CODEX_HOME="${path.join(env.appData, "claude-config", "default-codex")}" codex login` });
    expect(info[2]).toMatchObject({ installed: true, loggedIn: null });
    expect(info[3]).toMatchObject({ name: "OpenCode", supported: false, loginCommand: "opencode auth login" });
    expect(await call("claude_cli_status")).toEqual({ installed: true, path: process.env.PHAETHON_CLAUDE_BIN });
  });
});
