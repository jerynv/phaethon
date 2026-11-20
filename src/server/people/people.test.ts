import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { setConnectors, updateMailSettings } from "../mail/access.ts";
import { FakeMail } from "../mail/fake.ts";
import { mailToPeople } from "../jobs/builtin.ts";
import { addNotice, noticedIn, profilesForPrompt, readProfile, removeNotice, VAULT_NOTICED, writeProfile } from "../memory/profile.ts";
import { allPeople, findByEmail, findPeople, newPerson, readPerson } from "./people.ts";

const env = tempHome();
const file = path.join(os.tmpdir(), `phaethon-people-${process.pid}.json`);
beforeAll(() => ensureVault());
afterAll(() => {
  setConnectors(undefined);
  fs.rmSync(file, { force: true });
  env.cleanup();
});

describe("people", () => {
  it("my boss finds the manager, only in their spaces", () => {
    newPerson({ name: "Dana Reyes", relation: "manager", org: "Corp", emails: ["Dana@Corp.com"] }, "work", "user");
    newPerson({ name: "Prof. Lee", relation: "professor", aliases: ["CS101 prof"] }, "school", "user");
    expect(findPeople("work", "my boss").map((p) => p.id)).toEqual(["dana-reyes"]);
    expect(findPeople("school", "my boss")).toEqual([]);
    expect(findPeople("school", "cs101 prof").map((p) => p.id)).toEqual(["prof-lee"]);
    expect(findPeople("work", "dana@corp.com").map((p) => p.id)).toEqual(["dana-reyes"]);
    expect(findByEmail("DANA@corp.com")?.id).toBe("dana-reyes");
  });

  it("ids stay readable and unique", () => {
    expect(newPerson({ name: "Dana Reyes" }, "life", "user").id).toBe("dana-reyes-2");
  });

  it("the mail job logs headers on known cards and adds back-and-forth correspondents, never newsletters", async () => {
    const d = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        accounts: [{ id: "w", name: "Work", emails: ["me@corp.com"] }],
        messages: [
          { account: "w", mailbox: "INBOX", id: 1, from: "Dana Reyes <dana@corp.com>", to: ["me@corp.com"], subject: "Doctor appointment ok", date: d(20), body: "secret body" },
          { account: "w", mailbox: "INBOX", id: 2, from: "Sam Ortiz <sam@client.io>", to: ["me@corp.com"], subject: "Contract", date: d(3), body: "" },
          { account: "w", mailbox: "INBOX", id: 3, from: "Corp News <news@corp.com>", to: ["me@corp.com"], subject: "Weekly", date: d(2), body: "" },
          { account: "w", mailbox: "Sent Items", id: 4, from: "Me <me@corp.com>", to: ["Sam Ortiz <sam@client.io>"], subject: "Re: Contract", date: d(2), body: "" },
          { account: "w", mailbox: "Sent Items", id: 5, from: "Me <me@corp.com>", to: ["news@corp.com"], subject: "unsubscribe", date: d(1), body: "" },
          { account: "w", mailbox: "Sent Items", id: 6, from: "Me <me@corp.com>", to: ["dana@corp.com"], subject: "Vacation next week", date: d(25), body: "" },
        ],
      }),
    );
    setConnectors({ fake: new FakeMail(file) });
    updateMailSettings((s) => {
      s.connectors = { fake: true };
      s.known = [{ key: "fake:w", app: "fake", name: "Work", emails: ["me@corp.com"], provider: "exchange", enabled: true }];
      s.access = { "fake:w": ["work"] };
    });
    const result = await mailToPeople(new AbortController().signal, undefined);
    expect(result).toMatch(/Logged 4 emails.*added 1 person/);
    const dana = readPerson("dana-reyes")!;
    expect(dana.interactions.map((i) => [i.direction, i.summary])).toEqual([
      ["out", "“Vacation next week”"],
      ["in", "“Doctor appointment ok”"],
    ]);
    expect(JSON.stringify(dana)).not.toContain("secret body");
    expect(allPeople().find((p) => p.emails.includes("sam@client.io"))).toMatchObject({ name: "Sam Ortiz", source: "mail", spaces: ["work"] });
    expect(findByEmail("news@corp.com")).toBeUndefined();
    // Running again logs nothing twice.
    expect(await mailToPeople(new AbortController().signal, undefined)).toMatch(/Logged 0 emails/);
  });
});

describe("profiles", () => {
  it("agents add only under their heading; the user's words stay byte for byte", () => {
    const mine = "# About me\n\nI'm direct. Keep replies short.\n\n## Work\n\nCS student, part-time at Corp.\n";
    writeProfile({ kind: "vault" }, mine);
    expect(addNotice({ kind: "vault" }, "Plans the night before", { space: "work", at: Date.UTC(2026, 10, 1) })).toBe(true);
    expect(addNotice({ kind: "vault" }, "plans the night before", { space: "school" })).toBe(false);
    const after = readProfile({ kind: "vault" });
    expect(after.startsWith(mine.trimEnd())).toBe(true);
    expect(after).toContain(`${VAULT_NOTICED}\n- Plans the night before <!-- noticed 2026-11-01 in work -->`);
    expect(noticedIn(after, VAULT_NOTICED)).toEqual(["Plans the night before"]);
    expect(removeNotice({ kind: "vault" }, "Plans the night before")).toBe(true);
    expect(noticedIn(readProfile({ kind: "vault" }), VAULT_NOTICED)).toEqual([]);
  });

  it("both profiles reach the prompt, comments left out; an empty template doesn't", () => {
    writeProfile({ kind: "space", space: "work" }, "# How to act in work\n\n<!-- hint -->\n\nFormal with clients. Sign as J.\n");
    const p = profilesForPrompt("work")!;
    expect(p).toContain("I'm direct");
    expect(p).toContain("Formal with clients");
    expect(p).not.toContain("hint");
    writeProfile({ kind: "space", space: "school" }, "# How to act in school\n\n<!-- nothing yet -->\n\n## Noticed in this space\n");
    expect(profilesForPrompt("school")).not.toContain("How to act in this space");
  });
});

describe("profile editor split", () => {
  it("the editor gets the person's own words; saving keeps the agents' lines exactly", async () => {
    const { splitProfile, writeMine, addNotice, readProfile } = await import("../memory/profile.ts");
    writeProfile({ kind: "space", space: "school" }, "# How to act in school\n\n<!-- hint -->\n\nCasual, first names.\n\n## Noticed in this space\n\n- Likes lists <!-- noticed 2026-11-01 in school -->\n");
    expect(splitProfile({ kind: "space", space: "school" })).toEqual({ mine: "Casual, first names.", noticed: ["Likes lists"], exists: true });
    writeMine({ kind: "space", space: "school" }, "Casual, first names.\nNever use em dashes.");
    const after = readProfile({ kind: "space", space: "school" });
    expect(after).toContain("Never use em dashes.");
    expect(after).toContain("- Likes lists <!-- noticed 2026-11-01 in school -->");
    expect(after).not.toContain("hint");
    addNotice({ kind: "space", space: "school" }, "Plans on Sundays", { space: "school" });
    expect(splitProfile({ kind: "space", space: "school" })).toMatchObject({ mine: "Casual, first names.\nNever use em dashes.", noticed: ["Likes lists", "Plans on Sundays"] });
    // A fresh profile: no template text leaks into the editor.
    expect(splitProfile({ kind: "space", space: "work" }).mine).not.toContain("<!--");
  });
});
