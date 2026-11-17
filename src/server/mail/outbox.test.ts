import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { newPerson, readPerson } from "../people/people.ts";
import { setConnectors, updateMailSettings, resolveAccount } from "./access.ts";
import { FakeMail } from "./fake.ts";
import { checkAttachments, createDraft, disarmAll, discardDraft, MAX_ATTACHMENT_BYTES, openDraft, readDraft, recoverOutbox, sendDraft, stopSend, updateDraft } from "./outbox.ts";
import { decodeRef, encodeRef, guessProvider, pickMailbox } from "./types.ts";

const env = tempHome();
const file = path.join(os.tmpdir(), `phaethon-outbox-${process.pid}.json`);
const sent = () => (fs.existsSync(`${file}.sent.jsonl`) ? fs.readFileSync(`${file}.sent.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeAll(() => {
  ensureVault();
  fs.writeFileSync(file, JSON.stringify({ accounts: [{ id: "work", name: "Work", emails: ["me@corp.com"], fullName: "Me" }], messages: [] }));
  setConnectors({ fake: new FakeMail(file) });
  updateMailSettings((s) => {
    s.connectors = { fake: true };
    s.known = [
      { key: "fake:work", app: "fake", name: "Work", emails: ["me@corp.com"], fullName: "Me", provider: "exchange", enabled: true },
      { key: "fake:school", app: "fake", name: "School", emails: ["me@iu.edu"], provider: "school", enabled: true },
    ];
    s.access = { "fake:work": ["work"], "fake:school": ["school"] };
    s.sendDelaySeconds = 60;
  });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(`${file}.sent.jsonl`, { force: true });
});
afterAll(() => {
  disarmAll();
  setConnectors(undefined);
  fs.rmSync(file, { force: true });
  env.cleanup();
});

const fields = { to: ["dana@corp.com"], subject: "Hi", body: "Hello" };

describe("walls", () => {
  it("a space sees only its own accounts", () => {
    expect(resolveAccount("work", undefined).key).toBe("fake:work");
    expect(() => resolveAccount("work", "me@iu.edu")).toThrow(/isn’t one of this space’s mail accounts/);
    expect(() => resolveAccount("life", undefined)).toThrow(/No mail account is set up for this space/);
  });
});

describe("the outbox", () => {
  it("a draft never sends by itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = createDraft("work", fields, { intent: "draft" });
    expect(d).toMatchObject({ status: "draft", sender: "Me <me@corp.com>" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(readDraft("work", d.id).status).toBe("draft");
    expect(sent()).toEqual([]);
  });

  it("a send counts down 60 s, then sends, and lands on the recipient's card", async () => {
    newPerson({ name: "Dana Reyes", emails: ["dana@corp.com"] }, "work", "user");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = createDraft("work", fields, { intent: "send", thread: "123" });
    expect(d.status).toBe("scheduled");
    expect(d.sendAt! - Date.now()).toBe(60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readDraft("work", d.id).status).toBe("sent");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: ["dana@corp.com"], sender: "Me <me@corp.com>", subject: "Hi" });
    expect(readPerson("dana-reyes")!.interactions.at(-1)).toMatchObject({ channel: "email", direction: "out", summary: "Sent “Hi”", ref: { space: "work", thread: "123" } });
  });

  it("Stop cancels; Edit pauses; Send now sends at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = createDraft("work", fields, { intent: "send" });
    stopSend("work", a.id);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readDraft("work", a.id)).toMatchObject({ status: "draft", note: "Stopped. Nothing was sent." });

    const b = createDraft("work", fields, { intent: "send" });
    updateDraft("work", b.id, { body: "Hello, edited" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readDraft("work", b.id)).toMatchObject({ status: "draft", body: "Hello, edited", note: "Paused while you edit." });
    expect(sent()).toEqual([]);

    await sendDraft("work", b.id, 0);
    expect(readDraft("work", b.id).status).toBe("sent");
    expect(sent()[0].body).toBe("Hello, edited");
  });

  it("drafts only when sending is off, and when nobody is there", () => {
    updateMailSettings((s) => (s.allowSend = false));
    expect(createDraft("work", fields, { intent: "send" })).toMatchObject({ status: "draft", note: expect.stringMatching(/turned off/) });
    updateMailSettings((s) => (s.allowSend = true));
    expect(createDraft("work", fields, { intent: "send", unattended: true })).toMatchObject({ status: "draft", note: expect.stringMatching(/away/) });
  });

  it("a send whose time passed while Phaethon was closed goes back to draft; a future one is armed again", async () => {
    const past = createDraft("work", fields, { intent: "send" });
    const future = createDraft("work", fields, { intent: "send" });
    disarmAll();
    const raw = readDraft("work", past.id);
    fs.writeFileSync(path.join(env.home, "Phaethon/default/spaces/work/.phaethon/outbox", `${past.id}.json`), JSON.stringify({ ...raw, sendAt: Date.now() - 1000 }));
    expect(recoverOutbox(["work"])).toMatchObject({ reverted: 1, armed: expect.any(Number) });
    expect(readDraft("work", past.id)).toMatchObject({ status: "draft", note: expect.stringMatching(/closed before it was sent/) });
    expect(readDraft("work", future.id).status).toBe("scheduled");
    stopSend("work", future.id);
  });

  it("refuses bad addresses and a discarded or sent draft", async () => {
    expect(() => createDraft("work", { ...fields, to: ["not an address"] }, { intent: "draft" })).toThrow(/isn’t an email address/);
    const d = createDraft("work", fields, { intent: "draft" });
    discardDraft("work", d.id);
    await expect(sendDraft("work", d.id, 0)).rejects.toThrow(/can’t be sent/);
  });

  it("a send fails cleanly when the account is taken away from the space", async () => {
    const d = createDraft("work", fields, { intent: "draft" });
    updateMailSettings((s) => (s.access["fake:work"] = ["school"]));
    const r = await sendDraft("work", d.id, 0);
    expect(r).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer set up/) });
    updateMailSettings((s) => (s.access["fake:work"] = ["work"]));
  });
});

describe("types", () => {
  it("refs round-trip and reject anything else", () => {
    const r = { app: "apple-mail" as const, account: "ABC", mailbox: "INBOX: 📬", id: "42" };
    expect(decodeRef(encodeRef(r))).toEqual(r);
    expect(() => decodeRef("nonsense")).toThrow();
  });

  it("mailboxes by meaning, across providers", () => {
    expect(pickMailbox(["Inbox", "Sent Items"], "sent")).toBe("Sent Items");
    expect(pickMailbox(["INBOX", "Sent Messages"], "inbox")).toBe("INBOX");
    expect(pickMailbox(["Important", "Sent Mail", "All Mail"], "archive")).toBe("All Mail");
    expect(pickMailbox(["J*b"], "j*b")).toBe("J*b");
  });

  it("guesses the provider mark", () => {
    expect(guessProvider("iCloud", ["x@icloud.com"])).toBe("icloud");
    expect(guessProvider("imap", ["dev@gmail.com"], "Google")).toBe("gmail");
    expect(guessProvider("unknown", ["me@iu.edu"], "Exchange")).toBe("exchange");
    expect(guessProvider("imap", ["me@iu.edu"], "IU")).toBe("school");
    expect(guessProvider("unknown", ["me@corp.com"], "Exchange")).toBe("exchange");
  });
});

describe("attachments", () => {
  const put = (rel: string, content: string | number) => {
    const full = path.join(spaceDir("work"), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (typeof content === "number") {
      fs.writeFileSync(full, "");
      fs.truncateSync(full, content);
    } else fs.writeFileSync(full, content);
    return full;
  };

  it("attaches files from the space, and sends them with the message from where they are now", async () => {
    const essay = put("files/essay.pdf", "%PDF-1.4 essay");
    put("files/notes.md", "# notes");
    const d = createDraft("work", { ...fields, attachments: ["files/essay.pdf", "./files/notes.md", "files/essay.pdf"] }, { intent: "draft" });
    expect(d.attachments).toEqual([
      { path: "files/essay.pdf", name: "essay.pdf", size: 14 },
      { path: "files/notes.md", name: "notes.md", size: 7 },
    ]);
    await sendDraft("work", d.id, 0);
    expect(readDraft("work", d.id).status).toBe("sent");
    expect(sent().at(-1).attachments).toEqual([fs.realpathSync(essay), fs.realpathSync(path.join(spaceDir("work"), "files/notes.md"))]);
  });

  it("goes into the compose window too, and a message without files has no attachments field", async () => {
    put("files/essay.pdf", "%PDF");
    const opened = () => fs.readFileSync(`${file}.opened.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    await openDraft("work", createDraft("work", { ...fields, attachments: ["files/essay.pdf"] }, { intent: "draft" }).id);
    expect(opened().at(-1).attachments).toHaveLength(1);
    await sendDraft("work", createDraft("work", fields, { intent: "draft" }).id, 0);
    expect(sent().at(-1)).not.toHaveProperty("attachments");
    fs.rmSync(`${file}.opened.jsonl`, { force: true });
  });

  it("refuses anything that isn't a file inside this space", () => {
    put("files/a.txt", "a");
    fs.mkdirSync(path.join(spaceDir("school"), "files"), { recursive: true });
    fs.writeFileSync(path.join(spaceDir("school"), "files", "grades.txt"), "A");
    expect(() => checkAttachments("work", ["/etc/hosts"])).toThrow(/must be a path inside this space/);
    expect(() => checkAttachments("work", ["../school/files/grades.txt"])).toThrow(/must be a path inside this space/);
    expect(() => checkAttachments("work", [".phaethon/outbox"])).toThrow(/Phaethon's own state/);
    expect(() => checkAttachments("work", ["files/missing.pdf"])).toThrow(/does not exist/);
    expect(() => checkAttachments("work", ["files"])).toThrow(/is a folder; attach the files in it instead/);
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(spaceDir("school"), "files", "grades.txt"), path.join(spaceDir("work"), "files", "sneaky.txt"));
      expect(() => checkAttachments("work", ["files/sneaky.txt"])).toThrow(/leads outside this space/);
    }
    // A refused attachment makes no draft.
    expect(() => createDraft("work", { ...fields, attachments: ["/etc/hosts"] }, { intent: "send" })).toThrow();
  });

  it("keeps to ten files and 20 MB together", () => {
    const many = Array.from({ length: 11 }, (_, n) => (put(`files/many/${n}.txt`, "x"), `files/many/${n}.txt`));
    expect(() => checkAttachments("work", many)).toThrow("Attach at most 10 files to one email.");
    put("files/big-1.bin", MAX_ATTACHMENT_BYTES - 10);
    put("files/big-2.bin", 20);
    expect(checkAttachments("work", ["files/big-1.bin"])).toHaveLength(1);
    expect(() => checkAttachments("work", ["files/big-1.bin", "files/big-2.bin"])).toThrow(/over 20 MB together/);
  });

  it("can be removed on the card, and a file gone by the time it sends stops the send with its name", async () => {
    put("files/essay.pdf", "%PDF");
    put("files/slides.pdf", "%PDF");
    const d = createDraft("work", { ...fields, attachments: ["files/essay.pdf", "files/slides.pdf"] }, { intent: "draft" });
    expect(updateDraft("work", d.id, { attachments: ["files/slides.pdf"] }).attachments?.map((a) => a.name)).toEqual(["slides.pdf"]);
    expect(updateDraft("work", d.id, { subject: "Still here" }).attachments?.map((a) => a.name)).toEqual(["slides.pdf"]);
    fs.rmSync(path.join(spaceDir("work"), "files", "slides.pdf"));
    const failed = await sendDraft("work", d.id, 0);
    expect(failed).toMatchObject({ status: "failed", error: "“slides.pdf” isn’t at files/slides.pdf anymore, so the message wasn’t sent. Remove it or put it back, then send again." });
    expect(updateDraft("work", d.id, { attachments: [] }).attachments).toBeUndefined();
  });
});
