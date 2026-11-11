import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { cleanRel, resolveIn } from "./resolve.ts";
import { checkApiKey, keychainGet, keychainSet, parsePassword, providerAccount, resetMemoryKeychain, SecurityToolStore, type SecurityRun, type Store } from "./secrets.ts";
import { ensureVault, isValidSpaceId, spaceDir, spacesRoot } from "./vault.ts";
import { claim, release, whileIdle, BUSY } from "./runs.ts";
import { forProvider, shortTitle, userMessage } from "./thread.ts";
import { writeFileAtomic } from "./fsx.ts";

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
    fs.symlinkSync(path.join(spacesRoot(), "school"), path.join(spacesRoot(), "alias"));
    expect(() => spaceDir("alias")).toThrow('space "alias" is not a folder inside this vault');
    expect(() => spaceDir("missing")).toThrow('space "missing" does not exist in this vault');
    expect(() => spaceDir("../x")).toThrow('"../x" is not a valid space name');
  });
});

describe("resolve", () => {
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
    fs.symlinkSync("/etc", path.join(root, "out"));
    fs.symlinkSync(path.join(root, ".phaethon"), path.join(root, "state"));
    fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling"));
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

describe("macOS keychain through the security tool", () => {
  // A stand-in for /usr/bin/security over one keychain, printing what the real tool prints (checked on macOS 27).
  function fakeSecurity(entries: Map<string, { value: string; comment: string | null }>) {
    const calls: string[][] = [];
    const run: SecurityRun = (args) => {
      calls.push(args);
      const flag = (f: string) => args[args.indexOf(f) + 1]!;
      const key = `${flag("-s")}\0${flag("-a")}`;
      const entry = entries.get(key);
      const missing = { status: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n" };
      switch (args[0]) {
        case "find-generic-password": {
          if (!entry) return missing;
          const stdout = `keychain: "login.keychain-db"\nattributes:\n    "icmt"<blob>=${entry.comment === null ? "<NULL>" : `"${entry.comment}"`}\n`;
          if (!args.includes("-g")) return { status: 0, stdout, stderr: "" };
          const plain = /^[\x20-\x7e]*$/.test(entry.value) && !entry.value.includes("\\");
          const hex = Buffer.from(entry.value, "utf8").toString("hex").toUpperCase();
          return { status: 0, stdout, stderr: plain ? `password: ${entry.value ? `"${entry.value}"` : ""}\n` : `password: 0x${hex}  "…"\n` };
        }
        case "add-generic-password":
          if (entry) return { status: 45, stdout: "", stderr: "security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.\n" };
          entries.set(key, { value: Buffer.from(flag("-X"), "hex").toString("utf8"), comment: flag("-j") });
          return { status: 0, stdout: "", stderr: "" };
        case "delete-generic-password":
          if (!entry) return missing;
          entries.delete(key);
          return { status: 0, stdout: "", stderr: "password has been deleted.\n" };
      }
      throw new Error(`unexpected ${args[0]}`);
    };
    return { run, calls };
  }
  const noLegacy: Store = { get: () => null, set: () => {}, delete: () => false };

  it("round-trips any value and reports missing entries", () => {
    const { run } = fakeSecurity(new Map());
    const store = new SecurityToolStore(run, noLegacy);
    expect(store.get("phaethon", "default/provider/anthropic")).toBeNull();
    for (const value of ["sk-ant-123", 'a"b', "back\\slash", '{"cookies":[{"name":"é","value":"x"}],"csrf":null}', ""]) {
      store.set("phaethon", "acct", value);
      expect(store.get("phaethon", "acct")).toBe(value);
    }
    expect(store.delete("phaethon", "acct")).toBe(true);
    expect(store.delete("phaethon", "acct")).toBe(false);
  });

  it("rewrites an entry an earlier build saved, reading it through the keychain API once", () => {
    const entries = new Map([["phaethon\0default/lms/canvas", { value: "old-session", comment: null }]]);
    const { run, calls } = fakeSecurity(entries);
    let legacyReads = 0;
    const legacy: Store = { get: () => (legacyReads++, "old-session"), set: () => {}, delete: () => false };
    const store = new SecurityToolStore(run, legacy);
    expect(store.get("phaethon", "default/lms/canvas")).toBe("old-session");
    expect(store.get("phaethon", "default/lms/canvas")).toBe("old-session");
    expect(legacyReads).toBe(1);
    expect(entries.get("phaethon\0default/lms/canvas")).toEqual({ value: "old-session", comment: "phaethon:security" });
    expect(calls.some((c) => c.includes("-w"))).toBe(false);
  });

  it("passes the tool's error on without the secret", () => {
    const run: SecurityRun = () => ({ status: 36, stdout: "", stderr: "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\n" });
    expect(() => new SecurityToolStore(run, noLegacy).set("phaethon", "acct", "sk-secret")).toThrow("User interaction is not allowed.");
    try {
      new SecurityToolStore(run, noLegacy).set("phaethon", "acct", "sk-secret");
    } catch (e) {
      expect((e as Error).message).not.toContain("sk-secret");
    }
  });

  it("parses both forms the tool prints", () => {
    expect(parsePassword('password: "a"b"\n')).toBe('a"b');
    expect(parsePassword('password: 0x615C62  "a\\134b"\n')).toBe("a\\b");
    expect(parsePassword("password: \n")).toBe("");
    expect(() => parsePassword("nothing")).toThrow("the keychain returned no password");
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
  it("never write through a link planted at a temporary name", () => {
    const root = spaceDir("work");
    const outside = path.join(env.home, "outside.txt");
    fs.writeFileSync(outside, "keep me");
    const target = path.join(root, "notes.md");
    fs.symlinkSync(outside, `${target}.tmp`);
    fs.symlinkSync(outside, path.join(root, ".notes.md.phaethon-tmp"));
    writeFileAtomic(target, "new");
    writeFileAtomic(target, "newer", { tmp: path.join(root, ".notes.md.phaethon-tmp") });
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
    expect(fs.readFileSync(target, "utf8")).toBe("newer");
  });
});
