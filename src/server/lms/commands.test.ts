import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { call, channel, tempHome } from "../../../tests/harness.ts";

const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("../core/secrets.ts", async (orig) => {
  const real = await orig<typeof import("../core/secrets.ts")>();
  return {
    ...real,
    keychainGet: (account: string) => {
      reads.n++;
      return real.keychainGet(account);
    },
  };
});

const home = tempHome("phaethon-lms-commands-");
const { ensureVault, vaultRoot } = await import("../core/vault.ts");
const { commandNames } = await import("../rpc/registry.ts");
await import("./commands.ts");
const { save } = await import("./store.ts");
ensureVault();
afterAll(() => home.cleanup());

const LMS_COMMANDS = [
  "course_access_get",
  "course_access_set",
  "lms_connect",
  "lms_connections",
  "lms_course_content",
  "lms_courses",
  "lms_disconnect",
  "lms_grades",
  "lms_grades_refresh",
  "lms_import",
  "lms_import_cancel",
  "lms_schools",
];

describe("lms commands", () => {
  it("every course-site command is registered", () => {
    const names = commandNames();
    for (const n of LMS_COMMANDS) expect(names).toContain(n);
  });

  it("lms_connections reads lms.json only, never the keychain", async () => {
    save(vaultRoot(), { connections: [{ id: "canvas-x", kind: "canvas", address: "https://x.instructure.com", signedIn: true, courses: {} }] });
    reads.n = 0;
    expect(await call("lms_connections")).toEqual([{ id: "canvas-x", kind: "canvas", address: "https://x.instructure.com", signedIn: true, courses: [] }]);
    expect(reads.n).toBe(0);
  });

  it("a grades refresh for a space that isn't there says so, then done", async () => {
    const ch = channel();
    await call("lms_grades_refresh", { space: "../nope", connection: "canvas-x", onEvent: ch });
    expect(ch.messages).toEqual([{ type: "error", message: '"../nope" is not a valid space name' }, { type: "done" }]);
    const ch2 = channel();
    await call("lms_grades_refresh", { space: "school", connection: "canvas-x", onEvent: ch2 });
    expect(ch2.messages).toEqual([{ type: "done" }]);
    await expect(call("lms_grades", { space: "nope" })).rejects.toThrow("does not exist");
    expect(await call("lms_grades", { space: "school" })).toEqual([]);
  });

  it("access can only be set for an imported course", async () => {
    await expect(call("course_access_set", { space: "school", course: "canvas-x/1", parts: ["files"] })).rejects.toThrow("That course isn’t imported.");
    save(vaultRoot(), {
      connections: [{ id: "canvas-x", kind: "canvas", address: "https://x.instructure.com", signedIn: false, courses: { "1": { name: "Calc", folder: "Calc", files: {}, links: {}, due: [] } } }],
    });
    await call("course_access_set", { space: "school", course: "canvas-x/1", parts: ["files", "overview"] });
    const view = await call<{ access: unknown; spaces: string[] }>("course_access_get", {});
    expect(view.access).toEqual({ school: { "canvas-x/1": ["overview", "files"] } });
    expect(view.spaces).toEqual(["school", "work"]);
    expect(JSON.parse(fs.readFileSync(path.join(vaultRoot(), ".phaethon/course-access.json"), "utf8"))).toEqual({ school: { "canvas-x/1": ["overview", "files"] } });
    await expect(call("course_access_set", { space: "school", course: "canvas-x/1", parts: ["bogus"] })).rejects.toThrow("isn’t a part of a course");
  });

  it("an import with nothing to import still ends with one done, and cancel finds nothing running", async () => {
    const ch = channel();
    await call("lms_import", { connection: "nope", courseIds: [], spaces: [], onEvent: ch });
    expect(ch.messages).toEqual([{ type: "error", message: "That course site isn’t connected." }, { type: "done" }]);
    expect(await call("lms_import_cancel", { connection: "nope" })).toBe(false);
    expect(await call("lms_schools", { kind: "moodle", query: "anything" })).toEqual([]);
    await expect(call("lms_courses", { connection: "canvas-x" })).rejects.toThrow("signedOut");
  });
});
