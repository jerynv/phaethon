import fs from "node:fs";
import { THREAD } from "./helpers.ts";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../shared/agent.ts";
import type { Message } from "../../core/thread.ts";
import { cliOfBackend, isValidCliModel, lastLine, loginCommand, notLoggedInMessage, NOT_LOGGED_IN_MESSAGE, stderrSummary, validReasoning } from "../cli.ts";
import { JsonRpcPeer, RpcError } from "../jsonrpc.ts";
import { transcript } from "../prompt.ts";
import { clearSession, readCliSession, sessionUuid, writeCliSession } from "../session.ts";
import { commandLabel, commandLine, place, shownPath, ToolLog, toolStartEvent } from "../tools.ts";
import { classifyCliError } from "../turn.ts";
import { PassThrough } from "node:stream";

describe("tool records", () => {
  it("close unmatched starts truthfully, and only once", () => {
    for (const terminal of ["cancelled", "failed", "incomplete"] as const) {
      const log = new ToolLog();
      const events: AgentEvent[] = [];
      const push = (e: AgentEvent) => events.push(e);
      log.emit(toolStartEvent("read-1", "read", { file_path: "/vault/spaces/school/notes.md" }, "/vault/spaces/school", []), push);
      log.emit({ kind: "text", delta: "Assistant text is not proof of tool success" }, push);
      expect(log.records).toEqual([]);
      log.close(terminal, push);
      expect(log.records).toEqual([{ kind: "tool", id: "read-1", category: "read", label: "Reading file", target: "notes.md", status: terminal }]);
      const count = events.length;
      log.close("success", push);
      expect(events.length).toBe(count);
    }
  });

  it("name paths by the space or the granted folder they are in", () => {
    const granted = [{ label: "work/calendar", path: "/vault/spaces/work/calendar" }];
    expect(place("Reading", "/vault/spaces/school/a/b.md", "/vault/spaces/school", granted)).toBe("Reading file a/b.md");
    expect(place("Reading", "/vault/spaces/work/calendar/oct.md", "/vault/spaces/school", granted)).toBe("Reading work/calendar/oct.md");
    expect(shownPath("/vault/spaces/school", "/vault/spaces/school", granted).shown).toBe(".");
    expect(shownPath("/vault/spaces/schoolwork/x", "/vault/spaces/school", []).shown).toBe("/vault/spaces/schoolwork/x");
  });
});

describe("command lines", () => {
  const base = "/vault/spaces/school";
  it("come from each agent's own input shape, without the shell they were wrapped in", () => {
    // Claude Code's Bash and Gemini CLI's run_shell_command: { command: string }.
    expect(commandLine({ command: "git status --short", description: "Show changes" }, base, [])).toBe("git status --short");
    // Codex: a string wrapped in a login shell, or an argv list.
    expect(commandLine({ command: "/bin/bash -lc 'cat /vault/spaces/school/notes.md'" }, base, [])).toBe("cat notes.md");
    expect(commandLine({ command: ["/bin/zsh", "-lc", "ls -la"] }, base, [])).toBe("ls -la");
    expect(commandLine({ command: ["rg", "-n", "two words", "notes"] }, base, [])).toBe("rg -n 'two words' notes");
    expect(commandLine({ cmd: "pnpm test" }, base, [])).toBe("pnpm test");
    // Other shells and quoting.
    expect(commandLine({ command: "bash -l -c \"echo \\\"hi\\\"\"" }, base, [])).toBe('echo "hi"');
    expect(commandLine({ command: "sh -c 'echo it'\\''s'" }, base, [])).toBe("echo it's");
    expect(commandLine({ command: "pwsh -NoProfile -Command Get-ChildItem" }, base, [])).toBe("Get-ChildItem");
    // Not a shell running a script: kept as it is.
    expect(commandLine({ command: "python -c 'print(1)'" }, base, [])).toBe("python -c 'print(1)'");
    expect(commandLine({ command: "bash build.sh" }, base, [])).toBe("bash build.sh");
    // A script over several lines keeps its line breaks.
    expect(commandLine({ command: "bash -lc 'cd /vault/spaces/school\nls'" }, base, [])).toBe("cd .\nls");
    // Paths in a granted folder read by its name; others stay.
    expect(commandLine({ command: "cat /vault/spaces/work/calendar/oct.md /etc/hosts" }, base, [{ label: "work/calendar", path: "/vault/spaces/work/calendar" }])).toBe("cat work/calendar/oct.md /etc/hosts");
    expect(commandLine({ description: "no command here" }, base, [])).toBeUndefined();
    expect(commandLine({ command: "   " }, base, [])).toBeUndefined();
  });

  it("are a command step's target and status line, never the word 'command'", () => {
    const log = new ToolLog();
    const events: AgentEvent[] = [];
    log.emit(toolStartEvent("cmd-1", "command", { command: "ls notes" }, base, []), (e) => events.push(e));
    log.emit({ kind: "toolEnd", id: "cmd-1", status: "success", detail: "week6.md" }, (e) => events.push(e));
    expect(log.records).toEqual([{ kind: "tool", id: "cmd-1", category: "command", label: "Running command", target: "ls notes", status: "success", detail: "week6.md" }]);
    expect(commandLabel("ls  notes\n| head")).toBe("Running ls notes | head");
    expect(commandLabel(undefined)).toBe("Running a command");
  });
});

describe("plain helpers", () => {
  it("accept plain model names only", () => {
    for (const ok of ["gpt-5.5", "gemini-2.5-pro", "o3", "gpt-5-codex", "claude-opus-5-5"]) expect(isValidCliModel(ok)).toBe(true);
    for (const bad of ["", "-m", "--yolo", "a b", "x;rm", "../x", "a".repeat(101), "ü"]) expect(isValidCliModel(bad)).toBe(false);
  });

  it("find the error line in stderr, not the stack", () => {
    const gemini =
      "Error authenticating: IneligibleTierError: This client is no longer supported.\n    at throwIneligible (file:///x.js:1:1)\n  ineligibleTiers: [\n  ]\n}\nAn unexpected critical error occurred:IneligibleTierError: This client is no longer supported.\n    at _doSetupUser (file:///x.js:2:2)\n";
    expect(stderrSummary(gemini)).toBe("An unexpected critical error occurred:IneligibleTierError: This client is no longer supported.");
    expect(stderrSummary("boom\n\n")).toBe("boom");
    expect(stderrSummary("")).toBe("");
    expect(lastLine("a\nb  \n\n")).toBe("b");
  });

  it("say how each CLI signs in, in its own words", () => {
    expect(notLoggedInMessage("claude", null)).toBe(NOT_LOGGED_IN_MESSAGE);
    for (const cli of ["codex", "gemini"] as const) {
      const said = notLoggedInMessage(cli, "/x/default-codex");
      expect(said).toMatch(/isn’t signed in for this Phaethon folder.*Settings › AI & Models/);
      expect(said).not.toContain("/x/");
    }
    expect(notLoggedInMessage("claude", "/x/default")).toBe(NOT_LOGGED_IN_MESSAGE);
    expect(loginCommand("codex", "/x/default-codex")).toBe('CODEX_HOME="/x/default-codex" codex login');
    expect(loginCommand("claude", null)).toBe("claude");
    expect(cliOfBackend("phaethon")).toBeNull();
    expect(cliOfBackend("gemini-cli")).toBe("gemini");
    expect(validReasoning("claude", "ultra")).toBe(false);
    expect(validReasoning("codex", "ultra")).toBe(true);
    expect(validReasoning("gemini", "high")).toBe(false);
  });

  it("keep sessions per CLI and instance, refusing malformed ids", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-session-"));
    const id = "11111111-2222-3333-4444-555555555555";
    expect(readCliSession(dir, THREAD, null)).toBeNull();
    writeCliSession(dir, THREAD, "codex", id);
    expect(fs.readFileSync(path.join(dir, ".phaethon", "threads", `${THREAD}.session`), "utf8")).toBe(`codex:${id}\n`);
    expect(readCliSession(dir, THREAD, "codex")).toBe(id);
    expect(readCliSession(dir, THREAD, null)).toBeNull();
    expect(readCliSession(dir, THREAD, "gemini")).toBeNull();
    expect(sessionUuid(`claude-claude-work:${id}`)).toBe(id);
    expect(() => writeCliSession(dir, THREAD, null, "--resume")).toThrow("refusing to save a malformed session id");
    clearSession(dir, THREAD);
    expect(readCliSession(dir, THREAD, "codex")).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  it("hand over long conversations by their end", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "phaethon_attachment", path: "a.pdf", name: "a.pdf", media_type: "application/pdf" }, { type: "text", text: " hi " }] },
      { role: "assistant", content: [{ type: "text", text: "x".repeat(130_000) + "é" }] },
    ];
    const t = transcript(msgs);
    expect(t.startsWith("[The start of the conversation is left out.]\n\n")).toBe(true);
    expect(t.endsWith("é\n\n")).toBe(true);
    expect(transcript(msgs.slice(0, 1))).toBe("User: [attached: a.pdf] hi\n\n");
  });

  it("budget multi-turn handoffs to ~48 KB while keeping the opening request and newest turns", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "OPENING_GOAL: explain Maxwell equations" }] },
      { role: "assistant", content: [{ type: "text", text: "first reply " + "a".repeat(20_000) }] },
      { role: "user", content: [{ type: "text", text: "MIDDLE_TURN: " + "b".repeat(25_000) }] },
      { role: "assistant", content: [{ type: "text", text: "middle reply " + "c".repeat(25_000) }] },
      { role: "user", content: [{ type: "text", text: "RECENT_QUESTION: what about Faraday?" }] },
      { role: "assistant", content: [{ type: "text", text: "RECENT_ANSWER: curl E = -dB/dt" }] },
    ];
    const t = transcript(msgs);
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(49_000);
    expect(t).toContain("OPENING_GOAL: explain Maxwell equations");
    expect(t).toContain("[Earlier turns in the middle of the conversation were left out.]");
    expect(t).not.toContain("MIDDLE_TURN");
    expect(t).toContain("RECENT_QUESTION: what about Faraday?");
    expect(t).toContain("RECENT_ANSWER: curl E = -dB/dt");
  });

  it("classify CLI connectivity, rate limit, and availability errors", () => {
    expect(classifyCliError("Gemini CLI timed out while connecting to Google.", "")).toBe("network");
    expect(classifyCliError("fetch failed: ECONNREFUSED 127.0.0.1:443", "")).toBe("network");
    expect(classifyCliError("HTTP 429 RESOURCE_EXHAUSTED quota exceeded", "")).toBe("rateLimit");
    expect(classifyCliError("503 Service Unavailable: backend overloaded", "")).toBe("unavailable");
    expect(classifyCliError("unexpected flag", "plain stderr")).toBe("cli");
  });
});

describe("JSON-RPC over stdio", () => {
  it("correlate answers, answer the peer's requests, and fail pending requests when it ends", async () => {
    const toPeer = new PassThrough();
    const fromPeer = new PassThrough();
    const notes: string[] = [];
    const peer = new JsonRpcPeer(toPeer, fromPeer, {
      jsonrpc: true,
      onNotification: (m) => notes.push(m),
      onRequest: (m) => {
        if (m === "ask") return { ok: true };
        throw new RpcError(-32601, "no");
      },
    });
    const sent: Record<string, unknown>[] = [];
    toPeer.setEncoding("utf8");
    toPeer.on("data", (d: string) => d.trim().split("\n").forEach((l) => sent.push(JSON.parse(l))));
    const answer = peer.request("initialize", { a: 1 });
    await new Promise((r) => setImmediate(r));
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } });
    fromPeer.write('not json\n{"jsonrpc":"2.0","method":"note","params":{}}\n{"jsonrpc":"2.0","id":7,"method":"ask"}\n{"jsonrpc":"2.0","id":8,"method":"other"}\n{"id":1,"result":{"done":true}}\n');
    expect(await answer).toEqual({ done: true });
    await new Promise((r) => setImmediate(r));
    expect(notes).toEqual(["note"]);
    expect(sent.find((m) => m.id === 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    expect(sent.find((m) => m.id === 8)).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "no" } });
    const failing = peer.request("x", null);
    fromPeer.write('{"id":2,"error":{"code":-32600,"message":"no rollout found for thread id t"}}\n');
    await expect(failing).rejects.toMatchObject({ code: -32600, message: "no rollout found for thread id t" });
    const pending = peer.request("y", null);
    fromPeer.end();
    await expect(pending).rejects.toThrow("The assistant closed its connection.");
  });
});
