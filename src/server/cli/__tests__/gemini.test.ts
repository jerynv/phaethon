import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../../tests/harness.ts";
import { cancel } from "../../core/runs.ts";
import { load } from "../../core/thread.ts";
import { INELIGIBLE_MESSAGE, OWN_SETTINGS_MESSAGE } from "../cli.ts";
import { acpArgs, acpArgsFull, geminiPrompt, permissionDecision, policyFile } from "../gemini.ts";
import { HISTORY_INTRO } from "../prompt.ts";
import { readCliSession, writeCliSession } from "../session.ts";
import { alive, errors, FakeLog, fakeBin, request, send, setup, shown, waitFor } from "./helpers.ts";

const env = tempHome("phaethon-cli-gemini-");
afterAll(() => env.cleanup());
let log: FakeLog;
let school: string;
let home: string;

beforeAll(() => {
  const s = setup(env.home, "gemini");
  log = new FakeLog(s.log);
  school = s.school;
  home = path.join(env.appData, "claude-config", "default-gemini");
  process.env.PHAETHON_GEMINI_BIN = fakeBin(path.join(env.home, "bin"), "gemini");
  process.env.GEMINI_SYSTEM_MD = "/somewhere/else.md";
});

const gemini = (prompt: string, extra = {}) => request("gemini", "school", prompt, { configDir: home, ...extra });

describe("Gemini CLI arguments", () => {
  it("are walled by a read-only policy, plan mode, no extensions or MCP; comma paths are left out", () => {
    const policy = policyFile(false);
    expect(fs.readFileSync(policy, "utf8")).toBe(
      '# Phaethon: Gemini CLI may only read and search the folders it is given.\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 900\n\n[[rule]]\ntoolName = ["read_file", "list_directory", "glob", "grep_search", "read_many_files"]\ndecision = "allow"\npriority = 950\n',
    );
    expect(path.dirname(policy)).toBe(path.join(os.tmpdir(), "phaethon-gemini"));
    if (process.platform !== "win32") expect(fs.statSync(path.dirname(policy)).mode & 0o777).toBe(0o700);
    const args = acpArgs(policy, ["/v/work", "/v/a,b"], "flash");
    expect(args).toEqual(["--acp", "--approval-mode", "plan", "--extensions", "none", "--allowed-mcp-server-names", "phaethon-none", "--admin-policy", policy, "--policy", policy, "--model", "flash", "--include-directories", "/v/work"]);
    expect(acpArgsFull("/home/s", null)).toEqual(["--acp", "--approval-mode", "yolo", "--extensions", "none", "--allowed-mcp-server-names", "phaethon-none", "--include-directories", "/home/s"]);
    expect(fs.readFileSync(policyFile(true), "utf8")).toBe('# Phaethon: no tools.\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n');
  });

  it("wrap the mode before the message and escape a leading slash", () => {
    expect(geminiPrompt("MODE", "/quit")).toBe("<phaethon_tutor_mode>\nMODE\n</phaethon_tutor_mode>\n\n /quit");
    expect(geminiPrompt(null, "hi")).toBe("hi");
  });

  it("allow only reads inside the folders the turn may see", () => {
    const roots = [school];
    expect(permissionDecision({ kind: "read", locations: [{ path: path.join(school, "a.md") }] }, roots, false)).toBe("allow");
    expect(permissionDecision({ kind: "read", locations: [{ path: "/etc/passwd" }] }, roots, false)).toBe("deny");
    expect(permissionDecision({ kind: "read", locations: [{ path: path.join(school, "..", "work", "x") }] }, roots, false)).toBe("deny");
    expect(permissionDecision({ kind: "edit", locations: [{ path: path.join(school, "a.md") }] }, roots, false)).toBe("deny");
    expect(permissionDecision({ kind: "execute" }, roots, false)).toBe("deny");
    expect(permissionDecision({ kind: "execute" }, roots, true)).toBe("allow");
  });
});

describe("Gemini CLI conversations", () => {
  it("run over ACP in the vault's home, trusted for the run, the prompt only in session/prompt, and resume", async () => {
    fs.writeFileSync(path.join(school, "notes.md"), "secret notes");
    const events = await send(gemini("tools please", { model: "flash" }));
    expect(errors(events)).toEqual([]);
    const session = "66666666-6666-4666-8666-000000000001";
    expect(events.at(-1)).toEqual({ kind: "end", sessionId: session });
    expect(log.env(1)).toMatchObject({ GEMINI_CLI_HOME: home, GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_SYSTEM_MD: null, cwd: school });
    expect(log.args(1)[0]).toBe("--acp");
    expect(log.flag(1, "--model")).toBe("flash");
    expect(log.args(1).join(" ")).not.toContain("tools please");
    const prompt = log.text("prompt-1");
    expect(prompt.startsWith("<phaethon_tutor_mode>\n# Getting it right") && prompt.includes("# A quiz or flashcards from the chat")).toBe(true);
    expect(prompt.endsWith("</phaethon_tutor_mode>\n\ntools please")).toBe(true);
    // Reads inside allowed, the write and the read outside refused.
    expect(JSON.parse(log.text("permissions-1.json"))).toEqual({
      readInside: { outcome: { outcome: "selected", optionId: "yes" } },
      write: { outcome: { outcome: "selected", optionId: "no" } },
      readOutside: { outcome: { outcome: "selected", optionId: "no" } },
    });
    expect(log.rpc(1).find((m) => m.method === "initialize")?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    expect(fs.readFileSync(path.join(school, ".phaethon", "session"), "utf8")).toBe(`gemini:${session}\n`);
    expect(shown("school")).toEqual([
      ["user", "tools please"],
      ["assistant", "Reply 1."],
    ]);
    const records = load("school").at(-1)!.content.filter((b) => b.type === "phaethon_record");
    expect(records).toEqual([
      { type: "phaethon_record", kind: "tool", id: "gemini:read-1", category: "read", label: "Reading file", target: "notes.md", status: "success" },
      { type: "phaethon_record", kind: "tool", id: "gemini:grep-1", category: "search", label: "Searching", status: "failed", detail: "Tool reported an error" },
    ]);
    expect(JSON.stringify(load("school"))).not.toContain("secret notes");

    const again = await send(gemini("And then?"));
    expect(errors(again)).toEqual([]);
    expect(log.rpc(2).find((m) => m.method === "session/load")?.params).toMatchObject({ sessionId: session, cwd: school, mcpServers: [] });
    // The history the agent replays while loading is not this turn's reply.
    expect(shown("school").at(-1)).toEqual(["assistant", "Reply 2."]);
  });

  it("start afresh with the conversation when the session can't be loaded; never resume Claude's", async () => {
    fs.writeFileSync(path.join(log.dir, "stale"), `${readCliSession(school, "gemini")}\n`);
    const n = log.runs();
    expect(errors(await send(gemini("Still there?")))).toEqual([]);
    expect(log.runs()).toBe(n + 2);
    expect(log.rpc(n + 2).some((m) => m.method === "session/new")).toBe(true);
    expect(log.text(`prompt-${n + 2}`)).toContain(HISTORY_INTRO);
    fs.rmSync(path.join(log.dir, "stale"));
    writeCliSession(school, null, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const m = log.runs() + 1;
    await send(gemini("Fresh?"));
    expect(log.rpc(m).some((x) => x.method === "session/load")).toBe(false);
  });

  it("say a signed-out Gemini CLI isn't signed in, and explain an ineligible account", async () => {
    process.env.FAKE_LOGGED_IN = "0";
    const signedOut = [{ code: "notLoggedIn", message: "Gemini CLI isn’t signed in for this Phaethon folder yet. Sign in to it in Settings › Assistant, then send your message again." }];
    // Resuming (session/load) and starting afresh (session/new) both say so.
    expect(readCliSession(school, "gemini")).not.toBeNull();
    expect(errors(await send(gemini("hello")))).toEqual(signedOut);
    fs.rmSync(path.join(school, ".phaethon", "session"));
    expect(errors(await send(gemini("hello")))).toEqual(signedOut);
    delete process.env.FAKE_LOGGED_IN;
    expect(errors(await send(gemini("ineligible")))).toEqual([{ code: "cli", message: INELIGIBLE_MESSAGE }]);
  });

  it("cancel the prompt on stop, keep the partial reply, and end the agent", async () => {
    const n = log.runs() + 1;
    const events = await send(gemini("slow please"), (e) => {
      if (e.kind === "text") setTimeout(() => cancel("school"), 10);
    });
    expect(events.slice(-2)).toEqual([{ kind: "cancelled" }, { kind: "end", sessionId: readCliSession(school, "gemini") }]);
    expect(log.rpc(n).some((m) => m.method === "session/cancel")).toBe(true);
    expect(load("school").at(-1)!.content).toEqual([{ type: "text", text: "Partial" }, { type: "phaethon_record", kind: "stopped" }]);
    expect(await waitFor(() => !alive(Number(log.text(`pid-${n}`))))).toBe(true);
  });

  it("refuse a working folder with its own .gemini, recording nothing", async () => {
    fs.mkdirSync(path.join(school, ".gemini"));
    const before = load("school").length;
    const n = log.runs();
    const events = await send(gemini("hi"));
    expect(events).toEqual([
      { kind: "error", code: "cli", message: OWN_SETTINGS_MESSAGE },
      { kind: "end", sessionId: null },
    ]);
    expect(load("school").length).toBe(before);
    expect(log.runs()).toBe(n);
    fs.rmdirSync(path.join(school, ".gemini"));
  });

  it("refuse any reasoning level", async () => {
    const events = await send(gemini("hi", { reasoning: "high" }));
    expect(errors(events)).toEqual([{ code: "cli", message: "That assistant does not support this reasoning level." }]);
  });
});
