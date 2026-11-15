import { persistedPath } from "../fullaccess/fullaccess.ts";
import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { HostOp } from "#shared/host.ts";
import { call, tempHome } from "../../../tests/harness.ts";
import { setHost, type Host } from "../host.ts";
import { appFiles, ensureVault, spaceDir, vaultRoot } from "../core/vault.ts";
import { claim, release } from "../core/runs.ts";
import { readSession, writeSession } from "../threads/store.ts";
import { fullAccessList, isFullAccess, setFullAccess } from "../fullaccess/fullaccess.ts";
import { bindWorkspace, clearWorkspace, getWorkspace, resolveWorkspace, workingDirFor, type Where } from "./workspace.ts";
import "./commands.ts";
import "../fullaccess/commands.ts";

const env = tempHome();
afterAll(() => env.cleanup());

let n = 0;
type Fixture = { root: string; vault: string; managed: string; file: string; project: string; where: Where };

function fixture(): Fixture {
  const root = path.join(env.home, `ws-${n++}`);
  const vault = path.join(root, "vault");
  const managed = path.join(vault, "spaces/work");
  const file = path.join(root, "app-data/workspaces.json");
  const project = path.join(root, "A project with spaces");
  fs.mkdirSync(managed, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "keep.txt"), "existing project");
  return { root, vault, managed, file, project, where: { file, root: vault } };
}

const managedView = (dir: string) => ({ path: dir, kind: "managed", available: true });

describe("workspace bindings", () => {
  it("managed by default; a pick persists; clear never changes project files", () => {
    const f = fixture();
    expect(getWorkspace("work", f.managed, f.where)).toEqual(managedView(f.managed));
    expect(resolveWorkspace("work", f.managed, f.where)).toBe(fs.realpathSync.native(f.managed));
    expect(fs.existsSync(f.file)).toBe(false);
    const picked = bindWorkspace("work", f.project, f.where);
    expect(picked.kind).toBe("folder");
    expect(picked.available).toBe(true);
    expect(getWorkspace("work", f.managed, f.where)).toEqual(picked);
    expect(resolveWorkspace("work", f.managed, f.where)).toBe(persistedPath(fs.realpathSync.native(f.project)));
    expect(clearWorkspace("work", f.managed, f.where).kind).toBe("managed");
    expect(fs.readFileSync(path.join(f.project, "keep.txt"), "utf8")).toBe("existing project");
    if (process.platform !== "win32") expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(f.file)).filter((x) => x.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps bindings independent per vault and space", () => {
    const f = fixture();
    const other = path.join(f.root, "other-vault");
    fs.mkdirSync(other);
    bindWorkspace("work", f.project, f.where);
    expect(getWorkspace("school", f.managed, f.where).kind).toBe("managed");
    expect(getWorkspace("work", f.managed, { file: f.file, root: other }).kind).toBe("managed");
    bindWorkspace("school", f.project, { file: f.file, root: other });
    clearWorkspace("work", f.managed, f.where);
    expect(getWorkspace("school", f.managed, { file: f.file, root: other }).kind).toBe("folder");
  });

  it("never overwrites a malformed, oversized or non-file map", () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    for (const invalid of [Buffer.from("{bad json"), Buffer.alloc(1024 * 1024 + 1, " "), Buffer.from(`{"bad-key":{"path":"/tmp"}}`)]) {
      fs.writeFileSync(f.file, invalid);
      expect(() => bindWorkspace("work", f.project, f.where)).toThrow();
      expect(() => clearWorkspace("work", f.managed, f.where)).toThrow();
      expect(() => getWorkspace("work", f.managed, f.where)).toThrow();
      expect(fs.readFileSync(f.file).equals(invalid)).toBe(true);
    }
    // Unknown fields anywhere void the file, as serde's deny_unknown_fields did.
    const key = `${persistedPath(fs.realpathSync.native(f.vault))}\nwork`;
    for (const extra of [{ path: f.project, identity: { device: 1, inode: 2 }, x: 1 }, { path: f.project, identity: { device: 1, inode: 2, x: 1 } }, { path: f.project, identity: { device: 1.5, inode: 2 } }]) {
      fs.writeFileSync(f.file, JSON.stringify({ [key]: extra }));
      expect(() => getWorkspace("work", f.managed, f.where)).toThrow("Workspace settings are invalid. Existing bindings were left unchanged.");
    }
    fs.writeFileSync(f.file, JSON.stringify({ [key]: { path: f.project, identity: null } }));
    if (process.platform !== "win32") expect(() => getWorkspace("work", f.managed, f.where)).toThrow("Workspace settings are missing a folder identity.");
    fs.rmSync(f.file);
    fs.mkdirSync(f.file);
    expect(() => bindWorkspace("work", f.project, f.where)).toThrow();
    expect(fs.statSync(f.file).isDirectory()).toBe(true);
  });

  it("refuses invalid ids and protected paths", () => {
    const f = fixture();
    for (const id of ["../work", "", "a\nb", "work/other"]) {
      expect(() => bindWorkspace(id, f.project, f.where)).toThrow();
      expect(() => getWorkspace(id, f.managed, f.where)).toThrow();
    }
    const state = path.join(f.project, ".phaethon");
    fs.mkdirSync(state);
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    for (const p of [f.vault, f.managed, state, path.dirname(f.file), "/", "relative/project"]) {
      expect(() => bindWorkspace("work", p, f.where), p).toThrow();
    }
    const synced = path.join(f.vault, "bindings.json");
    expect(() => bindWorkspace("work", f.project, { file: synced, root: f.vault })).toThrow("Workspace bindings must be stored outside the synced vault.");
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.existsSync(synced)).toBe(false);
    expect(() => bindWorkspace("work", f.project, { file: null, root: f.vault })).toThrow("Phaethon's app-data folder is unavailable.");
  });

  it("missing and replaced roots stay bound but can't be used", () => {
    const f = fixture();
    const picked = bindWorkspace("work", f.project, f.where);
    const moved = path.join(f.root, "moved-project");
    fs.renameSync(f.project, moved);
    const missing = getWorkspace("work", f.managed, f.where);
    expect(missing).toEqual({ path: picked.path, kind: "folder", available: false });
    expect(() => resolveWorkspace("work", f.managed, f.where)).toThrow();
    fs.mkdirSync(f.project);
    if (process.platform !== "win32") {
      expect(getWorkspace("work", f.managed, f.where).available).toBe(false);
      expect(() => resolveWorkspace("work", f.managed, f.where)).toThrow("The chosen workspace folder was replaced or moved. Choose it again.");
    }
  });

  it("rejects symlink picks and symlink replacements", () => {
    const f = fixture();
    const link = path.join(f.root, "project-alias");
    symlink(f.project, link);
    expect(() => bindWorkspace("work", link, f.where)).toThrow("Choose a real folder, not a file or symbolic link.");
    bindWorkspace("work", f.project, f.where);
    const moved = path.join(f.root, "moved-project");
    fs.renameSync(f.project, moved);
    symlink(moved, f.project);
    expect(getWorkspace("work", f.managed, f.where).available).toBe(false);
    expect(() => resolveWorkspace("work", f.managed, f.where)).toThrow();
  });

  it.skipIf(!canSymlinkFiles)("rejects symlinked map files", () => {
    const f = fixture();
    bindWorkspace("work", f.project, f.where);
    const protectedFile = path.join(f.root, "do-not-change.json");
    fs.writeFileSync(protectedFile, "private data");
    fs.rmSync(f.file);
    symlink(protectedFile, f.file);
    expect(() => clearWorkspace("work", f.managed, f.where)).toThrow("Workspace settings must be a regular file.");
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("private data");
  });

  it("keeps device and inode numbers above 2^53 exactly (fixed Rust-compat bug)", () => {
    const f = fixture();
    const key = `${persistedPath(fs.realpathSync.native(f.vault))}\nwork`;
    const big = "18446744073709551615";
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    const other = `${persistedPath(fs.realpathSync.native(f.vault))}\nschool`;
    fs.writeFileSync(
      f.file,
      `{\n  ${JSON.stringify(other)}: {\n    "path": "/nowhere/else",\n    "identity": {\n      "device": 9007199254740993,\n      "inode": ${big}\n    }\n  }\n}`,
    );
    // The binding for another space can't match a folder, but rewriting the file keeps its numbers.
    expect(getWorkspace("school", f.managed, f.where)).toEqual({ path: "/nowhere/else", kind: "folder", available: false });
    bindWorkspace("work", f.project, f.where);
    const text = fs.readFileSync(f.file, "utf8");
    expect(text).toContain('"device": 9007199254740993');
    expect(text).toContain(`"inode": ${big}`);
    expect(text.indexOf(JSON.stringify(other)) < text.indexOf(JSON.stringify(key))).toBe(true);
    expect(text.indexOf(JSON.stringify(other))).toBeGreaterThan(0);
    const st = fs.statSync(persistedPath(fs.realpathSync.native(f.project)), { bigint: true });
    if (process.platform !== "win32") expect(text).toContain(`"inode": ${st.ino}`);
  });
});

describe("workspace and full access commands", () => {
  beforeEach(() => {
    fs.rmSync(vaultRoot(), { recursive: true, force: true });
    ensureVault();
  });

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

  it("binds only a folder the picker chose, under its token, once", async () => {
    const project = path.join(env.home, "Project One");
    fs.mkdirSync(project, { recursive: true });
    const host = fakeHost(() => project);
    setHost(host);
    const token = "0123abcd-0123-4567-89ab-0123456789ab";
    await expect(call("workspace_choose", { token: "../../etc" })).rejects.toThrow("Invalid folder choice.");
    expect(await call("workspace_choose", { token })).toEqual({ token, path: project, name: "Project One" });
    expect(host.ops[0]).toEqual({ op: "pickFolder", title: "Choose a workspace folder" });
    writeSession("work", "11111111-1111-1111-1111-111111111111");
    const run = claim("work")!;
    await expect(call("space_workspace_bind", { id: "work", token })).rejects.toThrow("Stop the reply before changing its workspace.");
    release(run);
    const view = await call<{ path: string; kind: string }>("space_workspace_bind", { id: "work", token });
    expect(view).toEqual({ path: persistedPath(fs.realpathSync.native(project)), kind: "folder", available: true });
    expect(readSession("work")).toBeNull();
    expect(workingDirFor("work")).toBe(persistedPath(fs.realpathSync.native(project)));
    expect(workingDirFor("school")).toBeNull();
    await expect(call("space_workspace_bind", { id: "work", token })).rejects.toThrow("Choose the folder again.");
    expect(await call("space_workspace_get", { id: "work" })).toEqual(view);
    expect(fs.existsSync(appFiles.workspaces())).toBe(true);
    expect(await call("space_workspace_clear", { id: "work" })).toEqual({ path: spaceDir("work"), kind: "managed", available: true });
    // Cancelling the picker changes nothing.
    setHost(fakeHost(() => null));
    expect(await call("workspace_choose", { token })).toBeNull();
  });

  it("full access is per space and per vault, kept outside the vault", async () => {
    expect(isFullAccess("work")).toBe(false);
    expect(await call("full_access_set", { id: "work", on: true })).toBe(true);
    expect(isFullAccess("work")).toBe(true);
    expect(isFullAccess("school")).toBe(false);
    expect(await call("full_access_list")).toEqual(["work"]);
    const saved = JSON.parse(fs.readFileSync(appFiles.fullAccess(), "utf8"));
    expect(saved).toEqual([`${persistedPath(fs.realpathSync.native(vaultRoot()))}\nwork`]);
    await expect(call("full_access_set", { id: "nope", on: true })).rejects.toThrow('space "nope" does not exist in this vault');
    // Another vault's entries are never listed here.
    fs.writeFileSync(appFiles.fullAccess(), JSON.stringify([...saved, "/elsewhere/Phaethon/other\nlife"]));
    expect(fullAccessList()).toEqual(["work"]);
    setFullAccess("work", false);
    expect(isFullAccess("work")).toBe(false);
    expect(JSON.parse(fs.readFileSync(appFiles.fullAccess(), "utf8"))).toEqual(["/elsewhere/Phaethon/other\nlife"]);
    fs.writeFileSync(appFiles.fullAccess(), "not json");
    expect(isFullAccess("work")).toBe(false);
    expect(fullAccessList()).toEqual([]);
  });
});
