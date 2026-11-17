import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { call, tempHome } from "../../../../tests/harness.ts";
import { claim, release } from "../../core/runs.ts";
import "../commands.ts";
import { fetchScript, installCli, installerUrl, installRunKey, isOfficial, type FetchScript } from "../install.ts";
import { claudeLoginArgs, signInEmail } from "../signin.ts";
import { waitFor } from "./helpers.ts";

const env = tempHome("phaethon-cli-install-");
const win = process.platform === "win32";
const saved = { PATH: process.env.PATH, claude: process.env.PHAETHON_CLAUDE_BIN, codex: process.env.PHAETHON_CODEX_BIN };

beforeAll(() => {
  // No real Claude Code on PATH and no fake: the test home is the only place it can appear.
  delete process.env.PHAETHON_CLAUDE_BIN;
  delete process.env.PHAETHON_CODEX_BIN;
  process.env.PATH = win ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
});
afterAll(() => {
  process.env.PATH = saved.PATH;
  if (saved.claude) process.env.PHAETHON_CLAUDE_BIN = saved.claude;
  if (saved.codex) process.env.PHAETHON_CODEX_BIN = saved.codex;
  env.cleanup();
});
afterEach(() => fs.rmSync(path.join(env.home, ".local"), { recursive: true, force: true }));

const seen = path.join(env.home, "seen.txt");

/** A stand-in for claude.ai/install.sh: records what it was given, then puts `claude` where the real one does. */
function installs(): FetchScript {
  return async () =>
    win
      ? [
          `Set-Content -Path '${seen}' -Value "$env:CODEX_NON_INTERACTIVE|$env:HOME"`,
          `New-Item -ItemType Directory -Force -Path "$env:HOME\\.local\\bin" | Out-Null`,
          `Set-Content -Path "$env:HOME\\.local\\bin\\claude.cmd" -Value "@echo off"`,
        ].join("\r\n")
      : ["#!/bin/sh", `printf '%s|%s' "$CODEX_NON_INTERACTIVE" "$HOME" > '${seen}'`, 'mkdir -p "$HOME/.local/bin"', 'printf "#!/bin/sh\\n" > "$HOME/.local/bin/claude"', 'chmod +x "$HOME/.local/bin/claude"'].join("\n");
}

/** A fetch Response that arrived from `url` (after redirects), which a plain Response can't be given. */
function reply(body: string, url: string, status = 200): Response {
  const r = new Response(body, { status });
  Object.defineProperty(r, "url", { value: url });
  return r;
}

const script = (lines: { unix: string[]; win: string[] }): FetchScript => async () => (win ? lines.win.join("\r\n") : ["#!/bin/sh", ...lines.unix].join("\n"));

describe("installing a coding agent", () => {
  it("only trusts each company's own https addresses", () => {
    expect(installerUrl("claude", "darwin")).toBe("https://claude.ai/install.sh");
    expect(installerUrl("claude", "win32")).toBe("https://claude.ai/install.ps1");
    expect(installerUrl("codex", "linux")).toBe("https://chatgpt.com/codex/install.sh");
    expect(installerUrl("codex", "win32")).toBe("https://chatgpt.com/codex/install.ps1");
    expect(isOfficial("claude", "https://downloads.claude.ai/claude-code-releases/bootstrap.sh")).toBe(true);
    expect(isOfficial("claude", "http://claude.ai/install.sh")).toBe(false);
    expect(isOfficial("claude", "https://claude.ai.example.com/install.sh")).toBe(false);
    expect(isOfficial("claude", "https://chatgpt.com/codex/install.sh")).toBe(false);
    expect(isOfficial("codex", "https://releases.openai.com/codex/install.sh")).toBe(true);
    expect(isOfficial("codex", "https://evilchatgpt.com/codex/install.sh")).toBe(false);
    expect(isOfficial("codex", "not a url")).toBe(false);
  });

  it("refuses an installer that was redirected elsewhere or isn't a script", async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => reply("#!/bin/sh\n", "https://example.com/install.sh")) as typeof fetch;
      await expect(fetchScript("claude", "darwin", new AbortController().signal)).rejects.toThrow("Claude Code’s installer came from an address Phaethon doesn’t trust.");
      globalThis.fetch = vi.fn(async () => reply("<html>sign in</html>", "https://claude.ai/install.sh")) as typeof fetch;
      await expect(fetchScript("claude", "darwin", new AbortController().signal)).rejects.toThrow("What came back wasn’t Claude Code’s installer.");
      globalThis.fetch = vi.fn(async () => reply("nope", "https://chatgpt.com/codex/install.sh", 503)) as typeof fetch;
      await expect(fetchScript("codex", "linux", new AbortController().signal)).rejects.toThrow("Codex’s installer couldn’t be downloaded (503).");
      globalThis.fetch = vi.fn(async () => reply("#!/bin/sh\necho ok\n", "https://downloads.claude.ai/claude-code-releases/bootstrap.sh")) as typeof fetch;
      expect(await fetchScript("claude", "darwin", new AbortController().signal)).toBe("#!/bin/sh\necho ok\n");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("runs the installer in the person's home without prompts, then finds the CLI", async () => {
    expect(await installCli("claude", installs())).toEqual({ status: "installed", message: "Claude Code is installed." });
    expect(fs.readFileSync(seen, "utf8").trim()).toBe(`1|${env.home}`);
    expect(await installCli("claude", installs())).toEqual({ status: "installed", message: "Claude Code is already installed." });
  });

  it("says why an installer failed, without its colour codes", async () => {
    const failing = script({ unix: ["printf '\\033[0;31mError: not enough disk space\\033[0m\\n' >&2", "exit 3"], win: ["[Console]::Error.WriteLine('Error: not enough disk space')", "exit 3"] });
    expect(await installCli("claude", failing)).toEqual({ status: "failed", message: "Claude Code couldn’t be installed: Error: not enough disk space" });
    expect(await installCli("claude", script({ unix: ["exit 0"], win: ["exit 0"] }))).toEqual({
      status: "failed",
      message: "Claude Code’s installer finished, but Phaethon can’t find claude yet. Check again in a moment.",
    });
    expect(await installCli("claude", async () => Promise.reject(new Error("Claude Code’s installer couldn’t be downloaded (500).")))).toEqual({
      status: "failed",
      message: "Claude Code’s installer couldn’t be downloaded (500).",
    });
  });

  it("stops promptly, and only one install of a CLI runs at a time", async () => {
    const marker = path.join(env.home, "started");
    const hangs = script({ unix: [`touch '${marker}'`, "sleep 60"], win: [`Set-Content -Path '${marker}' -Value x`, "Start-Sleep -Seconds 60"] });
    const pending = installCli("claude", hangs);
    expect(await waitFor(() => fs.existsSync(marker), 15000)).toBe(true);
    expect(await installCli("claude", installs())).toEqual({ status: "busy", message: "Claude Code is already being installed." });
    const started = Date.now();
    expect(await call("agent_cli_install_cancel", { cli: "claude" })).toBe(true);
    expect(await pending).toEqual({ status: "cancelled", message: "Installing Claude Code was stopped." });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await call("agent_cli_install_cancel", { cli: "claude" })).toBe(false);
  });

  it("leaves Gemini CLI to npm and refuses anything that isn't a coding agent", async () => {
    expect(await call("agent_cli_install", { cli: "gemini" })).toEqual({ status: "unsupported", message: "Gemini CLI has no installer Phaethon can run. Install it with npm, then check again." });
    await expect(call("agent_cli_install", { cli: "rm -rf" })).rejects.toThrow("Unknown coding agent.");
    const held = claim(installRunKey("claude"))!;
    expect(await call("agent_cli_install", { cli: "claude" })).toEqual({ status: "busy", message: "Claude Code is already being installed." });
    release(held);
  });
});

describe("signing in through a school", () => {
  it("adds Claude Code's own SSO flag and email, and nothing else", () => {
    expect(claudeLoginArgs()).toEqual(["auth", "login"]);
    expect(claudeLoginArgs({ sso: true })).toEqual(["auth", "login", "--sso"]);
    expect(claudeLoginArgs({ sso: true, email: "sam@school.edu" })).toEqual(["auth", "login", "--sso", "--email", "sam@school.edu"]);
  });

  it("accepts a real-looking email and refuses anything that could be read as a flag", () => {
    expect(signInEmail(undefined)).toBeUndefined();
    expect(signInEmail("")).toBeUndefined();
    expect(signInEmail("  sam@school.edu ")).toBe("sam@school.edu");
    for (const bad of ["--console", "-x@a.b", "sam", "sam@school", "sam @school.edu", `${"a".repeat(250)}@b.edu`]) expect(() => signInEmail(bad)).toThrow("That doesn’t look like an email address.");
  });
});
