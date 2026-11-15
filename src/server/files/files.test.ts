import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostOp } from "#shared/host.ts";
import { call, tempHome } from "../../../tests/harness.ts";
import { setHost, type Host } from "../host.ts";
import { ensureVault, spaceDir, vaultRoot } from "../core/vault.ts";
import { today } from "../attachments/attachments.ts";
import { addToSpace } from "./add.ts";
import { exportSpace, suggestedName } from "./export.ts";
import { isRunnable, openFile, target } from "./open.ts";
import { MAX_BYTES, MAX_TEXT, fileBytes, viewFile } from "./viewer.ts";

/** Course access stands in for the lms module: `courses/Calculus/...` is visible to school, README filtered. */
const courses = vi.hoisted(() => ({ root: "" }));
vi.mock("../lms/access.ts", async () => {
  const { resolveIn } = await import("../core/resolve.ts");
  return {
    visibleCourses: () => ({ courses: [] }),
    resolveCoursePath: (space: string, rel: string, mustExist: boolean) => {
      const [, course, ...sub] = rel.split("/");
      if (space !== "school" || course !== "Calculus") throw new Error("not visible");
      return resolveIn(path.join(courses.root, "Calculus"), sub.join("/") || ".", mustExist);
    },
    filterCourseText: (_space: string, rel: string, text: string) => (rel.endsWith("README.md") ? text.replace(/\*\*Grades\*\*.*\n/, "") : text),
  };
});
await import("./commands.ts");

const env = tempHome();
afterAll(() => env.cleanup());

function fakeHost(answer: (op: HostOp) => unknown): Host & { ops: HostOp[] } {
  const ops: HostOp[] = [];
  return {
    available: true,
    ops,
    call: async <T>(op: HostOp) => {
      ops.push(op);
      return answer(op) as T;
    },
    on: () => () => {},
  };
}

const v = (...p: string[]) => path.join(vaultRoot(), ...p);
let school = "";

beforeEach(() => {
  fs.rmSync(vaultRoot(), { recursive: true, force: true });
  ensureVault();
  school = spaceDir("school");
  fs.mkdirSync(path.join(school, "notes"), { recursive: true });
  fs.mkdirSync(path.join(school, ".phaethon"), { recursive: true });
  fs.writeFileSync(path.join(school, "notes/plan.md"), "# Plan\n\n$x^2$");
  fs.writeFileSync(path.join(school, "notes/guide.tex"), "\\documentclass{article}");
  fs.writeFileSync(path.join(school, "notes/run.py"), "print(1)");
  fs.writeFileSync(path.join(school, "notes/README"), "plain words");
  fs.writeFileSync(path.join(school, "notes/blob.bin"), Buffer.from([0, 159, 146, 150]));
  fs.writeFileSync(path.join(school, "notes/fig.png"), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(school, "notes/paper.pdf"), "%PDF-1.7");
  fs.writeFileSync(path.join(school, ".phaethon/thread.json"), "[]");
  fs.writeFileSync(v("spaces/work/secret.md"), "work secret");
  fs.writeFileSync(v("MANUAL.md"), "manual");
  courses.root = v("courses");
  setHost(fakeHost(() => null));
});

const view = (p: string) => viewFile("school", school, p);
const bytes = (p: string) => fileBytes("school", school, p);

describe("viewer", () => {
  it("shows each kind of file in the space", () => {
    const md = view("notes/plan.md");
    expect([md.kind, md.text, md.name]).toEqual(["markdown", "# Plan\n\n$x^2$", "plan.md"]);
    expect(view("notes/guide.tex").kind).toBe("tex");
    const py = view(" notes/run.py ");
    expect([py.kind, py.language, py.path]).toEqual(["text", "python", "notes/run.py"]);
    expect(view("notes/README").kind).toBe("text");
    const bin = view("notes/blob.bin");
    expect([bin.kind, bin.text]).toEqual(["other", null]);
    const png = view("notes/fig.png");
    expect([png.kind, png.mediaType, png.text]).toEqual(["image", "image/png", null]);
    expect([...bytes("notes/fig.png")]).toEqual([137, 80, 78, 71]);
    expect(bytes("notes/paper.pdf").toString()).toBe("%PDF-1.7");
    expect(() => bytes("notes/plan.md")).toThrow("This file type is not a binary preview input.");
    expect(() => view("notes")).toThrow("“notes” is a folder; the viewer shows files.");
  });

  it("office and media are bounded binary inputs, never text", () => {
    const payload = Buffer.from("renderer owns decoding, not the host");
    for (const [name, kind, media] of [
      ["notes/paper.DOCX", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["notes/data.xlsx", "spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["notes/lecture.pptx", "slides", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["notes/lecture.mp3", "audio", "audio/mpeg"],
      ["notes/lecture.m4a", "audio", "audio/mp4"],
      ["notes/lecture.wav", "audio", "audio/wav"],
      ["notes/lecture.ogg", "audio", "audio/ogg"],
      ["notes/lecture.oga", "audio", "audio/ogg"],
      ["notes/lecture.opus", "audio", "audio/ogg; codecs=opus"],
      ["notes/lecture.flac", "audio", "audio/flac"],
      ["notes/lecture.aac", "audio", "audio/aac"],
      ["notes/lecture.mp4", "video", "video/mp4"],
      ["notes/lecture.m4v", "video", "video/mp4"],
      ["notes/lecture.webm", "video", "video/webm"],
      ["notes/lecture.ogv", "video", "video/ogg"],
      ["notes/lecture.mov", "video", "video/quicktime"],
    ] as const) {
      fs.writeFileSync(path.join(school, name), payload);
      const got = view(name);
      expect([got.kind, got.mediaType, got.size], name).toEqual([kind, media, payload.length]);
      expect(got.text === null && got.language === null && !got.tooBig, name).toBe(true);
      expect(bytes(name).equals(payload), name).toBe(true);
    }
    for (const ext of ["docx", "xlsx", "pptx", "mp3", "mp4"]) {
      const name = `big.${ext}`;
      fs.writeFileSync(path.join(school, name), "");
      fs.truncateSync(path.join(school, name), MAX_BYTES + 1);
      const got = view(name);
      expect(got.tooBig && got.text === null, name).toBe(true);
      expect(() => bytes(name)).toThrow("larger than the viewer shows (40 MB at most)");
    }
    for (const ext of ["doc", "xls", "ppt", "docm", "xlsm", "pptm", "zip", "bin", "exe"]) {
      const name = `unsupported.${ext}`;
      fs.writeFileSync(path.join(school, name), Buffer.from([0, 255]));
      expect(view(name).kind, name).toBe("other");
      expect(() => bytes(name), name).toThrow();
    }
  });

  it.skipIf(!canSymlinkFiles)("binary previews keep space and course walls", () => {
    fs.writeFileSync(v("spaces/work/private.docx"), "private document");
    fs.writeFileSync(path.join(school, ".phaethon/private.docx"), "private state");
    symlink(v("spaces/work/private.docx"), path.join(school, "notes/escape.docx"));
    for (const p of ["../work/private.docx", ".phaethon/private.docx", "@work/private.docx", "notes/escape.docx"]) {
      expect(() => view(p), p).toThrow();
      expect(() => bytes(p), p).toThrow();
    }
    for (const course of ["Calculus", "Physics"]) {
      fs.mkdirSync(v("courses", course, "files"), { recursive: true });
      fs.writeFileSync(v("courses", course, "files/lecture.docx"), "course document");
    }
    expect(view("courses/Calculus/files/lecture.docx").kind).toBe("docx");
    expect(bytes("courses/Calculus/files/lecture.docx").toString()).toBe("course document");
    for (const hidden of ["courses/Physics/files/lecture.docx", "courses/Calculus/../Physics/files/lecture.docx"]) {
      expect(() => view(hidden), hidden).toThrow();
      expect(() => bytes(hidden), hidden).toThrow();
    }
    expect(() => viewFile("work", spaceDir("work"), "courses/Calculus/files/lecture.docx")).toThrow("isn’t among the courses this space can see.");
    symlink(v("spaces/work/private.docx"), v("courses/Calculus/files/escape.docx"));
    expect(() => bytes("courses/Calculus/files/escape.docx")).toThrow();
    expect(() => view("courses/Calculus")).toThrow("is a folder; the viewer shows files.");
    expect(() => view("courses")).toThrow("is a folder; the viewer shows files.");
  });

  it("filters a course README as the space may see it", () => {
    fs.mkdirSync(v("courses/Calculus"), { recursive: true });
    fs.writeFileSync(v("courses/Calculus/README.md"), "Calculus\n\n**Grades**: 91%\n");
    expect(view("courses/Calculus/README.md").text).not.toContain("91%");
  });

  it.skipIf(!canSymlinkFiles)("never reads outside the space", () => {
    symlink(v("spaces/work/secret.md"), path.join(school, "notes/link.md"));
    symlink(v("spaces/work"), path.join(school, "workdir"));
    symlink("/etc/hosts", path.join(school, "hosts.txt"));
    for (const bad of [
      "",
      "/etc/hosts",
      "/etc/passwd",
      "../work/secret.md",
      "../../MANUAL.md",
      "notes/../../work/secret.md",
      "@work/secret.md",
      "@school/notes/plan.md",
      ".phaethon/thread.json",
      "notes/link.md",
      "workdir/secret.md",
      "hosts.txt",
      "courses/Calculus II/syllabus.md",
      "missing.md",
    ]) {
      expect(() => view(bad), bad).toThrow();
      expect(() => bytes(bad), bad).toThrow();
    }
  });

  it("large files say so instead of loading", () => {
    fs.writeFileSync(path.join(school, "big.txt"), "");
    fs.truncateSync(path.join(school, "big.txt"), MAX_TEXT + 1);
    const t = view("big.txt");
    expect(t.tooBig && t.text === null).toBe(true);
    fs.writeFileSync(path.join(school, "big.pdf"), "");
    fs.truncateSync(path.join(school, "big.pdf"), MAX_BYTES + 1);
    expect(view("big.pdf").tooBig).toBe(true);
    expect(() => bytes("big.pdf")).toThrow("larger than the viewer shows");
  });
});

describe("open and reveal", () => {
  it.skipIf(!canSymlinkFiles)("only files inside the space can be opened", async () => {
    const real = target("school", school, "notes/plan.md");
    expect(real.endsWith(path.join("notes", "plan.md")) && fs.statSync(real).isFile()).toBe(true);
    expect(target("school", school, " notes/plan.md ")).toBe(real);
    expect(fs.statSync(target("school", school, "notes")).isDirectory()).toBe(true);
    const host = fakeHost(() => null);
    setHost(host);
    for (const bad of ["", "/etc/passwd", "../work/secret.md", "../../MANUAL.md", "notes/../../work/secret.md", "@work/secret.md", "@school/notes/plan.md", ".phaethon/thread.json", "missing.md"]) {
      expect(() => target("school", school, bad), bad).toThrow();
      await expect(openFile("school", school, bad, false)).rejects.toThrow();
      await expect(openFile("school", school, bad, true)).rejects.toThrow();
    }
    expect(host.ops).toEqual([]);
    expect(() => target("school", school, "missing.md")).toThrow("isn’t in this space");
    expect(() => target("school", school, "@work/secret.md")).toThrow("Only files in this space can be opened from here.");
    expect(() => target("school", school, "")).toThrow("No file was named.");
    symlink(v("spaces/work/secret.md"), path.join(school, "link.md"));
    expect(() => target("school", school, "link.md")).toThrow("can’t be opened: only files inside this space can be opened from here.");
    await call("file_open", { space: "school", path: "notes/plan.md" });
    await call("file_open", { space: "school", path: "notes/plan.md", reveal: true });
    expect(host.ops).toEqual([
      { op: "openPath", path: real },
      { op: "revealPath", path: real },
    ]);
  });

  it("show_space takes only a space id", async () => {
    fs.writeFileSync(v("spaces/notes.md"), "a file, not a space");
    symlink(v("memory"), v("spaces/linked"));
    symlink("/", v("spaces/root"));
    symlink(v("spaces/school"), v("spaces/alias"));
    const host = fakeHost(() => null);
    setHost(host);
    for (const bad of ["..", "../..", "", ".", "spaces", "school/..", "school/../work", "/", "/etc", "notes.md", "linked", "root", "alias", "School", "nope", "a.app"]) {
      await expect(call("space_show", { id: bad }), bad).rejects.toThrow("That space isn’t in your Phaethon folder any more.");
    }
    expect(host.ops).toEqual([]);
    await call("space_show", { id: "school" });
    expect(host.ops).toEqual([{ op: "openPath", path: school }]);
  });

  it("runnable files are only shown", async () => {
    const dir = path.join(env.home, "runnable");
    fs.mkdirSync(path.join(dir, "Tool.app"), { recursive: true });
    for (const f of ["run.command", "x.sh", "notes.md", "SETUP.PY"]) fs.writeFileSync(path.join(dir, f), "echo hi");
    expect(isRunnable(path.join(dir, "run.command"))).toBe(true);
    expect(isRunnable(path.join(dir, "x.sh"))).toBe(true);
    expect(isRunnable(path.join(dir, "SETUP.PY"))).toBe(true);
    expect(isRunnable(path.join(dir, "Tool.app"))).toBe(true);
    expect(isRunnable(path.join(dir, "notes.md"))).toBe(false);
    fs.chmodSync(path.join(dir, "notes.md"), 0o755);
    expect(isRunnable(path.join(dir, "notes.md"))).toBe(process.platform !== "win32");
    await expect(openFile("x", dir, "run.command", false)).rejects.toThrow("run a program");
    fs.writeFileSync(path.join(school, "setup.sh"), "x");
    const host = fakeHost(() => null);
    setHost(host);
    await expect(call("file_open", { space: "school", path: "setup.sh" })).rejects.toThrow("This file can run a program");
    await call("file_open", { space: "school", path: "setup.sh", reveal: true });
    expect(host.ops.map((o) => o.op)).toEqual(["revealPath"]);
  });
});

describe("export", () => {
  const contents = (zip: string) => {
    const files = unzipSync(fs.readFileSync(zip));
    return Object.entries(files).map(([name, data]) => [name, Buffer.from(data).toString()] as const);
  };

  it.skipIf(!canSymlinkFiles)("exports the files and conversations and nothing outside", async () => {
    fs.rmSync(path.join(school, "notes"), { recursive: true });
    fs.rmSync(path.join(school, ".phaethon"), { recursive: true });
    fs.mkdirSync(path.join(school, "notes/empty"), { recursive: true });
    fs.mkdirSync(path.join(school, ".phaethon/threads"), { recursive: true });
    fs.mkdirSync(path.join(school, "attachments/2026-10-10"), { recursive: true });
    fs.writeFileSync(path.join(school, "notes/plan.md"), "plan");
    fs.writeFileSync(path.join(school, ".phaethon/thread.json"), "[current]");
    fs.writeFileSync(path.join(school, ".phaethon/threads/1.json"), "[old]");
    fs.writeFileSync(path.join(school, "attachments/2026-10-10/a.png"), "png");
    fs.writeFileSync(v("outside.txt"), "outside");
    symlink(v("spaces/work/secret.md"), path.join(school, "leak.md"));
    symlink(v("spaces/work"), path.join(school, "work-link"));
    symlink("/etc", path.join(school, "notes/etc"));
    symlink(v("outside.txt"), path.join(school, ".phaethon/linked.json"));
    symlink(path.join(school, "notes/plan.md"), path.join(school, "plan-again.md"));
    const outDir = path.join(env.home, "export-out");
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, "School 2026-10-10.zip");
    expect(await exportSpace(school, "school", out)).toEqual({ file: out, files: 4 });
    const got = contents(out);
    expect(got.map(([n]) => n)).toEqual([
      "school/",
      "school/.phaethon/",
      "school/.phaethon/thread.json",
      "school/.phaethon/threads/",
      "school/.phaethon/threads/1.json",
      "school/attachments/",
      "school/attachments/2026-10-10/",
      "school/attachments/2026-10-10/a.png",
      "school/notes/",
      "school/notes/empty/",
      "school/notes/plan.md",
    ]);
    const text = (name: string) => got.find(([n]) => n === name)?.[1];
    expect(text("school/notes/plan.md")).toBe("plan");
    expect(text("school/.phaethon/thread.json")).toBe("[current]");
    for (const [, body] of got) expect(/secret|manual|outside/.test(body), body).toBe(false);
    expect(fs.existsSync(path.join(outDir, ".School 2026-10-10.zip.part"))).toBe(false);
  });

  it("a failed export leaves nothing under the name", async () => {
    const dir = path.join(env.home, "export-fail");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    const out = path.join(dir, "missing/School.zip");
    await expect(exportSpace(dir, "school", out)).rejects.toThrow("couldn’t be saved");
    expect(fs.existsSync(out)).toBe(false);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      fs.chmodSync(path.join(dir, "a.md"), 0o000);
      const out2 = path.join(env.home, "export-fail-out", "School.zip");
      fs.mkdirSync(path.dirname(out2), { recursive: true });
      await expect(exportSpace(dir, "school", out2)).rejects.toThrow("“a.md” couldn’t be read");
      expect(fs.existsSync(out2) || fs.existsSync(path.join(path.dirname(out2), ".School.zip.part"))).toBe(false);
      fs.chmodSync(path.join(dir, "a.md"), 0o644);
    }
  });

  it("names exports safely", () => {
    const d = today();
    expect(suggestedName("School", "school")).toBe(`School ${d}.zip`);
    expect(suggestedName("a/b: c?", "x")).toBe(`ab c ${d}.zip`);
    expect(suggestedName("..", "side-project")).toBe(`side-project ${d}.zip`);
  });

  it("space_export asks where in a save dialog and export_show reveals it", async () => {
    await expect(call("export_show")).rejects.toThrow("There’s no export to show yet.");
    const dest = path.join(env.home, "Downloads-test", "School.zip");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const host = fakeHost((op) => (op.op === "saveFile" ? dest : null));
    setHost(host);
    expect(await call("space_export", { id: "school" })).toEqual({ fileName: "School.zip", files: 8 });
    expect(host.ops[0]).toEqual({
      op: "saveFile",
      title: "Export School",
      defaultPath: path.join(env.home, "Downloads", `School ${today()}.zip`),
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    await call("export_show");
    expect(host.ops[1]).toEqual({ op: "revealPath", path: dest });
    setHost(fakeHost(() => null));
    expect(await call("space_export", { id: "school" })).toBeNull();
  });
});

describe("add files", () => {
  const setup = () => {
    const docs = path.join(env.home, `Documents-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(docs, { recursive: true });
    return { space: spaceDir("work"), docs };
  };

  it.skipIf(!canSymlinkFiles)("copies a folder whole, without hidden files or links", async () => {
    const { space, docs } = setup();
    const scool = path.join(docs, "Scool");
    fs.mkdirSync(path.join(scool, "2026/empty"), { recursive: true });
    fs.mkdirSync(path.join(scool, ".git"));
    fs.writeFileSync(path.join(scool, "2026/Resume.pdf"), "%PDF-1.7");
    fs.writeFileSync(path.join(scool, "notes.md"), "hi");
    fs.writeFileSync(path.join(scool, ".DS_Store"), "x");
    fs.writeFileSync(path.join(scool, ".git/config"), "x");
    fs.writeFileSync(path.join(docs, "secret.txt"), "no");
    symlink(path.join(docs, "secret.txt"), path.join(scool, "link.txt"));
    const added = await addToSpace(space, vaultRoot(), [scool]);
    expect(added).toEqual({ paths: ["files/Scool"], files: 2, skipped: 3 });
    expect(fs.readFileSync(path.join(space, "files/Scool/2026/Resume.pdf"), "utf8")).toBe("%PDF-1.7");
    expect(fs.readFileSync(path.join(space, "files/Scool/notes.md"), "utf8")).toBe("hi");
    expect(fs.statSync(path.join(space, "files/Scool/2026/empty")).isDirectory()).toBe(true);
    for (const gone of [".DS_Store", ".git", "link.txt"]) expect(fs.existsSync(path.join(space, "files/Scool", gone)), gone).toBe(false);
    expect(fs.existsSync(path.join(scool, "notes.md"))).toBe(true);
    const again = await addToSpace(space, vaultRoot(), [scool]);
    expect(again.paths).toEqual(["files/Scool 2"]);
    expect(fs.readdirSync(path.join(space, "files")).length).toBe(2);
  });

  it("numbers a taken name and never replaces anything", async () => {
    const { space, docs } = setup();
    fs.writeFileSync(path.join(docs, "Resume.pdf"), "1");
    fs.writeFileSync(path.join(docs, "cover.txt"), "2");
    fs.mkdirSync(path.join(space, "files"), { recursive: true });
    fs.writeFileSync(path.join(space, "files/Resume.pdf"), "old");
    const added = await addToSpace(space, vaultRoot(), [path.join(docs, "Resume.pdf"), path.join(docs, "cover.txt")]);
    expect(added.paths).toEqual(["files/Resume 2.pdf", "files/cover.txt"]);
    expect(added.files).toBe(2);
    expect(fs.readFileSync(path.join(space, "files/Resume.pdf"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(space, "files/Resume 2.pdf"), "utf8")).toBe("1");
  });

  it.skipIf(!canSymlinkFiles)("never writes through a dangling link or a linked files folder (fixed Rust bug)", async () => {
    const { space, docs } = setup();
    const outside = path.join(docs, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(docs, "notes.md"), "mine");
    fs.mkdirSync(path.join(space, "files"));
    symlink(path.join(outside, "planted.md"), path.join(space, "files/notes.md"));
    const added = await addToSpace(space, vaultRoot(), [path.join(docs, "notes.md")]);
    expect(added.paths).toEqual(["files/notes 2.md"]);
    expect(fs.existsSync(path.join(outside, "planted.md"))).toBe(false);
    fs.rmSync(path.join(space, "files"), { recursive: true });
    symlink(outside, path.join(space, "files"));
    await expect(addToSpace(space, vaultRoot(), [path.join(docs, "notes.md")])).rejects.toThrow("The space’s files folder couldn’t be made");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses the vault itself and what holds it", async () => {
    const { space } = setup();
    await expect(addToSpace(space, vaultRoot(), [v("MANUAL.md")])).rejects.toThrow("already in your Phaethon folder");
    await expect(addToSpace(space, vaultRoot(), [path.dirname(vaultRoot())])).rejects.toThrow("holds your Phaethon folder");
    expect(fs.existsSync(path.join(space, "files"))).toBe(false);
  });

  it("too many files adds nothing", async () => {
    const { space, docs } = setup();
    const big = path.join(docs, "big");
    fs.mkdirSync(big);
    for (let i = 0; i <= 5000; i++) fs.writeFileSync(path.join(big, `${i}.txt`), "");
    await expect(addToSpace(space, vaultRoot(), [big])).rejects.toThrow(/more than 5000 files.*nothing was added/);
    expect(fs.existsSync(path.join(space, "files"))).toBe(false);
  });

  it("space_add copies only what the picker chose", async () => {
    const { docs } = setup();
    fs.writeFileSync(path.join(docs, "a.txt"), "a");
    const host = fakeHost((op) => (op.op === "pickFiles" ? [path.join(docs, "a.txt")] : null));
    setHost(host);
    expect(await call("space_add", { id: "work", folder: false })).toEqual({ paths: ["files/a.txt"], files: 1, skipped: 0 });
    expect(host.ops[0]).toEqual({ op: "pickFiles", title: "Add files to Work", defaultPath: path.join(env.home, "Documents"), multiple: true });
    expect(await call("space_add", { id: "work", folder: true })).toBeNull();
    expect(host.ops[1]).toMatchObject({ op: "pickFolder", title: "Add a folder to Work" });
  });
});
