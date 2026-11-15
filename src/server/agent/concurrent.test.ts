import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/agent.ts";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir, vaultStateDir } from "../core/vault.ts";
import { claim, isSpaceBusy, release, runningIn, turnKey } from "../core/runs.ts";
import { load, records } from "../core/thread.ts";
import { resetFake } from "../providers/fake.ts";
import "../commands.ts";

/**
 * Several conversations at once: each reply claims only its own conversation,
 * so two conversations in one space stream side by side and stopping one
 * leaves the other alone. Writes the person allowed once for a conversation
 * or a space go ahead without a card; the walls stay.
 */
const env = tempHome("phaethon-agent-concurrent-");
afterAll(() => {
  delete process.env.PHAETHON_FAKE_PROVIDER;
  env.cleanup();
});

let script: string;
function useScript(steps: object[]) {
  fs.writeFileSync(script, JSON.stringify({ steps }));
  resetFake();
}

beforeAll(() => {
  ensureVault();
  script = path.join(env.home, "fake.json");
  process.env.PHAETHON_FAKE_PROVIDER = script;
});

const dir = () => spaceDir("school");
const threadFiles = () => {
  const d = path.join(dir(), ".phaethon", "threads");
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};

function start(thread: string, prompt: string, onEvent?: (e: AgentEvent) => void) {
  const ch = channel<AgentEvent>(onEvent);
  const done = call("agent_send", { space: "school", thread, prompt, attachments: [], onEvent: ch }).then(() => ch.messages);
  return { ch, done };
}

function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) resolve();
      else if (Date.now() > end) reject(new Error("timed out"));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

const texts = (events: AgentEvent[]) => events.filter((e) => e.kind === "text").map((e) => (e as { delta: string }).delta).join("");

describe("two conversations in one space", () => {
  it("stream at the same time, and stopping one leaves the other running", async () => {
    const one = "one ".repeat(60).trim();
    const two = "two ".repeat(60).trim();
    useScript([
      { text: one, wordDelayMs: 8 },
      { text: two, wordDelayMs: 8 },
    ]);
    const a = await call<string>("thread_create", { space: "school" });
    const b = await call<string>("thread_create", { space: "school" });
    expect(a).not.toBe(b);
    // Nothing is saved for a new chat until it is sent.
    expect(threadFiles()).toEqual([]);

    const first = start(a, "first question");
    await until(() => first.ch.messages.some((e) => e.kind === "text"));
    const second = start(b, "second question");
    await until(() => second.ch.messages.some((e) => e.kind === "text"));
    // Both are writing now.
    expect(runningIn("school").sort()).toEqual([a, b].sort());
    expect(first.ch.messages.some((e) => e.kind === "end")).toBe(false);
    const listed = await call<{ id: string; running?: boolean }[]>("threads_list", { space: "school" });
    expect(listed.filter((t) => t.running).map((t) => t.id).sort()).toEqual([a, b].sort());

    // Stopping the first doesn't touch the second.
    expect(await call("agent_cancel", { space: "school", thread: a })).toBe(true);
    const [eventsA, eventsB] = await Promise.all([first.done, second.done]);
    expect(eventsA.some((e) => e.kind === "cancelled")).toBe(true);
    expect(eventsB.some((e) => e.kind === "cancelled")).toBe(false);
    expect(texts(eventsB)).toBe(two);
    expect(eventsA.at(-1)).toEqual({ kind: "end", sessionId: null });
    expect(eventsB.at(-1)).toEqual({ kind: "end", sessionId: null });
    expect(isSpaceBusy("school")).toBe(false);

    // Each reply went to its own conversation's file.
    const savedA = load("school", a);
    const savedB = load("school", b);
    expect(savedA[0]!.content).toEqual([{ type: "text", text: "first question" }]);
    expect(records(savedA).some((r) => r.kind === "stopped")).toBe(true);
    expect(savedB[0]!.content).toEqual([{ type: "text", text: "second question" }]);
    expect(savedB[1]!.content).toEqual([{ type: "text", text: two }]);
    expect(records(savedB).some((r) => r.kind === "stopped")).toBe(false);
  });

  it("can be renamed, pinned and deleted while another one replies, but not the one replying", async () => {
    useScript([{ text: "done" }]);
    const a = await call<string>("thread_create", { space: "school" });
    await start(a, "keep me").done;
    const b = await call<string>("thread_create", { space: "school" });
    const run = claim(turnKey("school", b))!;
    try {
      await call("thread_rename", { space: "school", thread: a, title: "Kept" });
      await call("thread_pin", { space: "school", thread: a, pinned: true });
      const list = await call<{ id: string; title: string; pinned?: number }[]>("threads_list", { space: "school" });
      expect(list.find((t) => t.id === a)).toMatchObject({ title: "Kept", pinned: expect.any(Number) });
      await expect(call("thread_delete", { space: "school", thread: b })).rejects.toThrow("still replying in this conversation");
      await call("thread_delete", { space: "school", thread: a });
      expect(fs.existsSync(path.join(dir(), ".phaethon", "threads", `${a}.json`))).toBe(false);
    } finally {
      release(run);
    }
  });
});

describe("a refused send", () => {
  it("leaves no conversation, model choice or attachment behind", async () => {
    useScript([{ text: "never" }]);
    const t = await call<string>("thread_create", { space: "school" });
    const run = claim(turnKey("school", t))!;
    const before = threadFiles();
    const attachments = fs.existsSync(path.join(dir(), "attachments")) ? fs.readdirSync(path.join(dir(), "attachments")) : [];
    const ch = channel<AgentEvent>();
    await call("agent_send", {
      space: "school",
      thread: t,
      prompt: "x",
      attachments: [{ name: "notes.txt", mediaType: "text/plain", data: Buffer.from("hello").toString("base64") }],
      model: { backend: "phaethon", model: "anthropic:claude-haiku-5-5", effort: null },
      onEvent: ch,
    });
    release(run);
    expect(ch.messages[0]).toMatchObject({ kind: "error", code: "busy" });
    expect(threadFiles()).toEqual(before);
    expect(fs.existsSync(path.join(dir(), "attachments")) ? fs.readdirSync(path.join(dir(), "attachments")) : []).toEqual(attachments);
  });
});

describe("writing without asking", () => {
  beforeEach(async () => {
    for (const f of ["a.md", "b.md", "c.md", "d.md"]) fs.rmSync(path.join(dir(), f), { force: true });
    await call("write_permission_set", { space: "school", scope: "space", allow: false });
  });

  const writeStep = (file: string) => ({ tools: [{ name: "write_file", input: { path: file, contents: `${file} text` } }] });

  it("asks once; “allow for this conversation” lets its later writes through, and nowhere else", async () => {
    useScript([writeStep("a.md"), { text: "Saved." }, writeStep("b.md"), { text: "Saved again." }, writeStep("c.md"), { text: "Not saved." }]);
    const t = await call<string>("thread_create", { space: "school" });
    const asked = await start(t, "save a", (e) => {
      if (e.kind === "approval") void call("agent_approve", { space: "school", thread: t, id: e.id, allow: true, remember: "conversation" });
    }).done;
    expect(asked.some((e) => e.kind === "approval")).toBe(true);
    expect(fs.readFileSync(path.join(dir(), "a.md"), "utf8")).toBe("a.md text");

    const quiet = await start(t, "save b").done;
    expect(quiet.some((e) => e.kind === "approval")).toBe(false);
    expect(fs.readFileSync(path.join(dir(), "b.md"), "utf8")).toBe("b.md text");
    expect(quiet).toContainEqual({ kind: "record", record: { kind: "approval", path: "b.md", action: "create", allowed: true, auto: "conversation" } });
    expect(await call("write_permissions_list", { space: "school" })).toMatchObject({ spaces: [], conversations: [{ thread: t, title: "save a" }] });

    // Another conversation still asks.
    const other = await call<string>("thread_create", { space: "school" });
    const denied = await start(other, "save c", (e) => {
      if (e.kind === "approval") void call("agent_approve", { space: "school", thread: other, id: e.id, allow: false });
    }).done;
    expect(denied.some((e) => e.kind === "approval")).toBe(true);
    expect(fs.existsSync(path.join(dir(), "c.md"))).toBe(false);

    // Taken back in Settings: it asks again.
    await call("write_permission_set", { space: "school", thread: t, scope: "conversation", allow: false });
    expect(await call("write_permissions_list", { space: "school" })).toMatchObject({ conversations: [] });
  });

  it("“always allow in this space” covers every conversation there until it is taken back; the walls stay", async () => {
    useScript([writeStep("d.md"), { text: "Saved." }, writeStep("../outside.md"), { text: "Refused." }]);
    await call("write_permission_set", { space: "school", scope: "space", allow: true });
    const settings = JSON.parse(fs.readFileSync(path.join(vaultStateDir(), "settings.json"), "utf8"));
    expect(settings.allowWrites).toEqual({ school: expect.any(Number) });
    const t = await call<string>("thread_create", { space: "school" });
    const events = await start(t, "save d").done;
    expect(events.some((e) => e.kind === "approval")).toBe(false);
    expect(fs.readFileSync(path.join(dir(), "d.md"), "utf8")).toBe("d.md text");

    // Outside the space is still refused before anything is asked or written.
    const t2 = await call<string>("thread_create", { space: "school" });
    const walled = await start(t2, "escape").done;
    expect(walled.some((e) => e.kind === "approval")).toBe(false);
    expect(fs.existsSync(path.join(dir(), "..", "outside.md"))).toBe(false);
    expect(walled.find((e) => e.kind === "toolEnd")).toMatchObject({ status: "failed" });

    expect((await call<{ spaces: { space: string }[] }>("write_permissions_list", { space: "school" })).spaces).toEqual([{ space: "school", since: expect.any(Number) }]);
    await call("write_permission_set", { space: "school", scope: "space", allow: false });
    expect((await call<{ spaces: unknown[] }>("write_permissions_list", { space: "school" })).spaces).toEqual([]);
  });
});
