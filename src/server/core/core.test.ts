import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { cleanRel, resolveIn } from "./resolve.ts";
import { checkApiKey, keychainGet, keychainSet, providerAccount, resetMemoryKeychain } from "./secrets.ts";
import { ensureVault, isValidSpaceId, spaceDir, spacesRoot } from "./vault.ts";
import { claim, release, whileIdle, BUSY } from "./runs.ts";
import { forProvider, shortTitle, userMessage } from "./thread.ts";
import { isWithin, writeFileAtomic } from "./fsx.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

describe("vault", () => {
  it("validates space ids", () => {
    for (const ok of ["school", "a", "0x", "c241-notes", "a_b"]) expect(isValidSpaceId(ok)).toBe(true);
    for (const bad of ["", "..", "../work", "a/b", "School", "-x", ".phaethon", "a b", "x".repeat(65)]) expect(isValidSpaceId(bad)).toBe(false);
  });

  it("turns ids into canonical folders and refuses symlinked spaces", () => {
    expect(spaceDir("school")).toBe(fs.realpathSync.native(path.join(spacesRoot(), "school")));
    symlink(path.join(spacesRoot(), "school"), path.join(spacesRoot(), "alias"));
    expect(() => spaceDir("alias")).toThrow('space "alias" is not a folder inside this vault');
    expect(() => spaceDir("missing")).toThrow('space "missing" does not exist in this vault');
    expect(() => spaceDir("../x")).toThrow('"../x" is not a valid space name');
  });
});

describe("resolve", () => {
  it("accepts dot-prefixed names inside a folder while rejecting siblings", () => {
    const root = path.join(env.home, "parent");
    expect(isWithin(path.join(root, "..notes/file.md"), root)).toBe(true);
    expect(isWithin(path.join(root, "../other/file.md"), root)).toBe(false);
    expect(isWithin(`${root}-sibling/file.md`, root)).toBe(false);
    if (process.platform === "win32") {
      expect(isWithin(root.toUpperCase(), root.toLowerCase())).toBe(true);
      expect(isWithin("Z:\\other", "C:\\parent")).toBe(false);
    }
  });
  it("refuses absolute, parent and state paths", () => {
    expect(() => cleanRel("/etc/passwd")).toThrow('must be a path inside this space');
    expect(() => cleanRel("a/../a")).toThrow('must be a path inside this space');
    expect(() => cleanRel(".PHAETHON/thread.json")).toThrow("is Phaethon's own state");
    expect(cleanRel("./a//b/")).toEqual(["a", "b"]);
  });

  it("follows links only inside the space", () => {
    const root = spaceDir("work");
    fs.mkdirSync(path.join(root, ".phaethon"), { recursive: true });
    fs.writeFileSync(path.join(root, "a.md"), "x");
    const outside = path.join(env.home, "outside-links");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "passwd"), "private");
    symlink(outside, path.join(root, "out"));
    symlink(path.join(root, ".phaethon"), path.join(root, "state"));
    symlink(path.join(root, "nowhere"), path.join(root, "dangling"), "dir");
    expect(resolveIn(root, "a.md", true)).toBe(path.join(root, "a.md"));
    expect(() => resolveIn(root, "out/passwd", true)).toThrow("leads outside this space");
    expect(() => resolveIn(root, "out/new.md", false)).toThrow("leads outside this space");
    expect(() => resolveIn(root, "state/thread.json", false)).toThrow("is Phaethon's own state");
    expect(() => resolveIn(root, "dangling", true)).toThrow('cannot open "dangling"');
    expect(() => resolveIn(root, "nope.md", true)).toThrow('"nope.md" does not exist');
    expect(resolveIn(root, "new/dir/file.md", false)).toBe(path.join(root, "new/dir/file.md"));
  });
});

describe("secrets", () => {
  it("validates keys and namespaces accounts by vault", () => {
    resetMemoryKeychain();
    expect(() => checkApiKey("has space")).toThrow("That does not look like an API key.");
    expect(checkApiKey("  sk-abc  ")).toBe("sk-abc");
    expect(providerAccount("anthropic")).toBe("default/provider/anthropic");
    keychainSet(providerAccount("anthropic"), "sk-abc");
    expect(keychainGet(providerAccount("anthropic"))).toBe("sk-abc");
  });
});

describe("runs", () => {
  it("allows one run per key", async () => {
    const run = claim("school")!;
    expect(claim("school")).toBeUndefined();
    await expect(whileIdle("school", () => 1)).rejects.toThrow(BUSY);
    release(run);
    expect(await whileIdle("school", () => 2)).toBe(2);
  });
});

describe("thread", () => {
  it("builds user messages and strips records for providers", () => {
    expect(userMessage("")).toEqual({ role: "user", content: [{ type: "text", text: "" }] });
    expect(forProvider([{ role: "assistant", content: [{ type: "phaethon_record", kind: "stopped" }] }, { role: "user", content: [{ type: "text", text: "hi" }], at: 1 }])).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(shortTitle("a".repeat(70))).toBe("a".repeat(59) + "…");
  });
});

describe("atomic writes", () => {
  it.skipIf(!canSymlinkFiles)("never write through a link planted at a temporary name", () => {
    const root = spaceDir("work");
    const outside = path.join(env.home, "outside.txt");
    fs.writeFileSync(outside, "keep me");
    const target = path.join(root, "notes.md");
    symlink(outside, `${target}.tmp`);
    symlink(outside, path.join(root, ".notes.md.phaethon-tmp"));
    writeFileAtomic(target, "new");
    writeFileAtomic(target, "newer", { tmp: path.join(root, ".notes.md.phaethon-tmp") });
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
    expect(fs.readFileSync(target, "utf8")).toBe("newer");
  });
});
