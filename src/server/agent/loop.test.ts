import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/agent.ts";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir, spacesRoot, vaultRoot } from "../core/vault.ts";
import { keychainSet, providerAccount, resetMemoryKeychain } from "../core/secrets.ts";
import { claim, release } from "../core/runs.ts";
import { load, recordBlock, save, type Message } from "../core/thread.ts";
import { toUi } from "../threads/store.ts";
import { grantsFor } from "../grants/grants.ts";
import { updateSettings } from "../settings/settings.ts";
import { updateSpaceMeta } from "../spaces/meta.ts";
import { anthropicReply, fakeServer, openaiReply } from "../providers/testing.ts";
import { resetFake } from "../providers/fake.ts";
import { providerFor } from "../providers/build.ts";
import { parseRef } from "../providers/presets.ts";
import { CONTINUE_INSTRUCTION } from "./continuation.ts";
import { COMPACT_TYPE } from "./compaction.ts";
import { PAGE_GATE_BLIND } from "./tools/files.ts";
import "./commands.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => {
  ensureVault();
  fs.mkdirSync(path.join(spacesRoot(), "work", "calendar"), { recursive: true });
  fs.writeFileSync(path.join(spacesRoot(), "work", "calendar", "oct.md"), "Oct 14: shift 9-5\n");
});
let servers: { close: () => Promise<void> }[] = [];
beforeEach(() => {
  resetMemoryKeychain();
  keychainSet(providerAccount("anthropic"), "sk-ant-test-key-0000");
  updateSettings({ provider: null, model: null, backend: "phaethon", providerModels: {}, providerUrls: {} });
  save("school", []);
  updateSpaceMeta("school", { tutorMode: undefined, model: undefined });
});
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

async function anthropic(replies: Parameters<typeof fakeServer>[0]) {
  const srv = await fakeServer(replies);
  servers.push(srv);
  process.env.PHAETHON_ANTHROPIC_BASE_URL = srv.url;
  return srv;
}

async function send(args: Record<string, unknown>, onEvent?: (e: AgentEvent) => void) {
  const ch = channel<AgentEvent>(onEvent);
  await call("agent_send", { space: "school", prompt: "", attachments: [], ...args, onEvent: ch });
  return ch.messages;
}

const texts = (events: AgentEvent[]) => events.filter((e) => e.kind === "text").map((e) => (e as { delta: string }).delta).join("");

describe("a turn over HTTP", () => {
  it("writes a file only after approval, saves records, never sends them", async () => {
    fs.writeFileSync(path.join(vaultRoot(), "MANUAL.md"), "Keep it short.");
    const srv = await anthropic([
      anthropicReply(
        [
          { type: "text", text: "I'll write the plan." },
          { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "plans/week.md", contents: "Mon: study C241\n" } },
        ],
        "tool_use",
      ),
      anthropicReply([{ type: "text", text: "Saved plans/week.md." }]),
    ]);
    const space = spaceDir("school");
    const events = await send({ prompt: "plan my week" }, (e) => {
      if (e.kind === "approval") {
        expect(fs.existsSync(path.join(space, "plans/week.md"))).toBe(false);
        void call("agent_approve", { space: "school", id: e.id, allow: true }).then((ok) => expect(ok).toBe(true));
      }
    });
    expect(fs.readFileSync(path.join(space, "plans/week.md"), "utf8")).toBe("Mon: study C241\n");
    expect(texts(events)).toBe("I'll write the plan.\n\nSaved plans/week.md.");
    expect(events).toContainEqual({
      kind: "approval",
      id: "toolu_1",
      summary: "Create a new file plans/week.md (1 line).",
      detail: "Mon: study C241\n",
      action: "create",
      path: "plans/week.md",
      space: "school",
      before: null,
      truncated: false,
    });
    const kinds = events.map((e) => (e.kind === "tool" ? `tool:${e.label}` : e.kind === "record" ? `record:${e.record.kind}` : e.kind)).filter((k) => k !== "text");
    expect(kinds).toEqual(["toolStart", "tool:Waiting for you to allow: Writing file plans/week.md", "approval", "approvalDone", "record:approval", "tool:Writing file plans/week.md", "toolEnd", "record:tool", "end"]);
    expect(events[events.length - 1]).toEqual({ kind: "end", sessionId: null });

    const first = srv.seen[0].json;
    expect(first.system.map((b: { text: string }) => b.text).join("\n")).toContain("Keep it short.");
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(["list_files", "read_file", "read_page", "search_files", "write_file", "request_access", "app_guide", "study_attempt", "send_to_user"]);
    expect(first.output_config).toEqual({ effort: "medium" });
    const second = srv.seen[1].json.messages;
    expect(second[1].content[1].input.path).toBe("plans/week.md");
    expect(second[2].content[0].tool_use_id).toBe("toolu_1");
    expect(second[2].content[0].is_error).toBeUndefined();
    expect(second[1].content.length).toBe(2);
    expect(srv.seen.some((s) => s.text.includes("phaethon_record"))).toBe(false);
    // The system prompt's cached part is identical between the two calls.
    expect(srv.seen[1].json.system[0]).toEqual(first.system[0]);

    const saved = load("school");
    expect(saved.length).toBe(4);
    expect(JSON.stringify(saved[1])).toContain("phaethon_record");
    const ui = toUi(saved);
    expect(ui[1].text).toBe("I'll write the plan.\n\nSaved plans/week.md.");
    expect(ui[1].index).toBe(1);
    expect(ui[1].records[0]).toEqual({ kind: "approval", path: "plans/week.md", action: "create", allowed: true });
    expect(ui[1].records[1]).toMatchObject({ kind: "tool", category: "write", target: "plans/week.md", status: "success" });
    fs.rmSync(path.join(vaultRoot(), "MANUAL.md"));
  });

  it("asks for another space, reads it with the grant, saves 'always'", async () => {
    const srv = await anthropic([
      anthropicReply([{ type: "tool_use", id: "toolu_1", name: "request_access", input: { space: "work", path: "calendar", reason: "To fit study time around your shifts." } }], "tool_use"),
      anthropicReply([{ type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "@work/calendar/oct.md" } }], "tool_use"),
      anthropicReply([{ type: "text", text: "You work Oct 14, so study on the 13th." }]),
    ]);
    const events = await send({ prompt: "plan my study week" }, (e) => {
      if (e.kind === "accessRequest") {
        expect([e.space, e.path]).toEqual(["work", "calendar"]);
        void call("agent_access_answer", { space: "school", id: e.id, answer: "always" });
      }
    });
    expect(events).toContainEqual({ kind: "accessRequestDone", id: "toolu_1", answer: "always" });
    expect(events).toContainEqual({ kind: "tool", label: "Reading work/calendar/oct.md" });
    expect(events).toContainEqual({ kind: "record", record: { kind: "read", space: "work", path: "calendar/oct.md", tool: "read" } });
    expect(srv.seen[0].json.system[1].text).toContain("other spaces are: work.");
    const granted = srv.seen[1].json.messages[2].content[0];
    expect(granted).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: 'The user allowed reading @work/calendar from now on. Read it with paths starting "@work/calendar".' });
    expect(srv.seen[2].json.messages[4].content[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_2", content: "Oct 14: shift 9-5\n" });
    expect(grantsFor("school").map((g) => [g.from, g.path])).toEqual([["work", "calendar"]]);
  });

  it("refuses reads of another space without a grant and denies re-asking after a deny", async () => {
    fs.writeFileSync(path.join(vaultRoot(), ".phaethon", "grants.json"), JSON.stringify({ grants: [] }));
    const srv = await anthropic([
      anthropicReply([{ type: "tool_use", id: "t1", name: "read_file", input: { path: "@work/calendar/oct.md" } }], "tool_use"),
      anthropicReply([{ type: "tool_use", id: "t2", name: "request_access", input: { space: "work", path: "calendar", reason: "r" } }], "tool_use"),
      anthropicReply([{ type: "tool_use", id: "t3", name: "request_access", input: { space: "work", path: "calendar/oct.md", reason: "r" } }], "tool_use"),
      anthropicReply([{ type: "text", text: "ok" }]),
    ]);
    const events = await send({ prompt: "x" }, (e) => {
      if (e.kind === "accessRequest") void call("agent_access_answer", { space: "school", id: e.id, answer: "deny" });
    });
    expect(srv.seen[1].json.messages[2].content[0]).toMatchObject({ is_error: true, content: '"@work/calendar/oct.md" is in the work space; ask for access with request_access first' });
    expect(srv.seen[3].json.messages[6].content[0].content).toMatch(/^Not asked: the user already declined access to @work\/calendar\/oct.md/);
    expect(events.filter((e) => e.kind === "accessRequest").length).toBe(1);
    expect(events.some((e) => e.kind === "tool" && e.label.startsWith("Reading work"))).toBe(false);
  });

  it("stops after MAX_STEPS model calls", async () => {
    const replies = Array.from({ length: 30 }, (_, i) => anthropicReply([{ type: "tool_use", id: `t${i}`, name: "list_files", input: {} }], "tool_use"));
    const srv = await anthropic(replies);
    const events = await send({ prompt: "loop" });
    expect(srv.seen.length).toBe(30);
    expect(events).toContainEqual({ kind: "error", code: "provider", message: "Phaethon stopped the agent after 30 steps. Send another message to let it continue." });
    expect(events[events.length - 1].kind).toBe("end");
  });

  it("cancels mid-stream and keeps the partial reply with a stopped mark", async () => {
    const reply = anthropicReply([{ type: "text", text: "Partial answer that goes on" }]);
    reply.holdAfter = { chunk: 2, ms: 3000 };
    await anthropic([reply]);
    let cancelled = false;
    const events = await send({ prompt: "x" }, (e) => {
      if (e.kind === "text" && !cancelled) {
        cancelled = true;
        void call("agent_cancel", { space: "school" });
      }
    });
    expect(events.slice(-3)).toEqual([{ kind: "record", record: { kind: "stopped" } }, { kind: "cancelled" }, { kind: "end", sessionId: null }]);
    const saved = load("school");
    expect(saved[1].content[saved[1].content.length - 1]).toEqual({ type: "phaethon_record", kind: "stopped" });
    expect(String(saved[1].content[0].text)).toMatch(/^Partial/);
  });

  it("cancelling while an approval waits is not a decline", async () => {
    await anthropic([anthropicReply([{ type: "tool_use", id: "w1", name: "write_file", input: { path: "a.md", contents: "x" } }], "tool_use")]);
    const events = await send({ prompt: "x" }, (e) => {
      if (e.kind === "approval") void call("agent_cancel", { space: "school" });
    });
    expect(events).toContainEqual({ kind: "approvalDone", id: "w1", allowed: false });
    expect(events.some((e) => e.kind === "record" && e.record.kind === "approval")).toBe(false);
    expect(events.slice(-2)).toEqual([{ kind: "cancelled" }, { kind: "end", sessionId: null }]);
    expect(fs.existsSync(path.join(spaceDir("school"), "a.md"))).toBe(false);
    const results = load("school")[2].content[0];
    expect(results).toMatchObject({ tool_use_id: "w1", content: "Not run: the user stopped the reply.", is_error: true });
  });

  it("refuses a second turn in the same space", async () => {
    const run = claim("school")!;
    const events = await send({ prompt: "x" });
    release(run);
    expect(events).toEqual([
      { kind: "error", code: "busy", message: "This space is still answering the previous message. Stop it or wait for it to finish." },
      { kind: "end", sessionId: null },
    ]);
  });

  it("reports a missing key and an invalid space", async () => {
    resetMemoryKeychain();
    expect(await send({ prompt: "x" })).toEqual([
      { kind: "error", code: "noApiKey", message: "Add your Anthropic API key in Settings to start." },
      { kind: "end", sessionId: null },
    ]);
    const bad = await send({ space: "../x", prompt: "x" });
    expect(bad[0]).toMatchObject({ kind: "error", code: "invalidSpace" });
  });

  it("heals stringified arguments and errors back with fix instructions", async () => {
    const srv = await anthropic([
      anthropicReply([{ type: "tool_use", id: "t1", name: "list_files", input: { path: "", extra: true } }], "tool_use"),
      anthropicReply([{ type: "tool_use", id: "t2", name: "read_page", input: { path: "notes.pdf", page: "2" } }], "tool_use"),
      anthropicReply([{ type: "text", text: "done" }]),
    ]);
    fs.writeFileSync(path.join(spaceDir("school"), "notes.pdf"), "%PDF-1.4");
    await send({ prompt: "x" });
    expect(srv.seen[1].json.messages[2].content[0]).toMatchObject({ is_error: true, content: 'Not run: unexpected field "extra".' });
    // page "2" was healed to 2 and reached the renderer (a stub here), past every input check.
    expect(srv.seen[2].json.messages[4].content[0].content).toBe("the page renderer crashed: no page renderer is available yet");
  });
});

describe("model sight", () => {
  it("lets read_page through for Claude, also when continuing a stopped reply, and refuses blind models", async () => {
    fs.writeFileSync(path.join(spaceDir("school"), "notes.pdf"), "%PDF-1.4");
    const stopped: Message[] = [
      { role: "user", content: [{ type: "text", text: "explain page 2" }], at: 1 },
      { role: "assistant", content: [{ type: "text", text: "Page 2 shows" }, recordBlock({ kind: "stopped" })], at: 2 },
    ];
    save("school", stopped);
    const srv = await anthropic([
      anthropicReply([{ type: "tool_use", id: "p1", name: "read_page", input: { path: "notes.pdf", page: 2 } }], "tool_use"),
      anthropicReply([{ type: "text", text: "a proof." }]),
    ]);
    const events = await send({ continueFrom: 1 });
    expect(srv.seen[0].json.messages[2]).toEqual({ role: "user", content: [{ type: "text", text: CONTINUE_INSTRUCTION }] });
    const result = srv.seen[1].json.messages[4].content[0];
    expect(result.content).not.toBe(PAGE_GATE_BLIND);
    expect(texts(events)).toBe("a proof.");
    // Settled: the stopped mark is gone so the two parts read as one reply.
    const ui = toUi(load("school"));
    expect(ui.length).toBe(2);
    expect(ui[1].text).toBe("Page 2 shows\n\na proof.");
    expect(ui[1].records.some((r) => r.kind === "stopped")).toBe(false);

    // A model known not to see pictures is refused before rendering.
    const compat = await fakeServer([openaiReply("", [{ id: "c1", name: "read_page", args: '{"path":"notes.pdf","page":1}' }]), openaiReply("ok")]);
    servers.push(compat);
    updateSettings({ provider: "custom", providerModels: { custom: "gpt-3.5-turbo" }, providerUrls: { custom: `${compat.url}/v1` } });
    save("school", []);
    await send({ prompt: "look" });
    expect(compat.seen[1].json.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: `Error: ${PAGE_GATE_BLIND}` });
    // The thread stays in Messages shape.
    expect(load("school")[1].content[0]).toMatchObject({ type: "tool_use", id: "c1", name: "read_page", input: { path: "notes.pdf", page: 1 } });
  });
});

describe("lessons", () => {
  const goodCheck = {
    role: "check",
    question: "If $f(x)=x^2$, what is $f'(3)$?",
    options: [
      { value: "a", label: "6" },
      { value: "b", label: "9" },
      { value: "c", label: "3" },
    ],
    explanation: "f'(x)=2x so 6; 9 evaluates f; 3 forgets the power rule.",
    correctAnswer: "a",
  };

  it("plans, asks, waits for the answer across a reload, and continues with it", async () => {
    await call("space_tutor_mode_set", { space: "school", mode: "quiz" });
    const srv = await anthropic([
      anthropicReply(
        [{ type: "tool_use", id: "pl1", name: "plan_lesson", input: { goal: "Differentiate powers.", strands: [{ strand: "limits", known: "solid" }], premises: ["f'(x) is a limit"], map: "graph TD\na --> b\nb --> a" } }],
        "tool_use",
      ),
      anthropicReply(
        [{ type: "tool_use", id: "pl2", name: "plan_lesson", input: { goal: "Differentiate powers.", strands: [{ strand: "limits", known: "solid" }], premises: ["f'(x) is a limit"], map: "graph TD\nlimits[Limits] --> power-rule[Power rule]" } }],
        "tool_use",
      ),
    ]);
    const planEvents = await send({ prompt: "teach me derivatives" });
    expect(srv.seen[0].json.output_config).toEqual({ effort: "high" });
    expect(srv.seen[0].json.tools.map((t: { name: string }) => t.name).slice(8)).toEqual(["send_to_user", "plan_lesson", "check", "explain_back"]);
    expect(srv.seen[0].json.system[1].text).toContain("# Tutor mode: Quiz me");
    expect(srv.seen[1].json.messages[2].content[0]).toMatchObject({ is_error: true });
    expect(srv.seen[1].json.messages[2].content[0].content).toMatch(/^Not run: The map has a cycle through a, b/);
    expect(planEvents).toContainEqual({
      kind: "record",
      record: { kind: "lessonPlan", id: "pl2", goal: "Differentiate powers.", map: "graph TD\nlimits[Limits] --> power-rule[Power rule]", nodes: [{ id: "limits", label: "Limits" }, { id: "power-rule", label: "Power rule" }] },
    });
    expect(srv.seen.length).toBe(2);
    expect(load("school").slice(-1)[0].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "pl2" });

    const srv2 = await anthropic([
      anthropicReply([{ type: "tool_use", id: "q0", name: "check", input: { ...goodCheck, correctAnswer: "6", nodeId: "power-rule" } }], "tool_use"),
      anthropicReply(
        [
          { type: "tool_use", id: "s1", name: "send_to_user", input: { message: "The power rule: bring the exponent down." } },
          { type: "tool_use", id: "q1", name: "check", input: { ...goodCheck, options: JSON.stringify(goodCheck.options), nodeId: "power-rule" } },
        ],
        "tool_use",
      ),
    ]);
    const askEvents = await send({ prompt: "ok, go" });
    expect(srv2.seen[1].json.messages.slice(-1)[0].content[0].content).toMatch(/^Not run: correctAnswer "6" isn't one of the option values \(a, b, c\)/);
    expect(texts(askEvents)).toBe("The power rule: bring the exponent down.");
    const asked = askEvents.find((e) => e.kind === "check");
    expect(asked).toEqual({ kind: "check", question: { id: "q1", role: "check", question: goodCheck.question, options: goodCheck.options, multiSelect: false } });
    expect(JSON.stringify(askEvents)).not.toContain("forgets the power rule");
    expect(askEvents[askEvents.length - 1].kind).toBe("end");
    expect(srv2.seen.length).toBe(2);

    // A reload shows the open question and the delivered text.
    const ui = toUi(load("school"));
    const last = ui[ui.length - 1];
    expect(last.pending).toEqual({ kind: "check", question: asked && asked.kind === "check" ? asked.question : undefined });
    expect(last.text).toContain("The power rule: bring the exponent down.");

    expect(await call("lesson_answer", { space: "school", id: "nope", answer: { answers: ["a"] } })).toBe(false);
    const srv3 = await anthropic([anthropicReply([{ type: "text", text: "Right: 2·3 = 6." }])]);
    const ch = channel<AgentEvent>();
    expect(await call("lesson_answer", { space: "school", id: "q1", answer: { answers: ["a"], confidence: 70, thinking: "power rule" }, onEvent: ch })).toBe(true);
    const lastMsg = srv3.seen[0].json.messages.slice(-1)[0];
    expect(lastMsg.content).toContainEqual({ type: "tool_result", tool_use_id: "s1", content: "Shown to the user." });
    expect(lastMsg.content).toContainEqual({ type: "tool_result", tool_use_id: "q1", content: JSON.stringify({ answers: [{ value: "a", label: "6" }], correct: true, confidence: 70, thinking: "power rule" }) });
    expect(texts(ch.messages)).toBe("Right: 2·3 = 6.");
    expect(ch.messages[ch.messages.length - 1]).toEqual({ kind: "end", sessionId: null });
    const after = toUi(load("school"));
    expect(after[after.length - 1].pending).toBeUndefined();
    expect(after.flatMap((m) => m.records).find((r) => r.kind === "check")).toEqual({ kind: "check", id: "q1", question: goodCheck.question, answered: true, correct: true, confidence: 70 });
  });

  it("closes an open question when the user moves on", async () => {
    await call("space_tutor_mode_set", { space: "school", mode: "quiz" });
    save("school", [
      { role: "user", content: [{ type: "text", text: "quiz" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "q9", name: "explain_back", input: { question: "Why?", modelAnswer: "Because." } }] },
    ]);
    const srv = await anthropic([anthropicReply([{ type: "text", text: "Sure." }])]);
    await send({ prompt: "actually, something else" });
    const msgs = srv.seen[0].json.messages;
    expect(msgs[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "q9", content: "The user didn’t answer this question and sent a new message instead." }] });
    expect(msgs[3].content[0].text).toBe("actually, something else");
  });
});

describe("compaction", () => {
  it("summarises a long conversation and starts the next request from the summary", async () => {
    process.env.PHAETHON_COMPACT_AT = "200";
    save("school", [
      { role: "user", content: [{ type: "text", text: "Explain limits. " + "detail ".repeat(200) }], at: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "A limit is…" }], at: 2 },
    ]);
    const srv = await anthropic([
      anthropicReply([{ type: "text", text: "## What the student understands\nLimits: shaky." }]),
      anthropicReply([{ type: "text", text: "Next: continuity." }]),
    ]);
    const events = await send({ prompt: "what next?" });
    delete process.env.PHAETHON_COMPACT_AT;
    expect(events).toContainEqual({ kind: "tool", label: "Summarizing the earlier conversation" });
    expect(srv.seen[0].json.system[0].text).toContain("You write the memory of a long tutoring and study conversation");
    expect(srv.seen[0].json.tools).toBeUndefined();
    const next = srv.seen[1].json.messages;
    expect(next.length).toBe(2);
    expect(next[0].content[0].text).toMatch(/^\[A summary of this conversation so far/);
    expect(next[0].content[0].text).toContain("Limits: shaky.");
    expect(next[1].content[0].text).toBe("what next?");
    expect(JSON.stringify(next)).not.toContain('"thinking"');
    const saved = load("school");
    expect(saved[2].content[0].type).toBe(COMPACT_TYPE);
    expect(toUi(saved).map((m) => m.text)).toEqual([expect.stringMatching(/^Explain limits/), "A limit is…", "what next?", "Next: continuity."]);
  });
});

describe("the scripted fake provider", () => {
  it("exists only when PHAETHON_FAKE_PROVIDER names a script, and drives a whole turn", async () => {
    expect(providerFor(parseRef("claude-opus-5-5")!).id).toBe("anthropic");
    const script = path.join(env.home, "script.json");
    fs.writeFileSync(
      script,
      JSON.stringify({
        claude: true,
        steps: [
          { progress: ["Checking your notes."], text: "Here goes.", tools: [{ name: "write_file", input: { path: "f.md", contents: "hi\n" }, id: "w" }] },
          { text: "Done." },
        ],
      }),
    );
    process.env.PHAETHON_FAKE_PROVIDER = script;
    resetFake();
    resetMemoryKeychain(); // no key needed
    const events = await send({ prompt: "go" }, (e) => {
      if (e.kind === "approval") void call("agent_approve", { space: "school", id: e.id, allow: true });
    });
    delete process.env.PHAETHON_FAKE_PROVIDER;
    expect(events).toContainEqual({ kind: "progress", text: "Checking your notes." });
    expect(texts(events)).toBe("Here goes.\n\nDone.");
    expect(fs.readFileSync(path.join(spaceDir("school"), "f.md"), "utf8")).toBe("hi\n");
    const log = fs.readFileSync(`${script}.requests.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log[0].tools).toContain("send_to_user");
    expect(toUi(load("school"))[1].records[0]).toEqual({ kind: "progress", text: "Checking your notes." });
  });
});
