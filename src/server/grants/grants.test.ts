import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { vaultRoot } from "../core/vault.ts";
import {
  addAlways,
  checkRequest,
  cliDirs,
  covers,
  grantsFile,
  grantsFor,
  grantsView,
  loadGrants,
  otherSpaces,
  resolveOther,
  restoreGrant,
  revokeGrant,
  onceGrant,
} from "./grants.ts";
import "./commands.ts";

const env = tempHome();
afterAll(() => env.cleanup());

const v = (...p: string[]) => path.join(vaultRoot(), ...p);

beforeEach(() => {
  fs.rmSync(vaultRoot(), { recursive: true, force: true });
  for (const s of ["school", "work"]) fs.mkdirSync(v("spaces", s), { recursive: true });
  fs.mkdirSync(v("spaces/work/calendar"), { recursive: true });
  fs.mkdirSync(v("spaces/work/calendar-old"), { recursive: true });
  fs.writeFileSync(v("spaces/work/calendar/oct.md"), "Oct 14: shift 9-5");
});

function writeFile(value: unknown) {
  fs.mkdirSync(v(".phaethon"), { recursive: true });
  fs.writeFileSync(grantsFile(), JSON.stringify(value));
}

const entry = (id: string, p: string) => ({ id, to: "school", from: "work", path: p, created: "2026-10-10T00:00:00Z", scope: "always" });

describe("grants", () => {
  it("parses valid entries and ignores hostile ones", () => {
    writeFile({
      grants: [
        entry("a", "calendar"),
        entry("b", "../x"),
        entry("c", "/etc"),
        entry("d", ".phaethon"),
        entry("e", ""),
        entry("f", "calendar/../../school"),
        { id: "g", to: "school", from: "work", path: "calendar", scope: "once" },
        { id: "h", to: "work", from: "work", path: "calendar", scope: "always" },
        { id: "i", to: "school", from: "nope", path: "calendar", scope: "always" },
        { id: "j", to: "school", from: "../work", path: "calendar", scope: "always" },
        { id: "bad id!", to: "school", from: "work", path: "calendar", scope: "always" },
        "just a string",
        entry("a", "calendar-old"),
        entry("k", "./calendar-old/"),
      ],
    });
    const l = loadGrants();
    expect(l.grants.map((g) => g.id)).toEqual(["a", "k"]);
    expect(l.grants[1]!.path).toBe("calendar-old");
    expect(l.problems.length).toBe(12);
    expect(l.problems.some((p) => p.includes("appears twice"))).toBe(true);
    expect(l.problems).toContain("Entry 7 is skipped: it’s marked “once”, and only grants you chose to keep belong in this file.");
    expect(l.problems).toContain("Entry 8 is skipped: it lets work read itself.");
    expect(l.problems).toContain('Entry 9 is skipped: space "nope" does not exist in this vault.');

    writeFile(["not", "an", "object"]);
    const l2 = loadGrants();
    expect(l2.grants).toEqual([]);
    expect(l2.problems.length).toBe(1);
    fs.writeFileSync(grantsFile(), "{ not json");
    expect(loadGrants().problems.length).toBe(1);
    expect(() => addAlways("school", "work", "calendar")).toThrow("grants.json has a typing mistake, so Phaethon won’t change it.");
    expect(fs.readFileSync(grantsFile(), "utf8")).toBe("{ not json");
  });

  it("matches prefixes by component", () => {
    expect(covers("calendar", "calendar")).toBe(true);
    expect(covers("calendar", "calendar/oct.md")).toBe(true);
    expect(covers("calendar/oct.md", "calendar/oct.md")).toBe(true);
    expect(covers("calendar", "calendar-old")).toBe(false);
    expect(covers("calendar", "calendar-old/x.md")).toBe(false);
    expect(covers("calendar/oct", "calendar")).toBe(false);
    expect(covers("", "anything")).toBe(false);
  });

  it("adds, revokes, and keeps unknown entries", async () => {
    writeFile({ grants: [{ note: "hand-written" }], future: 1 });
    const g = addAlways("school", "work", "calendar/");
    expect(g.path).toBe("calendar");
    expect(g.id.length).toBe(36);
    expect(g.created.endsWith("Z") && g.created.length === 20).toBe(true);
    expect(addAlways("school", "work", "calendar").id).toBe(g.id);
    const shown = grantsView("school");
    expect(shown.grants.length).toBe(1);
    expect(shown.problems.length).toBe(1);
    expect(grantsView("work").grants).toEqual([]);
    expect(shown.incoming).toEqual([]);
    expect(grantsView("work").incoming).toEqual([{ id: g.id, to: "school", path: "calendar", created: g.created, scope: "always" }]);
    expect(await call("grants_list", { space: "work" })).toEqual(grantsView("work"));
    await expect(call("grants_list", { space: "../x" })).rejects.toThrow('"../x" is not a valid space name');
    const raw = fs.readFileSync(grantsFile(), "utf8");
    expect(raw).toContain("hand-written");
    expect(raw).toContain("future");
    expect(raw.endsWith("\n")).toBe(false);
    expect(await call("grant_revoke", { id: g.id })).toBe(true);
    expect(revokeGrant(g.id)).toBe(false);
    expect(grantsFor("school")).toEqual([]);
    expect(fs.readFileSync(grantsFile(), "utf8")).toContain("hand-written");
  });

  it("checks access requests", () => {
    expect(checkRequest("school", "work", "calendar/")).toBe("calendar");
    expect(checkRequest("school", "@work", "calendar/oct.md")).toBe("calendar/oct.md");
    for (const [space, p] of [
      ["school", "x"],
      ["nope", "calendar"],
      ["../work", "calendar"],
      ["work", ""],
      ["work", "../school"],
      ["work", "/etc"],
      ["work", ".phaethon"],
      ["work", "missing"],
    ] as const) {
      expect(() => checkRequest("school", space, p), `${space} ${p}`).toThrow();
    }
    fs.symlinkSync(os.tmpdir(), v("spaces/work/out"));
    expect(() => checkRequest("school", "work", "out")).toThrow();
    expect(otherSpaces("school")).toEqual(["work"]);
  });

  it("lists existing granted folders for CLIs", () => {
    writeFile({ grants: [entry("a", "calendar"), entry("b", "calendar/oct.md"), entry("c", "missing")] });
    const dirs = cliDirs("school");
    expect(dirs.length).toBe(1);
    expect(dirs[0]!.label).toBe("work/calendar");
    expect(dirs[0]!.path.endsWith(path.join("spaces", "work", "calendar"))).toBe(true);
    expect(cliDirs("work")).toEqual([]);
  });

  it("ids are unique v4 uuids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomUUID()));
    expect(ids.size).toBe(1000);
    const g = onceGrant("school", "work", "calendar");
    expect(g.id[14]).toBe("4");
    expect(g.scope).toBe("once");
  });

  it("restore puts back exactly what was revoked, once", async () => {
    const g = addAlways("school", "work", "calendar");
    expect(() => restoreGrant(g.id)).toThrow("That access can’t be put back any more.");
    expect(revokeGrant(g.id)).toBe(true);
    expect(loadGrants().grants).toEqual([]);
    expect(await call("grant_restore", { id: g.id })).toBeNull();
    expect(loadGrants().grants).toEqual([g]);
    expect(() => restoreGrant(g.id)).toThrow();
    expect(loadGrants().grants.length).toBe(1);
    expect(() => restoreGrant("x1")).toThrow();
  });

  it("resolves cross-space reads only inside the granted part", () => {
    writeFile({ grants: [entry("a", "calendar")] });
    fs.writeFileSync(v("spaces/work/secret.md"), "no");
    fs.symlinkSync(v("spaces/work/secret.md"), v("spaces/work/calendar/leak.md"));
    const { real, root } = resolveOther("school", "@work/calendar/oct.md");
    expect(real).toBe(path.join(fs.realpathSync.native(v("spaces/work")), "calendar/oct.md"));
    expect(root).toBe(fs.realpathSync.native(v("spaces/work")));
    expect(() => resolveOther("school", "@work/secret.md")).toThrow('"@work/secret.md" is in the work space; ask for access with request_access first');
    expect(() => resolveOther("school", "@work/calendar/leak.md")).toThrow("leads outside the part of the work space you have access to");
    expect(() => resolveOther("school", "@nope/x")).toThrow('there is no space called "nope"');
    expect(() => resolveOther("school", "@work/../school")).toThrow("must be a path inside the work space");
    expect(() => resolveOther("school", { space: "work", rel: "calendar/none.md" })).toThrow('"calendar/none.md" does not exist');
    // A once-grant from this turn counts too.
    expect(resolveOther("school", "@work/secret.md", true, [onceGrant("school", "work", "secret.md")]).real.endsWith("secret.md")).toBe(true);
  });
});
