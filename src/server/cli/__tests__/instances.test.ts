import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../../tests/harness.ts";
import { ensureVault, vaultStateDir } from "../../core/vault.ts";
import { readSettings, updateSettings } from "../../settings/settings.ts";
import "../commands.ts";
import { account, cliCommand, configDirFor, home, launch, list, parseUsage, remove, requireHome, save, select, selected, sessionTag, usage, validate, type Instance } from "../instances.ts";
import { statusOf } from "../commands.ts";
import { wallBreakingArg } from "../walls.ts";
import { errors, FakeLog, fakeBin, request, send } from "./helpers.ts";

const env = tempHome("phaethon-cli-instances-");
afterAll(() => env.cleanup());
const root = () => path.join(env.appData, "claude-config");
const settingsFile = () => path.join(vaultStateDir(), "settings.json");

beforeAll(() => ensureVault());
beforeEach(() => {
  fs.rmSync(settingsFile(), { force: true });
  fs.rmSync(path.join(env.home, ".codex"), { recursive: true, force: true });
  fs.rmSync(path.join(env.home, ".gemini"), { recursive: true, force: true });
});

const instance = (o: Partial<Instance>): Instance => ({ id: "claude-work", cli: "claude", name: "Work", binary: "", args: [], ...o });

describe("instances", () => {
  it("list existing system homes without saving, selecting or writing anything", () => {
    expect(list().some((i) => i.id.endsWith("-system"))).toBe(false);
    fs.mkdirSync(path.join(env.home, ".codex"));
    fs.mkdirSync(path.join(env.home, ".gemini"));
    const entries = list();
    for (const id of ["codex", "gemini", "codex-system", "gemini-system"]) expect(entries.filter((e) => e.id === id)).toHaveLength(1);
    expect(entries.find((e) => e.id === "gemini-system")?.name).toBe("Gemini CLI · System");
    expect(selected("codex").id).toBe("codex");
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(fs.existsSync(path.join(env.home, ".codex", "phaethon-instance.json"))).toBe(false);
  });

  it("keep system and managed homes, environments and session tags apart", () => {
    fs.mkdirSync(path.join(env.home, ".codex"));
    fs.mkdirSync(path.join(env.home, ".gemini"));
    expect(home(instance({ id: "codex-system", cli: "codex" }))).toBe(path.join(env.home, ".codex"));
    expect(home(instance({ id: "gemini-system", cli: "gemini" }))).toBe(env.home);
    expect(home(instance({ id: "codex", cli: "codex" }))).toBe(path.join(root(), "default-codex"));
    expect(launch(path.join(env.home, ".codex"))?.id).toBe("codex-system");
    expect(sessionTag("codex", path.join(env.home, ".codex"))).toBe("codex-codex-system");
    expect(sessionTag("codex", path.join(root(), "default-codex"))).toBe("codex");
    expect(cliCommand("codex", "/x/codex", env.home, path.join(env.home, ".codex")).env.CODEX_HOME).toBe(path.join(env.home, ".codex"));
    // Claude Code uses the person's own config unless the vault opts in.
    expect(home(instance({ id: "claude", cli: "claude" }))).toBeNull();
    updateSettings({ isolateClaudeConfig: true });
    expect(home(instance({ id: "claude", cli: "claude" }))).toBe(path.join(root(), "default"));
  });

  it("never save, remove or let a file poison a computed system connection", () => {
    fs.mkdirSync(path.join(env.home, ".codex"));
    const poison = { id: "codex-system", cli: "claude", name: "Wrong", binary: "/not-it", args: ["--wrong"] };
    fs.writeFileSync(path.join(env.home, ".codex", "phaethon-instance.json"), JSON.stringify(poison));
    updateSettings({ agentInstances: [poison] });
    const system = list().find((i) => i.id === "codex-system")!;
    expect(system).toMatchObject({ cli: "codex", binary: "", args: [] });
    expect(() => save(system)).toThrow("System CLI connections are managed by their CLI.");
    expect(() => remove("codex-system")).toThrow("Built-in assistants cannot be removed.");
    expect(launch(path.join(env.home, ".codex"))).toMatchObject({ id: "codex-system", binary: "", args: [] });
  });

  it("save named connections with their own home and never persist system entries", () => {
    fs.mkdirSync(path.join(env.home, ".codex"));
    save(instance({ id: "codex-work", cli: "codex" }));
    const stored = readSettings().agentInstances as Instance[];
    expect(stored.some((i) => i.id.endsWith("-system"))).toBe(false);
    expect(stored.map((i) => i.id)).toEqual(["claude", "codex", "gemini", "codex-work"]);
    const file = path.join(root(), "default-instance-codex-work", "phaethon-instance.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ id: "codex-work", cli: "codex", name: "Work", binary: "", args: [] });
    expect(() => save(instance({ id: "codex-work", cli: "gemini" }))).toThrow("An instance cannot change assistant type.");
    expect(() => save(instance({ id: "claude", cli: "claude", args: ["--verbose"] }))).toThrow("Add a named Claude Code instance to customize its launch options.");
  });

  it("fail a missing selected system home instead of using another account", () => {
    fs.mkdirSync(path.join(env.home, ".codex"));
    updateSettings({ activeAgentInstances: { codex: "codex-system" } });
    fs.rmdirSync(path.join(env.home, ".codex"));
    expect(selected("codex").id).toBe("codex-system");
    expect(() => requireHome(selected("codex"))).toThrow("Phaethon cannot find a local configuration folder for this connection.");
    expect(configDirFor("codex")).toBeNull();
  });

  it("validate with the exact messages", () => {
    expect(() => validate(instance({ id: "codex-system", cli: "codex" }))).toThrow("System CLI configuration is computed from its existing home.");
    expect(() => validate(instance({ cli: "opencode" }))).toThrow("Unknown assistant.");
    expect(() => validate(instance({ id: "codex" }))).toThrow("The built-in assistant identifier belongs to another assistant.");
    expect(() => validate(instance({ id: "../escape" }))).toThrow("Invalid assistant instance.");
    expect(() => validate(instance({ name: " " }))).toThrow("Use a name of 1–80 characters.");
    expect(() => validate(instance({ binary: "a\0b" }))).toThrow("Invalid executable path.");
    expect(() => validate(instance({ args: ["a\nb"] }))).toThrow("Use at most 64 single-line arguments.");
    expect(() => validate(instance({ args: ["--output-format=json"] }))).toThrow("Output, session and prompt arguments are managed by Phaethon.");
    expect(() => validate(instance({ binary: "/opt/bin/claude", args: ["--setting", "a value with spaces"] }))).not.toThrow();
  });

  it("keep independent accounts outside the vault; removing one keeps its home", () => {
    for (const id of ["claude-work", "claude-personal"]) save(instance({ id, name: id }));
    select("claude-work");
    expect(readSettings().backend).toBe("claude-cli");
    const work = home(selected("claude"))!;
    select("claude-personal");
    const personal = home(selected("claude"))!;
    expect(work).not.toBe(personal);
    expect(work.startsWith(env.home + "/Phaethon")).toBe(false);
    expect(launch(work)?.id).toBe("claude-work");
    expect(sessionTag("claude", personal)).toBe("claude-claude-personal");
    remove("claude-personal");
    expect(selected("claude").id).toBe("claude");
    expect(fs.statSync(personal).isDirectory()).toBe(true);
  });

  it("report installation from an executable file only, with no path key otherwise", () => {
    const bin = path.join(env.home, "status-claude");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o644 });
    expect(statusOf(bin)).toEqual({ installed: false });
    fs.chmodSync(bin, 0o755);
    expect(statusOf(bin)).toEqual({ installed: true, path: bin });
    expect(JSON.parse(JSON.stringify(statusOf(null)))).toEqual({ installed: false });
    expect(statusOf(env.home).installed).toBe(false);
  });
});

describe("usage", () => {
  it("read Claude and Codex windows in the same units", () => {
    expect(parseUsage("claude", { rate_limits: { five_hour: { utilization: 37.5, resets_at: "2026-11-05T05:00:00Z" } } })).toEqual([{ label: "5 hours", usedPercent: 37.5, resetsAt: "2026-11-05T05:00:00Z" }]);
    expect(parseUsage("codex", { rateLimits: { primary: { usedPercent: 42, resetsAt: 1793854800 } } })[0]).toEqual({ label: "Session", usedPercent: 42, resetsAt: 1793854800 });
    expect(parseUsage("claude", { rate_limits_available: false })).toEqual([]);
  });

  it("prefer the account bucket, label by duration and plan, keep the credit limit, never zero-fill", () => {
    const main = parseUsage("codex", {
      rateLimits: { limitId: "codex_bengalfox", primary: { usedPercent: 0, windowDurationMins: 300 } },
      rateLimitsByLimitId: { codex_bengalfox: {}, codex: { limitId: "codex", planType: "plus", primary: { usedPercent: 12, windowDurationMins: 300 }, secondary: { usedPercent: 67, windowDurationMins: 10080, resetsAt: 1784500000 } } },
    });
    expect(main.map((w) => [w.label, w.usedPercent])).toEqual([
      ["Session", 12],
      ["Weekly", 67],
    ]);
    for (const map of [null, {}, { codex_bengalfox: { secondary: { usedPercent: 0 } } }]) {
      expect(parseUsage("codex", { rateLimits: { limitId: "codex_bengalfox", secondary: { usedPercent: 0 } }, rateLimitsByLimitId: map })).toEqual([]);
    }
    expect(parseUsage("codex", { rateLimits: { primary: { usedPercent: 47, windowDurationMins: 10080 }, secondary: { usedPercent: 12, windowDurationMins: 300 } } }).map((w) => w.label)).toEqual(["Weekly", "Session"]);
    expect(parseUsage("codex", { rateLimits: { planType: "go", primary: { usedPercent: 80, resetsAt: null } } })[0].label).toBe("Monthly");
    expect(parseUsage("codex", { rateLimitsByLimitId: { codex: { limitId: "codex", individualLimit: { remainingPercent: 99, resetsAt: 1784500000 } } } })).toEqual([{ label: "Monthly credit limit", usedPercent: 1, resetsAt: 1784500000 }]);
    expect(parseUsage("codex", { rateLimits: { primary: { usedPercent: 5 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 42 }, secondary: null } } })).toEqual([{ label: "Session", usedPercent: 42, resetsAt: null }]);
  });
});

describe("a configured connection", () => {
  it("drives status and usage with its own binary and literal arguments, without inherited credentials", async () => {
    const bin = path.join(env.home, "custom-claude");
    fs.writeFileSync(
      bin,
      `#!/bin/sh
[ "$1" = '--connection' ] && [ "$2" = 'work account' ] || exit 9
shift 2
if [ "$1" = 'auth' ]; then
  printf '{"loggedIn":true,"email":"work@example.test","subscriptionType":"max","key":"%s"}\\n' "$ANTHROPIC_API_KEY"
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
    *phaethon-usage*) printf '%s\\n' '{"type":"control_response","response":{"subtype":"success","request_id":"phaethon-usage","response":{"rate_limits":{"five_hour":{"utilization":63,"resets_at":null}}}}}' ;;
  esac
done
`,
      { mode: 0o755 },
    );
    const saved = save(instance({ binary: bin, args: ["--connection", "work account"] }));
    const dir = home(saved)!;
    process.env.ANTHROPIC_API_KEY = "sk-parent";
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]) expect(cliCommand("claude", bin, env.home, dir).env[name]).toBeUndefined();
    expect(await account("claude", dir)).toEqual({ loggedIn: true, email: "work@example.test", plan: "max" });
    const u = await usage("claude", dir);
    expect(u).toEqual({ available: true, windows: [{ label: "5 hours", usedPercent: 63, resetsAt: null }], reason: null });
    delete process.env.ANTHROPIC_API_KEY;
    fs.chmodSync(bin, 0o644);
    expect((await usage("claude", dir)).reason).toBe("Assistant executable not found.");
    fs.chmodSync(bin, 0o755);
    expect(await call("agent_instance_usage", { id: "claude-work" })).toMatchObject({ available: true });
    expect(await usage("gemini", null)).toEqual({ available: false, windows: [], reason: "Gemini CLI does not expose account limits." });
  });

  it("can't switch off the read-only walls with its own arguments; full access lets them through", async () => {
    expect(wallBreakingArg("claude", ["--fallback-model", "sonnet", "--debug"])).toBeNull();
    expect(wallBreakingArg("claude", ["--dangerously-skip-permissions"])).toBe("--dangerously-skip-permissions");
    expect(wallBreakingArg("claude", ["--add-dir", "/"])).toBe("--add-dir");
    expect(wallBreakingArg("claude", ["--mcp-config=x.json"])).toBe("--mcp-config=x.json");
    expect(wallBreakingArg("claude", ["--fallback-model"])).toBe("--fallback-model");
    expect(wallBreakingArg("codex", ["-c", 'model_provider="ollama"', "--disable", "web_search"])).toBeNull();
    expect(wallBreakingArg("codex", ["-c", 'sandbox_mode="danger-full-access"'])).toBe('-c sandbox_mode="danger-full-access"');
    expect(wallBreakingArg("codex", ["--config=default_permissions=x"])).toBe("--config default_permissions=x");
    expect(wallBreakingArg("codex", ["--enable", "hooks"])).toBe("--enable");
    expect(wallBreakingArg("gemini", ["--yolo"])).toBe("--yolo");
    expect(wallBreakingArg("gemini", ["stray"])).toBe("stray");

    const log = new FakeLog(path.join(env.home, "fake-walls"));
    fs.mkdirSync(log.dir, { recursive: true });
    process.env.FAKE_DIR = log.dir;
    const fake = fakeBin(path.join(env.home, "bin"), "claude");
    const saved = save(instance({ id: "claude-risky", binary: fake, args: ["--dangerously-skip-permissions"] }));
    const dir = home(saved)!;
    const walled = await send(request("claude", "school", "hi", { configDir: dir }));
    expect(errors(walled)).toEqual([
      { code: "cli", message: "This connection’s launch arguments could let Claude Code change files or reach beyond the space, so nothing was sent: --dangerously-skip-permissions. Remove them in Settings › Assistant, or turn on full access for this space." },
    ]);
    expect(log.runs()).toBe(0);
    const full = await send(request("claude", "school", "hi", { configDir: dir, fullAccess: true }));
    expect(errors(full)).toEqual([]);
    expect(log.args(1)[0]).toBe("--dangerously-skip-permissions");
    expect(log.env(1).CLAUDE_CONFIG_DIR).toBe(dir);
    // A named connection's session is tagged with it.
    expect(fs.readFileSync(path.join(env.home, "Phaethon", "default", "spaces", "school", ".phaethon", "session"), "utf8")).toBe("claude-claude-risky:00000000-0000-0000-0000-000000000001\n");
  });
});
