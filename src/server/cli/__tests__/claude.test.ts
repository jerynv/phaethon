import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../../tests/harness.ts";
import { cancel } from "../../core/runs.ts";
import { load, save, userMessage } from "../../core/thread.ts";
import { ALLOWED_TOOLS, ClaudeParser, cliArgs, cliArgsFull } from "../claude.ts";
import { MISSING_CLI_MESSAGE, NOT_LOGGED_IN_MESSAGE } from "../cli.ts";
import { HISTORY_INTRO } from "../prompt.ts";
import { readCliSession, writeCliSession } from "../session.ts";
import { alive, errors, FakeLog, fakeBin, request, send, setup, shown, waitFor } from "./helpers.ts";

const env = tempHome("phaethon-cli-claude-");
afterAll(() => env.cleanup());
let log: FakeLog;
let school: string;
const OLD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeAll(() => {
  const s = setup(env.home, "claude");
  log = new FakeLog(s.log);
  school = s.school;
  process.env.PHAETHON_CLAUDE_BIN = fakeBin(path.join(env.home, "bin"), "claude");
  // A parent Claude Code session's variables must never reach the child.
  process.env.CLAUDECODE = "1";
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
});

describe("Claude Code arguments", () => {
  it("are walled: read tools only, nothing asked, none of the person's setup, never --bare", () => {
    const args = cliArgs("11111111-2222-3333-4444-555555555555", []);
    expect(args.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    for (const flag of ["--restricted", "--strict-mcp-config", "--no-chrome", "--safe-mode", "--disable-slash-commands"]) expect(args).toContain(flag);
    expect(args.join(" ")).toContain(`--tools ${ALLOWED_TOOLS} --allowedTools ${ALLOWED_TOOLS} --permission-mode dontAsk --permission-prompts none`);
    expect(args.some((a) => a.includes("dangerously") || a === "bypassPermissions" || a === "--bare" || a === "--add-dir")).toBe(false);
    expect(args.slice(-2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
  });

  it("put each granted folder in its own --add-dir followed by a flag", () => {
    const args = cliArgs(null, ["/vault/spaces/work/calendar", "/vault/spaces/home/bills"]);
    const dirs = args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));
    expect(dirs).toEqual(["/vault/spaces/work/calendar", "/vault/spaces/home/bills"]);
    args.forEach((a, i) => a === "--add-dir" && expect(args[i + 2] === undefined || args[i + 2].startsWith("--")).toBe(true));
  });

  it("with full access drop the walls but keep the person's setup out", () => {
    const a = cliArgsFull("abc");
    for (const flag of ["--dangerously-skip-permissions", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-chrome"]) expect(a).toContain(flag);
    expect(a.some((x) => x === "--tools" || x === "--restricted" || x === "dontAsk")).toBe(false);
    expect(a.slice(-2)).toEqual(["--resume", "abc"]);
  });
});

describe("Claude Code stream", () => {
  const feed = (lines: string[], granted: { label: string; path: string }[] = []) => {
    const p = new ClaudeParser("/vault/spaces/school", granted);
    return { events: lines.flatMap((l) => p.feed(l)), outcome: p.finish() };
  };

  it("streams text and remembers the session", () => {
    const { events, outcome } = feed([
      '{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555"}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"po"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ng"}}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"11111111-2222-3333-4444-555555555555"}',
    ]);
    expect(events).toEqual([
      { kind: "text", delta: "po" },
      { kind: "text", delta: "ng" },
    ]);
    expect(outcome).toEqual({ kind: "success", sessionId: "11111111-2222-3333-4444-555555555555" });
  });

  it("labels tools, separates text blocks and pairs results once", () => {
    const { events } = feed([
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me look."}}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/vault/spaces/school/notes.md"}}]}}',
      '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}}',
    ]);
    expect(events).toEqual([
      { kind: "text", delta: "Let me look." },
      { kind: "tool", label: "Reading file notes.md" },
      { kind: "toolStart", id: "claude:unpaired-1", category: "read", label: "Reading file", target: "notes.md" },
      { kind: "text", delta: "\n\n" },
      { kind: "text", delta: "Done." },
    ]);
    const p = new ClaudeParser("/vault/spaces/school", [{ label: "work/calendar", path: "/vault/spaces/work/calendar" }]);
    const start = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"/vault/spaces/work/calendar/oct.md"}}]}}';
    expect(p.feed(start)).toEqual([
      { kind: "tool", label: "Reading work/calendar/oct.md" },
      { kind: "toolStart", id: "claude:read-1", category: "read", label: "Reading file", target: "work/calendar/oct.md" },
    ]);
    expect(p.feed(start)).toEqual([]);
    const result = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","is_error":true,"content":"private full output"}]}}';
    expect(p.feed(result)).toEqual([{ kind: "toolEnd", id: "claude:read-1", status: "failed", detail: "Tool reported an error" }]);
    expect(p.feed(result)).toEqual([]);
  });

  it("falls back to the result text, and reads errors and garbage", () => {
    expect(feed(['{"type":"result","subtype":"success","is_error":false,"result":"hi"}']).events).toEqual([{ kind: "text", delta: "hi" }]);
    const bad = feed(["not json", '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}']);
    expect(bad.events).toEqual([]);
    expect(bad.outcome).toEqual({ kind: "failed", message: "Not logged in · Please run /login" });
    expect(feed([]).outcome).toEqual({ kind: "incomplete", message: "" });
    expect(feed(['{"type":"result","subtype":"error_max_turns","is_error":false}']).outcome).toEqual({ kind: "failed", message: "Claude Code stopped: error_max_turns." });
  });
});

describe("Claude Code conversations", () => {
  it("resume a legacy bare session, get the prompt on stdin only, and lose the parent's variables", async () => {
    writeCliSession(school, null, OLD);
    const events = await send(request("claude", "school", "When is Test 1?"));
    expect(errors(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "end", sessionId: OLD });
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
    expect(log.flag(1, "--resume")).toBe(OLD);
    expect(log.text("stdin-1")).toBe("When is Test 1?");
    expect(log.args(1).join("\n")).not.toContain("When is Test 1?");
    expect(log.env(1).CLAUDECODE).toBeNull();
    expect(log.env(1).CLAUDE_CODE_ENTRYPOINT).toBeNull();
    expect(log.env(1).CLAUDE_CONFIG_DIR).toBeNull();
    expect(log.env(1).cwd).toBe(school);
    expect(shown("school")).toEqual([
      ["user", "When is Test 1?"],
      ["assistant", "Reply 1."],
    ]);
    // The study block is always appended to Claude Code's own system prompt, once.
    expect(log.args(1).filter((a) => a === "--append-system-prompt")).toHaveLength(1);
    expect(log.flag(1, "--append-system-prompt")).toMatch(/^# Getting it right[\s\S]*# Explaining something[\s\S]*# A quiz or flashcards from the chat/);
  });

  it("names attachments on stdin and passes a valid model, never a flag-like one", async () => {
    const attachments = [{ type: "phaethon_attachment", path: "attachments/notes.pdf", media_type: "application/pdf", name: "notes.pdf" }];
    await send(request("claude", "school", "Summarise", { attachments, model: "claude-opus-5-5" }));
    expect(log.text("stdin-2")).toBe("Summarise\n\nThe user attached these files, saved in this folder:\n- attachments/notes.pdf");
    expect(log.flag(2, "--model")).toBe("claude-opus-5-5");
    await send(request("claude", "school", "Again", { model: "--dangerously-skip-permissions" }));
    expect(log.args(3)).not.toContain("--model");
    expect(log.args(3)).not.toContain("--dangerously-skip-permissions");
  });

  it("retries a lost session once, fresh, with the conversation so far", async () => {
    fs.writeFileSync(path.join(log.dir, "stale"), `${OLD}\n`);
    const before = log.runs();
    const events = await send(request("claude", "school", "Next?"));
    expect(errors(events)).toEqual([]);
    expect(log.runs()).toBe(before + 2);
    expect(log.flag(before + 1, "--resume")).toBe(OLD);
    expect(log.args(before + 2)).not.toContain("--resume");
    const stdin = log.text(`stdin-${before + 2}`);
    expect(stdin.startsWith(`${HISTORY_INTRO}\n\n<conversation>\nUser: When is Test 1?\n\nPhaethon: Reply 1.`)).toBe(true);
    expect(stdin.endsWith("The user's new message:\n\nNext?")).toBe(true);
    const fresh = `00000000-0000-0000-0000-${String(before + 2).padStart(12, "0")}`;
    expect(readCliSession(school, null)).toBe(fresh);
    expect(events.at(-1)).toEqual({ kind: "end", sessionId: fresh });
  });

  it("records tool use without arguments or output", async () => {
    fs.writeFileSync(path.join(school, "notes.md"), "secret notes");
    const events = await send(request("claude", "school", "tool please"));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["text", "tool", "toolStart", "toolEnd", "record", "text", "text", "end"]);
    const saved = JSON.stringify(load("school").at(-1));
    expect(saved).toContain('"kind":"tool"');
    expect(saved).toContain('"target":"notes.md"');
    expect(saved).not.toContain("secret notes");
  });

  it("maps a signed-out CLI to notLoggedIn", async () => {
    const events = await send(request("claude", "school", "notloggedin"));
    expect(errors(events)).toEqual([{ code: "notLoggedIn", message: NOT_LOGGED_IN_MESSAGE }]);
    expect(events.at(-1)).toEqual({ kind: "end", sessionId: null });
  });

  it("stops: partial text and the stopped record are kept, the old session too, and the group is gone", async () => {
    const before = readCliSession(school, null);
    const n = log.runs() + 1;
    const pending = send(request("claude", "school", "slow please"), (e) => {
      if (e.kind === "text") setTimeout(() => cancel("school"), 10);
    });
    const events = await pending;
    expect(events.slice(-3)).toEqual([{ kind: "record", record: { kind: "stopped" } }, { kind: "cancelled" }, { kind: "end", sessionId: before }]);
    const last = load("school").at(-1)!;
    expect(last.content).toEqual([{ type: "text", text: "Partial" }, { type: "phaethon_record", kind: "stopped" }]);
    expect(await waitFor(() => !alive(Number(log.text(`pid-${n}`))))).toBe(true);
  });

  it("stops a CLI whose descendant ignores SIGTERM and holds stderr", async () => {
    const n = log.runs() + 1;
    const started = Date.now();
    const events = await send(request("claude", "school", "stubborn please"), (e) => {
      if (e.kind === "text") setTimeout(() => cancel("school"), 50);
    });
    expect(events.at(-2)).toEqual({ kind: "cancelled" });
    expect(Date.now() - started).toBeLessThan(8000);
    const descendant = Number(log.text(`descendant-${n}`));
    expect(await waitFor(() => !alive(descendant))).toBe(true);
    expect(await waitFor(() => !alive(Number(log.text(`pid-${n}`))))).toBe(true);
  });

  it("is busy while another turn runs in the space", async () => {
    const first = send(request("claude", "school", "slow again"), (e) => {
      if (e.kind === "text") {
        void send(request("claude", "school", "second")).then((events) => {
          expect(events).toEqual([
            { kind: "error", code: "busy", message: "This space is still answering the previous message. Stop it or wait for it to finish." },
            { kind: "end", sessionId: null },
          ]);
          cancel("school");
        });
      }
    });
    expect((await first).at(-2)).toEqual({ kind: "cancelled" });
  });

  it("edits start a fresh session and the old version keeps its own", async () => {
    save("work", [userMessage("first"), { role: "assistant", content: [{ type: "text", text: "one" }] }]);
    const work = path.dirname(school) + "/work";
    writeCliSession(work, null, OLD);
    fs.rmSync(path.join(log.dir, "stale"));
    const n = log.runs() + 1;
    await send(request("claude", "work", "first, edited", { replaceFrom: 0 }));
    expect(log.args(n)).not.toContain("--resume");
    expect(shown("work")).toEqual([
      ["user", "first, edited"],
      ["assistant", `Reply ${n}.`],
    ]);
    const archived = fs.readdirSync(path.join(work, ".phaethon", "threads"));
    expect(archived.some((f) => f.endsWith(".session"))).toBe(true);
  });

  it("reports a missing binary before anything is recorded", async () => {
    const saved = process.env.PHAETHON_CLAUDE_BIN;
    process.env.PHAETHON_CLAUDE_BIN = path.join(env.home, "nowhere", "claude");
    const before = load("school").length;
    const events = await send(request("claude", "school", "hello"));
    expect(events).toEqual([
      { kind: "error", code: "missingCli", message: MISSING_CLI_MESSAGE },
      { kind: "end", sessionId: null },
    ]);
    expect(load("school").length).toBe(before);
    process.env.PHAETHON_CLAUDE_BIN = saved;
  });
});
