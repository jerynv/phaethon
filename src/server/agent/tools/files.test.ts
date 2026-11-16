import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../../tests/harness.ts";
import { symlink } from "../../../../tests/fs.ts";
import { ensureVault, spaceDir, vaultRoot } from "../../core/vault.ts";
import { updateFilesSettings } from "../../files/settings.ts";
import { describeWrite, listFiles, readFile, readPage, runWrite, searchFiles, type ToolCtx } from "./files.ts";

/**
 * Folders a space's Files settings exclude are closed to Phaethon's own
 * agent: every file tool refuses them (by name, by real path through a link,
 * and through a grant from another space), listings leave them out and
 * searches skip them.
 */

const env = tempHome();
afterAll(() => env.cleanup());

let school = "";
let work = "";
const ctx = (once: ToolCtx["once"] = []): ToolCtx => ({ space: "school", root: school, once });
const REFUSED = /is inside "private\/", a folder this space's settings keep from Phaethon's agent \(Settings › Spaces › Files\)/;

beforeEach(() => {
  fs.rmSync(vaultRoot(), { recursive: true, force: true });
  ensureVault();
  school = spaceDir("school");
  work = spaceDir("work");
  fs.mkdirSync(path.join(school, "private/deep"), { recursive: true });
  fs.mkdirSync(path.join(school, "notes"), { recursive: true });
  fs.writeFileSync(path.join(school, "private/diary.md"), "secret banana");
  fs.writeFileSync(path.join(school, "private/deep/scan.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(school, "notes/week1.md"), "public banana");
  updateFilesSettings("school", { excluded: ["private"] });
});

describe("excluded folders", () => {
  it("are refused by read_file, read_page and list_files, by name in any case", async () => {
    expect(() => readFile(ctx(), "private/diary.md")).toThrow(REFUSED);
    expect(() => readFile(ctx(), "./Private/diary.md")).toThrow(/a folder this space's settings keep from Phaethon's agent/);
    expect(() => listFiles(ctx(), "private")).toThrow(REFUSED);
    expect(() => listFiles(ctx(), "private/deep")).toThrow(REFUSED);
    await expect(readPage(ctx(), "private/deep/scan.pdf", 1)).rejects.toThrow(REFUSED);
    expect(readFile(ctx(), "notes/week1.md")).toBe("public banana");
  });

  it("are left out of listings, which say how many, and skipped by search", () => {
    const root = listFiles(ctx(), "");
    expect(root).toContain("notes/");
    expect(root).not.toContain("private");
    expect(root).toContain("(1 folder left out: the user keeps it from Phaethon's agent)");
    const hits = searchFiles(ctx(), "banana", "");
    expect(hits).toContain("notes/week1.md");
    expect(hits).not.toContain("diary");
    expect(() => searchFiles(ctx(), "banana", "private")).toThrow(REFUSED);
  });

  it("can't be written, before asking or after", () => {
    expect(() => describeWrite(ctx(), "private/new.md", "x")).toThrow(REFUSED);
    const plan = describeWrite(ctx(), "notes/new.md", "x");
    updateFilesSettings("school", { excluded: ["private", "notes"] });
    expect(() => runWrite(ctx(), plan, "x")).toThrow(/is inside "notes\/"/);
    expect(fs.existsSync(path.join(school, "notes/new.md"))).toBe(false);
  });

  it("can't be reached through a link inside the space", () => {
    symlink(path.join(school, "private"), path.join(school, "shortcut"), "dir");
    expect(() => readFile(ctx(), "shortcut/diary.md")).toThrow(REFUSED);
    expect(() => listFiles(ctx(), "shortcut")).toThrow(REFUSED);
  });

  it("are refused through a grant from another space, and left out of its listing", () => {
    fs.mkdirSync(path.join(work, "shared/hr"), { recursive: true });
    fs.writeFileSync(path.join(work, "shared/hr/salary.md"), "numbers");
    fs.writeFileSync(path.join(work, "shared/plan.md"), "plan");
    updateFilesSettings("work", { excluded: ["shared/hr"] });
    const once = [{ from: "work", path: "shared" }];
    expect(readFile(ctx(once), "@work/shared/plan.md")).toBe("plan");
    expect(() => readFile(ctx(once), "@work/shared/hr/salary.md")).toThrow(/is inside "shared\/hr\/"/);
    expect(listFiles(ctx(once), "@work/shared")).not.toContain("hr/");
    expect(searchFiles(ctx(once), "numbers", "@work/shared")).not.toContain("salary");
  });

  it("stop applying when the setting is cleared", () => {
    updateFilesSettings("school", { excluded: [] });
    expect(readFile(ctx(), "private/diary.md")).toBe("secret banana");
  });
});
