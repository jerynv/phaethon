import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../shared/agent.ts";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { keychainSet, providerAccount, resetMemoryKeychain } from "../core/secrets.ts";
import { load, records, save } from "../core/thread.ts";
import { updateSettings } from "../settings/settings.ts";
import { anthropicReply, fakeServer } from "../providers/testing.ts";
import { readItems, writeItems } from "../memory/items.ts";
import { newPerson } from "../people/people.ts";
import { FakeMail } from "../mail/fake.ts";
import { setConnectors, updateMailSettings } from "../mail/access.ts";
import { disarmAll, readDraft } from "../mail/outbox.ts";
import { readSchedules } from "../jobs/schedules.ts";
import { runSchedule } from "../jobs/builtin.ts";
import "./commands.ts";
import "../mail/commands.ts";

const env = tempHome();
const T = "2000";
let servers: { close: () => Promise<void> }[] = [];
const mailFile = path.join(os.tmpdir(), `phaethon-life-mail-${process.pid}.json`);

beforeAll(() => {
  ensureVault();
  fs.writeFileSync(
    mailFile,
    JSON.stringify({
      accounts: [{ id: "work", name: "Work", emails: ["me@corp.com"], fullName: "Jeryn V", type: "exchange" }],
      messages: [{ account: "work", mailbox: "INBOX", id: 1, from: "Dana Reyes <dana@corp.com>", to: ["me@corp.com"], subject: "Vacation approved", date: "2026-10-01T15:00:00Z", body: "Enjoy the week off." }],
    }),
  );
  setConnectors({ fake: new FakeMail(mailFile) });
});
afterAll(() => {
  disarmAll();
  setConnectors(undefined);
  fs.rmSync(mailFile, { force: true });
  env.cleanup();
});
beforeEach(() => {
  resetMemoryKeychain();
  keychainSet(providerAccount("anthropic"), "sk-ant-test-key-0000");
  updateSettings({ provider: null, model: null, backend: "phaethon", providerModels: {}, providerUrls: {} });
  save("work", T, []);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const s of servers) await s.close();
  servers = [];
});

async function anthropic(replies: Parameters<typeof fakeServer>[0]) {
  const srv = await fakeServer(replies);
  servers.push(srv);
  process.env.PHAETHON_ANTHROPIC_BASE_URL = srv.url;
  return srv;
}

async function send(prompt: string, thread = T) {
  const ch = channel<AgentEvent>();
  await call("agent_send", { space: "work", thread, prompt, attachments: [], onEvent: ch });
  return ch.messages;
}

const systemOf = (seen: { json: any }) => JSON.stringify(seen.json.system);
const toolsOf = (seen: { json: any }) => (seen.json.tools as { name: string }[]).map((t) => t.name);

/** The coming Saturday at 6 am, local, as ISO with offset. */
function nextSaturday6(): { iso: string; ms: number } {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  d.setHours(6, 0, 0, 0);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return { iso: `${local}${sign}${hh}:${mm}`, ms: d.getTime() };
}

describe("memory through the agent loop", () => {
  it("remembers an event, keeps it out of small talk, brings it back for Saturday, closes it on the outcome, still recalls it", async () => {
    // Start midweek so "Saturday" and the fixture always refer to the same day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 18, 12));
    writeItems([]);
    const sat = nextSaturday6();
    const srv = await anthropic([
      anthropicReply([{ type: "tool_use", id: "toolu_r", name: "remember", input: { kind: "event", text: "Meeting with Dana", when: sat.iso, people: ["Dana"], keywords: ["meeting"] } }], "tool_use"),
      anthropicReply([{ type: "text", text: "Noted." }]),
      anthropicReply([{ type: "text", text: "Hi!" }]),
      anthropicReply([{ type: "text", text: "You have the 6 am meeting." }]),
      // The id exists only once step 1 ran: read it when the call comes.
      () => anthropicReply([{ type: "tool_use", id: "toolu_u", name: "update_memory", input: { id: readItems()[0]!.id, status: "done", outcome: "Attended; went well" } }], "tool_use"),
      anthropicReply([{ type: "text", text: "Great." }]),
      anthropicReply([{ type: "text", text: "Nothing planned." }]),
      anthropicReply([{ type: "tool_use", id: "toolu_c", name: "recall", input: { query: "meeting Dana" } }], "tool_use"),
      anthropicReply([{ type: "text", text: "It went well." }]),
    ]);

    // 1. Mentioned: saved, with a record under the reply.
    const e1 = await send("I have a meeting at 6 am on Saturday with Dana");
    expect(toolsOf(srv.seen[0]!)).toEqual(expect.arrayContaining(["remember", "update_memory", "recall", "person"]));
    const saved = e1.find((e) => e.kind === "record" && e.record.kind === "memory");
    expect(saved).toMatchObject({ record: { action: "saved", memoryKind: "event", text: "Meeting with Dana" } });
    const [item] = readItems();
    expect(item).toMatchObject({ kind: "event", when: sat.ms, status: "active", source: { space: "work", thread: T } });
    expect(records(load("work", T)).some((r) => r.kind === "memory")).toBe(true);

    // 2. Small talk: the front burner stays out of the prompt.
    await send("hi");
    expect(systemOf(srv.seen[2]!)).not.toContain("Possibly relevant right now");
    expect(systemOf(srv.seen[2]!)).not.toContain("Meeting with Dana");

    // 3. About Saturday morning: it comes along.
    await send("what does my Saturday morning look like?");
    expect(systemOf(srv.seen[3]!)).toContain("Possibly relevant right now");
    expect(systemOf(srv.seen[3]!)).toContain("Meeting with Dana");

    // 4. The outcome closes it.
    const e4 = await send("the meeting went well");
    expect(e4.find((e) => e.kind === "record" && e.record.kind === "memory")).toMatchObject({ record: { action: "closed", status: "done", outcome: "Attended; went well" } });
    expect(readItems()[0]).toMatchObject({ status: "done", outcome: "Attended; went well" });

    // 5. Off the front burner: Saturday questions no longer bring it.
    await send("what does my Saturday morning look like?");
    expect(systemOf(srv.seen[6]!)).not.toContain("Meeting with Dana");

    // 6. recall still finds it, with the conversation it came from.
    await send("how did that meeting with Dana go again?");
    const result = JSON.stringify(srv.seen[8]!.json.messages.at(-1));
    expect(result).toContain("Meeting with Dana");
    expect(result).toContain("Attended; went well");
    expect(result).toContain(`conversation work/${T}`);
  });

  it("refuses a vent and a secret, with how to do it right", async () => {
    const srv = await anthropic([
      anthropicReply(
        [
          { type: "tool_use", id: "toolu_v", name: "remember", input: { kind: "note", text: "User hates their boss" } },
          { type: "tool_use", id: "toolu_s", name: "remember", input: { kind: "note", text: "Work password is hunter2" } },
        ],
        "tool_use",
      ),
      anthropicReply([{ type: "text", text: "OK." }]),
    ]);
    const before = readItems().length;
    await send("ugh I hate my boss, and my password is hunter2");
    const results = JSON.stringify(srv.seen[1]!.json.messages.at(-1));
    expect(results).toContain("one-off remark");
    expect(results).toContain("secret");
    expect(readItems().length).toBe(before);
  });

  it("puts the boss's card in the prompt when the message says my boss", async () => {
    newPerson({ name: "Dana Reyes", relation: "manager", emails: ["dana@corp.com"], notes: ["Prefers a heads-up before 8 am"] }, "work", "user");
    const srv = await anthropic([anthropicReply([{ type: "text", text: "Sure." }])]);
    await send("tell my boss I'm running late");
    const sys = systemOf(srv.seen[0]!);
    expect(sys).toContain("People this message mentions");
    expect(sys).toContain("dana@corp.com");
    expect(sys).toContain("Prefers a heads-up before 8 am");
  });
});

describe("mail through the agent loop", () => {
  beforeAll(() => {
    updateMailSettings((s) => {
      s.connectors = { fake: true };
      s.known = [{ key: "fake:work", app: "fake", name: "Work", emails: ["me@corp.com"], fullName: "Jeryn V", provider: "exchange", enabled: true }];
      s.access = { "fake:work": ["work"] };
      s.sendDelaySeconds = 60;
      s.allowSend = true;
    });
  });

  it("offers mail tools only where an account is assigned", async () => {
    const srv = await anthropic([anthropicReply([{ type: "text", text: "Hi." }])]);
    await send("search my mail");
    expect(toolsOf(srv.seen[0]!)).toEqual(expect.arrayContaining(["mail_search", "mail_read", "draft_email"]));
    expect(systemOf(srv.seen[0]!)).toContain("me@corp.com");
  });

  it("finds and reads mail, drafts without sending, and a send is scheduled with a countdown", async () => {
    const srv = await anthropic([
      anthropicReply([{ type: "tool_use", id: "toolu_s", name: "mail_search", input: { from: "dana", days: 3650 } }], "tool_use"),
      (seen) => {
        const ref = /ref=([A-Za-z0-9_-]+)/.exec(JSON.stringify(seen.json.messages.at(-1)))![1]!;
        return anthropicReply([{ type: "tool_use", id: "toolu_m", name: "mail_read", input: { ref } }], "tool_use");
      },
      anthropicReply(
        [
          { type: "tool_use", id: "toolu_d", name: "draft_email", input: { to: ["dana@corp.com"], subject: "Running late", body: "Hi Dana,\n\nRunning 15 minutes late.\n\nJeryn", intent: "draft" } },
          { type: "tool_use", id: "toolu_e", name: "draft_email", input: { to: ["dana@corp.com"], subject: "Out sick", body: "Hi Dana,\n\nOut sick today.\n\nJeryn", intent: "send" } },
        ],
        "tool_use",
      ),
      anthropicReply([{ type: "text", text: "Both are ready." }]),
    ]);
    const events = await send("find Dana's vacation email, draft a late note, and send a sick note");
    expect(JSON.stringify(srv.seen[2]!.json.messages.at(-1))).toContain("Enjoy the week off.");
    const drafts = events.filter((e) => e.kind === "record" && e.record.kind === "mailDraft").map((e) => (e as { record: { id: string; intent: string } }).record);
    expect(drafts.map((d) => d.intent)).toEqual(["draft", "send"]);
    const draft = readDraft("work", drafts[0]!.id);
    expect(draft).toMatchObject({ status: "draft", sender: "Jeryn V <me@corp.com>", to: ["dana@corp.com"] });
    const sending = readDraft("work", drafts[1]!.id);
    expect(sending.status).toBe("scheduled");
    expect(sending.sendAt! - Date.now()).toBeGreaterThan(55_000);
    expect(JSON.stringify(srv.seen[3]!.json.messages.at(-1))).toContain("unless they stop or edit it");
    expect(fs.existsSync(`${mailFile}.sent.jsonl`)).toBe(false);
    await call("mail_draft_stop", { space: "work", id: sending.id });
    expect(readDraft("work", sending.id).status).toBe("draft");
  });

  it("attaches files from the space to a draft, and refuses one outside it", async () => {
    fs.mkdirSync(path.join(spaceDir("work"), "files"), { recursive: true });
    fs.writeFileSync(path.join(spaceDir("work"), "files", "essay.pdf"), "%PDF-1.4");
    const srv = await anthropic([
      anthropicReply(
        [
          { type: "tool_use", id: "toolu_a", name: "draft_email", input: { to: ["dana@corp.com"], subject: "My essay", body: "Hi Dana,\n\nAttached.\n\nJeryn", attachments: ["files/essay.pdf"], intent: "draft" } },
          { type: "tool_use", id: "toolu_b", name: "draft_email", input: { to: ["dana@corp.com"], subject: "Hosts", body: "…", attachments: ["/etc/hosts"], intent: "draft" } },
        ],
        "tool_use",
      ),
      anthropicReply([{ type: "text", text: "Ready." }]),
    ]);
    const events = await send("email Dana my essay");
    const offered = (srv.seen[0]!.json.tools as { name: string; input_schema: { properties: Record<string, unknown> } }[]).find((t) => t.name === "draft_email")!;
    expect(offered.input_schema.properties).toHaveProperty("attachments");
    const drafts = events.filter((e) => e.kind === "record" && e.record.kind === "mailDraft").map((e) => (e as { record: { id: string } }).record);
    expect(drafts).toHaveLength(1);
    expect(readDraft("work", drafts[0]!.id).attachments).toEqual([{ path: "files/essay.pdf", name: "essay.pdf", size: 8 }]);
    const results = JSON.stringify(srv.seen[1]!.json.messages.at(-1));
    expect(results).toContain("Attached: essay.pdf.");
    expect(results).toContain("must be a path inside this space");
  });
});

describe("unattended runs", () => {
  it("a scheduled task can read and draft but never writes, sends or makes schedules", async () => {
    const srv = await anthropic([
      anthropicReply(
        [
          { type: "tool_use", id: "toolu_w", name: "write_file", input: { path: "notes.md", contents: "x" } },
          { type: "tool_use", id: "toolu_e", name: "draft_email", input: { to: ["dana@corp.com"], subject: "Summary", body: "…", intent: "send" } },
        ],
        "tool_use",
      ),
      anthropicReply([{ type: "text", text: "Here is your summary." }]),
    ]);
    const before = readSchedules().length;
    const r = await runSchedule({ id: "s_test0001", space: "work", title: "Morning summary", prompt: "Summarize my mail", cron: "0 7 * * *", enabled: true, created: 0, updated: 0, origin: "user" });
    expect(toolsOf(srv.seen[0]!)).not.toContain("schedule_task");
    const results = JSON.stringify(srv.seen[1]!.json.messages.at(-1));
    expect(results).toContain("scheduled run with nobody there to approve a write");
    expect(fs.existsSync(path.join(spaceDir("work"), "notes.md"))).toBe(false);
    const rec = records(load("work", r.thread)).find((x) => x.kind === "mailDraft") as { id: string };
    expect(readDraft("work", rec.id)).toMatchObject({ status: "draft", note: expect.stringMatching(/while you were away/) });
    expect(readSchedules().length).toBe(before);
    expect(r.summary).toContain("Morning summary");
  });
});
