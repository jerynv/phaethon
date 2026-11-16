import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { newPerson } from "../people/people.ts";
import { setConnectors, updateMailSettings } from "./access.ts";
import { blockKey, draftForBlock, emailBlockPrompt, parseEmailBlock, resolveRecipients } from "./block.ts";
import { FakeMail } from "./fake.ts";
import { disarmAll, listDrafts, updateDraft } from "./outbox.ts";

const env = tempHome();
const file = path.join(os.tmpdir(), `phaethon-block-${process.pid}.json`);
beforeAll(() => {
  ensureVault();
  fs.writeFileSync(file, JSON.stringify({ accounts: [], messages: [] }));
  setConnectors({ fake: new FakeMail(file) });
  updateMailSettings((s) => {
    s.connectors = { fake: true };
    s.known = [{ key: "fake:work", app: "fake", name: "Work", emails: ["me@corp.com"], fullName: "Me", provider: "exchange", enabled: true }];
    s.access = { "fake:work": ["work"] };
  });
  newPerson({ name: "Dana Reyes", relation: "manager", emails: ["dana@corp.com"] }, "work", "user");
});
afterAll(() => {
  disarmAll();
  setConnectors(undefined);
  fs.rmSync(file, { force: true });
  env.cleanup();
});

const code = JSON.stringify({ to: ["my boss", "Ebony Woodward", "x@y.com"], subject: "Hi", body: "Hello" });

describe("email blocks", () => {
  it("parses leniently and refuses an empty one", () => {
    expect(parseEmailBlock('{"to":"a@b.co, c@d.co","subject":"S","body":"B"}').to).toEqual(["a@b.co", "c@d.co"]);
    expect(() => parseEmailBlock("{}")).toThrow(/no subject or message/);
    expect(() => parseEmailBlock("not json")).toThrow(/valid JSON/);
  });

  it("names become addresses from people; unknown ones are reported, never guessed", () => {
    expect(resolveRecipients("work", ["my boss", "Ebony Woodward", "X <x@y.com>"])).toEqual({ addresses: ["dana@corp.com", "x@y.com"], missing: ["Ebony Woodward"] });
  });

  it("one draft per block, found again by its fingerprint, never sent", () => {
    const a = draftForBlock("work", code);
    expect(a).toMatchObject({ status: "draft", to: ["dana@corp.com", "x@y.com"], missing: ["Ebony Woodward"], key: blockKey(code) });
    expect(draftForBlock("work", code).id).toBe(a.id);
    expect(listDrafts("work")).toHaveLength(1);
    // Adding an address clears what was missing.
    expect(updateDraft("work", a.id, { to: [...a.to, "ebony@corp.com"] }).missing).toBeUndefined();
  });

  it("send: true counts down only when addressed and allowed", () => {
    const s = draftForBlock("work", JSON.stringify({ to: ["dana@corp.com"], subject: "Now", body: "x", send: true }));
    expect(s.status).toBe("scheduled");
    const n = draftForBlock("work", JSON.stringify({ to: ["Nobody Known"], subject: "Later", body: "x", send: true }));
    expect(n).toMatchObject({ status: "draft", note: "Add who it goes to, then send." });
  });

  it("a space without an account is refused (the card offers to set mail up)", () => {
    expect(() => draftForBlock("school", code)).toThrow(/No mail account/);
    expect(emailBlockPrompt("school")).toContain("no mail account yet");
    expect(emailBlockPrompt("work")).toContain("Work <me@corp.com>");
  });
});

describe("people from email", () => {
  it("an address typed for a missing name becomes that person when the email is sent", async () => {
    const { sendDraft } = await import("./outbox.ts");
    const { findByEmail } = await import("../people/people.ts");
    const d = draftForBlock("work", JSON.stringify({ to: ["Ebony Woodard"], subject: "Addresses", body: "Hi" }));
    expect(d.missing).toEqual(["Ebony Woodard"]);
    const u = updateDraft("work", d.id, { to: ["ewoodard@corp.com"] });
    expect(u.names).toEqual({ "ewoodard@corp.com": "Ebony Woodard" });
    const sent = await sendDraft("work", d.id, 0);
    expect(sent).toMatchObject({ status: "sent", note: "Added Ebony Woodard to People." });
    expect(findByEmail("ewoodard@corp.com")).toMatchObject({ name: "Ebony Woodard", source: "mail", spaces: ["work"] });
    expect(findByEmail("ewoodard@corp.com")!.interactions.at(-1)).toMatchObject({ direction: "out", summary: "Sent “Addresses”" });
  });

  it("an unknown address takes the name its own mail uses; one with no name anywhere isn't added", async () => {
    const { createDraft, sendDraft } = await import("./outbox.ts");
    const { findByEmail } = await import("../people/people.ts");
    fs.writeFileSync(file, JSON.stringify({ accounts: [], messages: [{ account: "work", mailbox: "INBOX", id: 7, from: "Sam Ortiz <sam@client.io>", to: ["me@corp.com"], subject: "Hello", date: new Date().toISOString(), body: "" }] }));
    const d = createDraft("work", { to: ["sam@client.io", "nobody@void.io"], subject: "Re: Hello", body: "Hi Sam" }, { intent: "draft" });
    const sent = await sendDraft("work", d.id, 0);
    expect(sent.note).toBe("Added Sam Ortiz to People.");
    expect(findByEmail("sam@client.io")?.name).toBe("Sam Ortiz");
    expect(findByEmail("nobody@void.io")).toBeUndefined();
    // "Name <address>" in the draft is enough on its own.
    const n = createDraft("work", { to: ["Lee Park <lee@lab.edu>"], subject: "x", body: "y" }, { intent: "draft" });
    await sendDraft("work", n.id, 0);
    expect(findByEmail("lee@lab.edu")?.name).toBe("Lee Park");
  });
});
