import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { symlink } from "../../../tests/fs.ts";
import { ensureVault, spaceDir, vaultRoot } from "../core/vault.ts";
import { readSpaceMeta } from "../spaces/meta.ts";
import { touchedIn } from "./relevant.ts";
import { checkFileName } from "./manage.ts";
import "./commands.ts";

/** The Files view's commands against a real space folder. */

const env = tempHome();
afterAll(() => env.cleanup());

let school = "";
const at = (...p: string[]) => path.join(school, ...p);
const write = (rel: string, text: string, mtime?: number) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
  if (mtime) fs.utimesSync(at(rel), mtime / 1000, mtime / 1000);
};
type Entry = { name: string; path: string; dir: boolean; size: number; count?: number; excluded?: boolean };
type Page = { path: string; entries: Entry[]; total: number; offset: number };
const names = (p: { entries: Entry[] }) => p.entries.map((e) => e.name);

beforeEach(() => {
  fs.rmSync(vaultRoot(), { recursive: true, force: true });
  ensureVault();
  school = spaceDir("school");
  write("notes/b.md", "bb", Date.UTC(2026, 0, 2));
  write("notes/a.md", "a", Date.UTC(2026, 0, 3));
  write("notes/c.txt", "cccc", Date.UTC(2026, 0, 1));
  write("notes/deep/x.md", "x");
  write("readme.md", "hi");
  write(".hidden", "h");
  write("files/report 2.pdf", "%PDF");
  write("files/report 10.pdf", "%PDF");
  write(".phaethon/space.json", "{}");
  delete process.env.PHAETHON_TRASH_DIR;
});
afterEach(() => {
  delete process.env.PHAETHON_TRASH_DIR;
});

describe("files_list", () => {
  it("lists one folder, folders first with counts, never the state folder, hidden files or links", async () => {
    symlink(at("notes"), at("link"), "dir");
    const root = await call<Page>("files_list", { space: "school", path: "" });
    expect(names(root)).toEqual(["files", "notes", "readme.md"]);
    expect(root.entries.find((e) => e.name === "notes")).toMatchObject({ dir: true, count: 4 });
    expect(root.total).toBe(3);
  });

  it("sorts by name (numbers in order), modified, size or type, either way", async () => {
    expect(names(await call<Page>("files_list", { space: "school", path: "files" }))).toEqual(["report 2.pdf", "report 10.pdf"]);
    expect(names(await call<Page>("files_list", { space: "school", path: "notes", sort: "modified" }))).toEqual(["deep", "a.md", "b.md", "c.txt"]);
    expect(names(await call<Page>("files_list", { space: "school", path: "notes", sort: "size" }))).toEqual(["deep", "c.txt", "b.md", "a.md"]);
    expect(names(await call<Page>("files_list", { space: "school", path: "notes", sort: "type" }))).toEqual(["deep", "a.md", "b.md", "c.txt"]);
    expect(names(await call<Page>("files_list", { space: "school", path: "notes", sort: "name", desc: true }))).toEqual(["deep", "c.txt", "b.md", "a.md"]);
  });

  it("pages a big folder", async () => {
    for (let i = 0; i < 30; i++) write(`big/f${String(i).padStart(2, "0")}.txt`, "x");
    const first = await call<Page>("files_list", { space: "school", path: "big", limit: 10 });
    const third = await call<Page>("files_list", { space: "school", path: "big", limit: 10, offset: 20 });
    expect(first.total).toBe(30);
    expect(names(first)[0]).toBe("f00.txt");
    expect(names(third)).toHaveLength(10);
    expect(names(third)[9]).toBe("f29.txt");
  });

  it("shows hidden files when the space's setting says so, and uses its default sort", async () => {
    await call("files_settings_set", { space: "school", showHidden: true, sort: "modified" });
    expect(names(await call<Page>("files_list", { space: "school", path: "" }))).toContain(".hidden");
    expect(names(await call<Page>("files_list", { space: "school", path: "" }))).not.toContain(".phaethon");
    expect(names(await call<Page>("files_list", { space: "school", path: "notes" }))).toEqual(["deep", "a.md", "b.md", "c.txt"]);
  });

  it("refuses paths outside the space, into the state folder, through links, or that aren't folders", async () => {
    symlink(vaultRoot(), at("out"), "dir");
    await expect(call("files_list", { space: "school", path: "../work" })).rejects.toThrow("isn’t a folder in this space");
    await expect(call("files_list", { space: "school", path: ".phaethon" })).rejects.toThrow("isn’t a folder in this space");
    await expect(call("files_list", { space: "school", path: "out" })).rejects.toThrow("isn’t a folder in this space");
    await expect(call("files_list", { space: "school", path: "readme.md" })).rejects.toThrow("isn’t a folder in this space");
    await expect(call("files_list", { space: "school", path: "gone" })).rejects.toThrow("isn’t in this space any more");
  });
});

describe("files_find and files_recent", () => {
  it("finds names anywhere in the space, any case, folders first", async () => {
    const found = await call<{ entries: Entry[]; truncated: boolean }>("files_find", { space: "school", query: "MD" });
    expect(found.entries.map((e) => e.path)).toEqual(["notes/a.md", "notes/b.md", "readme.md", "notes/deep/x.md"]);
    expect((await call<{ entries: Entry[] }>("files_find", { space: "school", query: "deep" })).entries[0]).toMatchObject({ path: "notes/deep", dir: true, count: 1 });
    expect((await call<{ entries: Entry[] }>("files_find", { space: "school", query: "space.json" })).entries).toEqual([]);
  });

  it("lists the newest files first", async () => {
    write("fresh.md", "new");
    const recent = await call<{ entries: Entry[] }>("files_recent", { space: "school" });
    expect(recent.entries[0]!.path).toBe("fresh.md");
    expect(recent.entries.every((e) => !e.dir)).toBe(true);
    expect(recent.entries.map((e) => e.path)).not.toContain(".hidden");
  });
});

describe("changing files", () => {
  it("renames, keeping the folder, and never over another file", async () => {
    expect(await call("file_rename", { space: "school", path: "notes/a.md", name: "alpha.md" })).toEqual({ path: "notes/alpha.md" });
    expect(fs.existsSync(at("notes/alpha.md"))).toBe(true);
    await expect(call("file_rename", { space: "school", path: "notes/alpha.md", name: "b.md" })).rejects.toThrow("There’s already something called “b.md”");
    await expect(call("file_rename", { space: "school", path: "notes/alpha.md", name: "../x.md" })).rejects.toThrow("can’t contain /");
    await expect(call("file_rename", { space: "school", path: "notes/alpha.md", name: ".phaethon" })).rejects.toThrow("kept for Phaethon");
    await expect(call("file_rename", { space: "school", path: "", name: "x" })).rejects.toThrow("Choose a file or folder");
    await expect(call("file_rename", { space: "school", path: ".phaethon/space.json", name: "x" })).rejects.toThrow();
  });

  it("moves into a folder, never into itself or over a file", async () => {
    expect(await call("file_move", { space: "school", path: "readme.md", to: "notes" })).toEqual({ path: "notes/readme.md" });
    expect(await call("file_move", { space: "school", path: "notes/readme.md", to: "" })).toEqual({ path: "readme.md" });
    await expect(call("file_move", { space: "school", path: "notes", to: "notes/deep" })).rejects.toThrow("into itself");
    write("files/a.md", "dup");
    await expect(call("file_move", { space: "school", path: "files/a.md", to: "notes" })).rejects.toThrow("already something called “a.md”");
    await expect(call("file_move", { space: "school", path: "readme.md", to: ".phaethon" })).rejects.toThrow("isn’t a folder in this space");
  });

  it("makes a folder", async () => {
    expect(await call("folder_create", { space: "school", parent: "notes", name: "Week 2" })).toEqual({ path: "notes/Week 2" });
    expect(fs.statSync(at("notes/Week 2")).isDirectory()).toBe(true);
    await expect(call("folder_create", { space: "school", parent: "notes", name: "Week 2" })).rejects.toThrow("already something called");
  });

  it("deletes for good where there is no trash, and says so", async () => {
    expect((await call<{ canTrash: boolean }>("files_settings", { space: "school" })).canTrash).toBe(false);
    expect(await call("file_delete", { space: "school", path: "notes/deep" })).toEqual({ trashed: false });
    expect(fs.existsSync(at("notes/deep"))).toBe(false);
    await expect(call("file_delete", { space: "school", path: "" })).rejects.toThrow("Choose a file or folder");
    await expect(call("file_delete", { space: "school", path: ".phaethon" })).rejects.toThrow();
    expect(fs.existsSync(at(".phaethon/space.json"))).toBe(true);
  });

  it("moves to the trash where there is one", async () => {
    process.env.PHAETHON_TRASH_DIR = path.join(env.home, "trash");
    expect((await call<{ canTrash: boolean }>("files_settings", { space: "school" })).canTrash).toBe(true);
    expect(await call("file_delete", { space: "school", path: "readme.md" })).toEqual({ trashed: true });
    expect(fs.existsSync(at("readme.md"))).toBe(false);
    expect(fs.readFileSync(path.join(env.home, "trash/readme.md"), "utf8")).toBe("hi");
  });

  it("never deletes through a link", async () => {
    symlink(at("notes"), at("link"), "dir");
    await expect(call("file_delete", { space: "school", path: "link" })).rejects.toThrow("isn’t a plain file or folder");
    expect(fs.existsSync(at("notes/a.md"))).toBe(true);
  });

  it("writes dropped files into the folder on show, or files/, numbering taken names", async () => {
    const data = Buffer.from("dropped").toString("base64");
    expect(await call("files_upload", { space: "school", folder: "", files: [{ name: "report 2.pdf", data }] })).toEqual({ paths: ["files/report 2 2.pdf"] });
    expect(await call("files_upload", { space: "school", folder: "notes", files: [{ name: "new.md", data }] })).toEqual({ paths: ["notes/new.md"] });
    expect(fs.readFileSync(at("notes/new.md"), "utf8")).toBe("dropped");
    await expect(call("files_upload", { space: "school", folder: "", files: [{ name: "../evil", data }] })).rejects.toThrow();
  });

  it("checks names", () => {
    expect(checkFileName("  Notes.md ")).toBe("Notes.md");
    expect(() => checkFileName("")).toThrow();
    expect(() => checkFileName("a\nb")).toThrow();
    expect(() => checkFileName("..")).toThrow();
  });
});

describe("files settings", () => {
  it("are saved in space.json beside its other fields, checked on the way in", async () => {
    await call("space_update", { id: "school", name: "School" }).catch(() => undefined);
    const s = await call<{ excluded: string[]; sort: string; showHidden: boolean }>("files_settings_set", { space: "school", excluded: ["notes/deep", "./files/"], sort: "size" });
    expect(s).toMatchObject({ excluded: ["notes/deep", "files"], sort: "size", showHidden: false });
    expect(readSpaceMeta("school").raw?.files).toEqual({ showHidden: false, sort: "size", excluded: ["notes/deep", "files"] });
    await expect(call("files_settings_set", { space: "school", excluded: ["../work"] })).rejects.toThrow("isn’t a folder in this space");
    await expect(call("files_settings_set", { space: "school", excluded: ["readme.md"] })).rejects.toThrow("isn’t a folder in this space");
    await expect(call("files_settings_set", { space: "school", excluded: [".phaethon"] })).rejects.toThrow("isn’t a folder in this space");
    await expect(call("files_settings_set", { space: "school", sort: "colour" })).rejects.toThrow("Sort by");
    const listed = await call<Page>("files_list", { space: "school", path: "notes" });
    expect(listed.entries.find((e) => e.name === "deep")?.excluded).toBe(true);
  });

  it("fall back to defaults for a hand-edited file", async () => {
    fs.writeFileSync(at(".phaethon/space.json"), JSON.stringify({ files: { showHidden: "yes", sort: 4, excluded: ["../x", "ok", 3, "OK"] } }));
    expect(await call("files_settings", { space: "school" })).toMatchObject({ showHidden: false, sort: "name", excluded: ["ok"] });
  });
});

describe("files_relevant", () => {
  it("collects reads, approved writes, the coding agents' tool records and attachments", () => {
    const got = touchedIn(
      [
        { role: "user", at: 1, content: [{ type: "phaethon_attachment", path: "attachments/2026-11-16/a.pdf" }] },
        {
          role: "assistant",
          at: 2,
          content: [
            { type: "tool_use", name: "read_file", input: { path: "notes/a.md" } },
            { type: "tool_use", name: "read_file", input: { path: "@work/x.md" } },
            { type: "tool_use", name: "list_files", input: { path: "notes" } },
          ],
        },
        {
          role: "user",
          at: 3,
          content: [
            { type: "phaethon_record", kind: "approval", path: "notes/plan.md", action: "create", allowed: true },
            { type: "phaethon_record", kind: "approval", path: "notes/no.md", action: "create", allowed: false },
            { type: "phaethon_record", kind: "tool", category: "read", status: "success", target: "readme.md", label: "Reading file", id: "1" },
            { type: "phaethon_record", kind: "tool", category: "command", status: "success", target: "ls notes", label: "Running", id: "2" },
          ],
        },
      ],
      0,
    );
    expect(got).toEqual([
      { path: "attachments/2026-11-16/a.pdf", how: "attached", at: 1 },
      { path: "notes/a.md", how: "read", at: 2 },
      { path: "notes/plan.md", how: "wrote", at: 3 },
      { path: "readme.md", how: "read", at: 3 },
    ]);
  });

  it("returns only files still in the space, newest first", async () => {
    const threads = at(".phaethon/threads");
    fs.mkdirSync(threads, { recursive: true });
    fs.writeFileSync(
      path.join(threads, "1.json"),
      JSON.stringify([
        { role: "assistant", at: 10, content: [{ type: "tool_use", name: "read_file", input: { path: "notes/a.md" } }] },
        { role: "assistant", at: 20, content: [{ type: "tool_use", name: "read_file", input: { path: "gone.md" } }] },
        { role: "assistant", at: 30, content: [{ type: "tool_use", name: "read_file", input: { path: "readme.md" } }] },
        { role: "assistant", at: 40, content: [{ type: "tool_use", name: "read_file", input: { path: "../work/x.md" } }] },
      ]),
    );
    const got = await call<{ path: string; how: string }[]>("files_relevant", { space: "school" });
    expect(got.map((g) => g.path)).toEqual(["readme.md", "notes/a.md"]);
  });
});
