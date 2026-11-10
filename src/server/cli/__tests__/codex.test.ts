import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../../tests/harness.ts";
import { cancel } from "../../core/runs.ts";
import { load } from "../../core/thread.ts";
import { CODEX_MISSING_MESSAGE } from "../cli.ts";
import { answerServerRequest, appServerArgs, appServerArgsFull, CodexItems, commandLabel, DISABLED_FEATURES } from "../codex.ts";
import { HISTORY_INTRO } from "../prompt.ts";
import { readCliSession, writeCliSession } from "../session.ts";
import { alive, errors, FakeLog, fakeBin, request, send, setup, shown, waitFor } from "./helpers.ts";

const env = tempHome("phaethon-cli-codex-");
afterAll(() => env.cleanup());
let log: FakeLog;
let school: string;
let home: string;

beforeAll(() => {
  const s = setup(env.home, "codex");
  log = new FakeLog(s.log);
  school = s.school;
  home = path.join(env.appData, "claude-config", "default-codex");
  process.env.PHAETHON_CODEX_BIN = fakeBin(path.join(env.home, "bin"), "codex");
  process.env.CODEX_THREAD_ID = "parent-thread";
});

const codex = (prompt: string, extra = {}) => request("codex", "school", prompt, { configDir: home, ...extra });

describe("Codex app-server arguments", () => {
  it("grant read only, over a profile, with every risky feature off; never --add-dir or --sandbox", () => {
    const args = appServerArgs(["/vault/spaces/school", '/odd "dir"\\x']);
    expect(args[0]).toBe("app-server");
    const joined = args.join(" ");
    expect(joined).toContain('-c approval_policy="never" -c web_search="disabled" -c default_permissions="phaethon"');
    expect(args).toContain('permissions.phaethon.filesystem={":minimal"="read","/vault/spaces/school"="read","/odd \\"dir\\"\\\\x"="read"}');
    expect(args).toContain("mcp_servers={}");
    for (const f of DISABLED_FEATURES) expect(joined).toContain(`--disable ${f}`);
    expect(args.some((a) => a === "--add-dir" || a === "--sandbox" || a === "-s" || a.includes("write"))).toBe(false);
    const full = appServerArgsFull();
    expect(full).not.toContain('default_permissions="phaethon"');
    expect(full).toContain("project_doc_max_bytes=0");
  });

  it("label commands without the shell and show paths as in the space", () => {
    expect(commandLabel("/bin/zsh -lc 'cat /vault/spaces/school/notes.md'", "/vault/spaces/school", [])).toBe("Running cat notes.md");
    expect(commandLabel("ls", "/vault/spaces/school", [])).toBe("Running ls");
  });

  it("decline every approval in a walled turn and never handle credentials", () => {
    expect(answerServerRequest("item/commandExecution/requestApproval", false)).toEqual({ decision: "decline" });
    expect(answerServerRequest("item/fileChange/requestApproval", false)).toEqual({ decision: "decline" });
    expect(answerServerRequest("item/permissions/requestApproval", false)).toEqual({ permissions: {}, scope: "turn" });
    expect(answerServerRequest("item/commandExecution/requestApproval", true)).toEqual({ decision: "accept" });
    expect(() => answerServerRequest("account/chatgptAuthTokens/refresh", false)).toThrow();
  });

  it("map item statuses truthfully, with no command output", () => {
    const items = new CodexItems("/s", []);
    const cmd = { type: "commandExecution", id: "c1", command: "ls", status: "inProgress", exitCode: null };
    expect(items.started(cmd).map((e) => e.kind)).toEqual(["tool", "toolStart"]);
    expect(items.completed({ ...cmd, status: "completed", exitCode: null, aggregatedOutput: "secret" })).toEqual([{ kind: "toolEnd", id: "codex:c1", status: "incomplete" }]);
    const fast = items.completed({ type: "commandExecution", id: "c2", command: "false", status: "failed", exitCode: 1 });
    expect(fast.at(-1)).toEqual({ kind: "toolEnd", id: "codex:c2", status: "failed", detail: "Exit code 1" });
    expect(items.completed({ type: "reasoning", id: "r" })).toEqual([]);
  });
});

describe("Codex conversations", () => {
  it("run in the vault's home, read-only, with the prompt only in the turn, and resume their thread", async () => {
    fs.writeFileSync(path.join(school, "notes.md"), "secret notes");
    const events = await send(codex("tools please", { model: "gpt-6.1-sol", reasoning: "ultra" }));
    expect(errors(events)).toEqual([]);
    const thread = "01a1c78a-7149-7ba2-b0b6-000000000001";
    expect(events.at(-1)).toEqual({ kind: "end", sessionId: thread });
    expect(log.env(1).CODEX_HOME).toBe(home);
    expect(log.env(1).CODEX_THREAD_ID).toBeNull();
    expect(log.env(1).cwd).toBe(school);
    expect(log.args(1)[0]).toBe("app-server");
    expect(log.args(1).join(" ")).not.toContain("tools please");
    expect(log.args(1).some((a) => a.startsWith("permissions.phaethon.filesystem=") && a.includes(JSON.stringify(school)))).toBe(true);
    const rpc = log.rpc(1);
    expect(rpc.map((m) => m.method).filter(Boolean)).toEqual(["initialize", "initialized", "account/read", "thread/start", "turn/start"]);
    const start = rpc.find((m) => m.method === "thread/start")!.params!;
    expect(start).toMatchObject({ cwd: school, approvalPolicy: "never", model: "gpt-6.1-sol", ephemeral: false });
    expect(start.sandbox).toBeUndefined();
    expect(String(start.developerInstructions)).toMatch(/^# Getting it right[\s\S]*# Explaining something[\s\S]*# A quiz or flashcards from the chat/);
    const turn = rpc.find((m) => m.method === "turn/start")!.params!;
    expect(turn).toMatchObject({ threadId: thread, effort: "ultra", input: [{ type: "text", text: "tools please", text_elements: [] }] });
    // The approval Codex asked for was declined.
    expect(rpc.find((m) => m.id === 1000)?.result).toEqual({ decision: "decline" });
    expect(readCliSession(school, "codex")).toBe(thread);
    expect(fs.readFileSync(path.join(school, ".phaethon", "session"), "utf8")).toBe(`codex:${thread}\n`);
    // Text streamed in order, a second message after a blank line; the failed command and the search recorded without output.
    expect(shown("school")).toEqual([
      ["user", "tools please"],
      ["assistant", "Reply 1.\n\nSecond part."],
    ]);
    const saved = load("school").at(-1)!.content.filter((b) => b.type === "phaethon_record");
    expect(saved).toEqual([
      { type: "phaethon_record", kind: "tool", id: "codex:call_1", category: "command", label: "Running command", status: "failed", detail: "Exit code 1" },
      { type: "phaethon_record", kind: "tool", id: "codex:ws_1", category: "search", label: "Searching", status: "success" },
    ]);
    expect(JSON.stringify(load("school"))).not.toContain("private output");
    expect(await waitFor(() => !alive(Number(log.text("pid-1"))))).toBe(true);

    const again = await send(codex("And then?"));
    expect(errors(again)).toEqual([]);
    expect(log.rpc(2).find((m) => m.method === "thread/resume")?.params).toMatchObject({ threadId: thread, cwd: school });
    expect(log.rpc(2).find((m) => m.method === "turn/start")?.params).toMatchObject({ input: [{ type: "text", text: "And then?" }] });
  });

  it("start afresh with the conversation as text when the thread is gone", async () => {
    const thread = readCliSession(school, "codex")!;
    fs.writeFileSync(path.join(log.dir, "stale"), `${thread}\n`);
    const n = log.runs();
    const events = await send(codex("Still there?"));
    expect(errors(events)).toEqual([]);
    expect(log.runs()).toBe(n + 2);
    const text = String((log.rpc(n + 2).find((m) => m.method === "turn/start")!.params!.input as { text: string }[])[0].text);
    expect(text.startsWith(HISTORY_INTRO)).toBe(true);
    expect(text.endsWith("The user's new message:\n\nStill there?")).toBe(true);
    fs.rmSync(path.join(log.dir, "stale"));
  });

  it("never resume another CLI's session", async () => {
    writeCliSession(school, null, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const n = log.runs() + 1;
    await send(codex("Fresh?"));
    expect(log.rpc(n).some((m) => m.method === "thread/resume")).toBe(false);
  });

  it("say a signed-out Codex isn't signed in, before any turn", async () => {
    process.env.FAKE_LOGGED_IN = "0";
    const n = log.runs() + 1;
    const events = await send(codex("hello"));
    delete process.env.FAKE_LOGGED_IN;
    expect(errors(events)).toEqual([{ code: "notLoggedIn", message: "Codex isn’t signed in for this Phaethon folder yet. Sign in to it in Settings › Assistant, then send your message again." }]);
    expect(log.rpc(n).some((m) => m.method === "turn/start")).toBe(false);
  });

  it("map a 401 during the turn to notLoggedIn", async () => {
    const events = await send(codex("unauthorized"));
    expect(errors(events).map((e) => e.code)).toEqual(["notLoggedIn"]);
  });

  it("interrupt the turn on stop, keep the partial reply, and end the server", async () => {
    const n = log.runs() + 1;
    const before = readCliSession(school, "codex");
    const events = await send(codex("slow please"), (e) => {
      if (e.kind === "text") setTimeout(() => cancel("school"), 10);
    });
    expect(events.slice(-3)).toEqual([{ kind: "record", record: { kind: "stopped" } }, { kind: "cancelled" }, { kind: "end", sessionId: before }]);
    expect(log.rpc(n).find((m) => m.method === "turn/interrupt")?.params).toMatchObject({ turnId: "01a1c78b-0000-7000-8000-" + String(n).padStart(12, "0") });
    expect(load("school").at(-1)!.content[0]).toEqual({ type: "text", text: "Partial" });
    expect(await waitFor(() => !alive(Number(log.text(`pid-${n}`))))).toBe(true);
  });

  it("stop a server that ignores the interrupt and SIGTERM", async () => {
    process.env.FAKE_IGNORE_INTERRUPT = "1";
    const n = log.runs() + 1;
    const started = Date.now();
    const events = await send(codex("slow ignore"), (e) => {
      if (e.kind === "text") setTimeout(() => cancel("school"), 10);
    });
    delete process.env.FAKE_IGNORE_INTERRUPT;
    expect(events.at(-2)).toEqual({ kind: "cancelled" });
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await waitFor(() => !alive(Number(log.text(`pid-${n}`))))).toBe(true);
  });

  it("refuse to start without the vault's own home, and name Codex when it's missing", async () => {
    const noHome = await send(codex("hi", { configDir: null }));
    expect(errors(noHome)[0].code).toBe("cli");
    expect(errors(noHome)[0].message).toContain("own setup");
    expect(errors(noHome)[0].message).toContain("nothing was sent");
    const saved = process.env.PHAETHON_CODEX_BIN;
    process.env.PHAETHON_CODEX_BIN = path.join(env.home, "missing", "codex");
    const missing = await send(codex("hi"));
    process.env.PHAETHON_CODEX_BIN = saved;
    expect(missing).toEqual([
      { kind: "error", code: "missingCli", message: CODEX_MISSING_MESSAGE },
      { kind: "end", sessionId: null },
    ]);
  });

  it("refuse an unsupported reasoning level before launch", async () => {
    const n = log.runs();
    const events = await send(codex("hi", { reasoning: "high; touch /tmp/x" }));
    expect(errors(events)).toEqual([{ code: "cli", message: "That assistant does not support this reasoning level." }]);
    expect(log.runs()).toBe(n);
  });
});
