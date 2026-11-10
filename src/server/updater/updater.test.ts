import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPDATE_FEED, type HostEventBody, type HostOp } from "#shared/host.ts";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { setHost, type Host } from "../host.ts";
import {
  NO_DESKTOP,
  NO_RELEASE_WORDS,
  NO_TARGET_WORDS,
  NETWORK_WORDS,
  NOTES_MAX_CHARS,
  PERMISSION_WORDS,
  SIGNATURE_WORDS,
  cleanNotes,
  notesText,
  progressThrottle,
  resetForTest,
  setupOf,
  words,
  type InstallEvent,
} from "./updates.ts";
import "./commands.ts";

tempHome("phaethon-updater-");

/** A desktop shell that answers updater ops from a script and records them. */
class FakeHost implements Host {
  readonly available = true;
  ops: HostOp[] = [];
  listeners = new Set<(e: HostEventBody) => void>();
  constructor(private readonly answer: (op: HostOp, emit: (e: HostEventBody) => void) => unknown) {}
  async call<T>(op: HostOp): Promise<T> {
    this.ops.push(op);
    return (await this.answer(op, (e) => this.listeners.forEach((l) => l(e)))) as T;
  }
  on(listener: (e: HostEventBody) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const noHost: Host = { available: false, call: () => Promise.reject(new Error("no")), on: () => () => {} };

beforeEach(() => {
  process.env.PHAETHON_VERSION = "0.2.0";
  delete process.env.PHAETHON_PACKAGED;
  resetForTest({ pause: async () => {} });
});
afterEach(() => setHost(noHost));

describe("setup", () => {
  it("is set up only with a named repository or an https feed", () => {
    expect(setupOf(UPDATE_FEED)).toEqual({ ready: true, source: "jerynv/phaethon" });
    expect(setupOf({ provider: "generic", url: "https://updates.example.org/{{channel}}" })).toEqual({ ready: true, source: "updates.example.org" });
    for (const [feed, why] of [
      [null, "nothing set"],
      [{ provider: "github", owner: "", repo: "phaethon" }, "no owner"],
      [{ provider: "github", owner: "a/b", repo: "c" }, "not a name"],
      [{ provider: "generic", url: "" }, "no feed"],
      [{ provider: "generic", url: "http://example.org/latest.yml" }, "http"],
      [{ provider: "generic", url: "https://example.org/<owner>/latest.yml" }, "placeholder"],
      [{ provider: "generic", url: "latest.yml" }, "not an address"],
    ] as const) {
      expect(setupOf(feed as never).ready, why).toBe(false);
    }
  });

  it("names the same repository electron-builder publishes to", () => {
    const yml = fs.readFileSync(path.resolve(import.meta.dirname, "../../../electron-builder.yml"), "utf8");
    const publish = yml.slice(yml.indexOf("\npublish:"));
    expect(publish).toMatch(/provider: github/);
    expect(publish).toContain(`owner: ${UPDATE_FEED.owner}`);
    expect(publish).toContain(`repo: ${UPDATE_FEED.repo}`);
    expect(publish).toMatch(/releaseType: draft/);
  });
});

describe("words and notes", () => {
  it("trims and cuts notes, and reads GitHub's HTML as text", () => {
    expect(cleanNotes(null)).toBeNull();
    expect(cleanNotes("  \n ")).toBeNull();
    expect(cleanNotes("\n- Faster\n")).toBe("- Faster");
    const cut = cleanNotes("é".repeat(NOTES_MAX_CHARS + 5))!;
    expect(Array.from(cut).length).toBe(NOTES_MAX_CHARS + 1);
    expect(cut.endsWith("…")).toBe(true);
    expect(cleanNotes(notesText("<h2>New</h2><ul><li>Faster &amp; calmer</li><li>a &lt;b&gt;</li></ul>"))).toBe("New\n- Faster & calmer\n- a <b>");
  });

  it("says errors in words", () => {
    expect(words({ message: "sha512 checksum mismatch, expected x", code: "ERR_CHECKSUM_MISMATCH" })).toBe(SIGNATURE_WORDS);
    expect(words({ message: "New version is not signed by the application owner", code: "ERR_UPDATER_INVALID_SIGNATURE" })).toBe(SIGNATURE_WORDS);
    expect(SIGNATURE_WORDS).toContain("wasn’t installed");
    expect(words({ message: "net::ERR_INTERNET_DISCONNECTED" })).toBe(NETWORK_WORDS);
    expect(words({ message: "getaddrinfo ENOTFOUND github.com", code: "ENOTFOUND" })).toBe(NETWORK_WORDS);
    expect(words({ message: "Cannot find latest-linux.yml in the latest release artifacts", code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })).toBe(NO_TARGET_WORDS);
    expect(words({ message: "No published versions on GitHub", code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" })).toBe(NO_RELEASE_WORDS);
    expect(words({ message: "HttpError: 404", statusCode: 404 })).toBe(NO_RELEASE_WORDS);
    expect(words({ message: "EACCES: permission denied, rename '/opt/Phaethon'", code: "EACCES" })).toBe(PERMISSION_WORDS);
    expect(words({ message: "Something odd." })).toBe("The update couldn’t be installed: Something odd. Nothing was changed; you can try again.");
  });

  it("throttles progress to about a hundred steps, ending at the full size", () => {
    const said: number[] = [];
    const step = progressThrottle((r) => said.push(r));
    for (let r = 1000; r <= 1_000_000; r += 1000) step(r, 1_000_000);
    expect(said.length).toBeLessThanOrEqual(101);
    expect(said.at(-1)).toBe(1_000_000);
    const unknown: number[] = [];
    const step2 = progressThrottle((r) => unknown.push(r));
    for (let r = 64 * 1024; r <= 1024 * 1024; r += 64 * 1024) step2(r, null);
    expect(unknown).toEqual([256 * 1024, 512 * 1024, 768 * 1024, 1024 * 1024]);
  });
});

describe("commands", () => {
  it("without the desktop app, nothing is set up and nothing is asked", async () => {
    setHost(noHost);
    const v = await call<{ source: string | null; status: unknown; currentVersion: string; canInstall: boolean }>("update_check");
    expect(v).toEqual({ currentVersion: "0.2.0", source: null, canInstall: false, status: { state: "notSetUp", reason: NO_DESKTOP } });
  });

  it("checks through the shell and shows what it found", async () => {
    const fake = new FakeHost((op) =>
      op.op === "updateCheck" ? { kind: "available", update: { version: "0.3.0", notes: "<p>Faster</p>", date: "2026-11-01T09:00:00.000Z" } } : null,
    );
    setHost(fake);
    expect((await call<{ status: unknown; source: string }>("update_state")).status).toEqual({ state: "idle" });
    const v = await call<{ status: unknown; source: string }>("update_check");
    expect(v.source).toBe("jerynv/phaethon");
    expect(v.status).toEqual({ state: "available", version: "0.3.0", notes: "Faster", date: "2026-11-01" });
    expect(fake.ops).toEqual([{ op: "updateCheck" }]);
  });

  it("keeps an up-to-date check and a failed check as statuses, never rejecting", async () => {
    setHost(new FakeHost(() => ({ kind: "none" })));
    const up = await call<{ status: { state: string; checkedAt: number } }>("update_check");
    expect(up.status.state).toBe("upToDate");
    expect(typeof up.status.checkedAt).toBe("number");
    setHost(new FakeHost(() => ({ kind: "failed", error: { message: "net::ERR_NAME_NOT_RESOLVED" } })));
    expect((await call<{ status: unknown }>("update_check")).status).toEqual({ state: "error", message: NETWORK_WORDS, during: "check" });
  });

  it("a development build checks but never installs", async () => {
    setHost(new FakeHost(() => ({ kind: "available", update: { version: "0.3.0", notes: null, date: null } })));
    await call("update_check");
    await expect(call("update_install", { onEvent: channel() })).rejects.toThrow("This is a development build of Phaethon, so it doesn’t install updates over itself.");
  });

  it("installs only an update a check found, streaming progress, then quits into it", async () => {
    process.env.PHAETHON_PACKAGED = "1";
    const fake = new FakeHost((op, emit) => {
      if (op.op === "updateCheck") return { kind: "available", update: { version: "0.3.0", notes: null, date: null } };
      if (op.op === "updateDownload") {
        for (let r = 100_000; r <= 1_000_000; r += 100_000) emit({ kind: "updateProgress", received: r, total: 1_000_000 });
        return { kind: "ok" };
      }
      if (op.op === "updateInstall") throw new Error("quit refused");
      return null;
    });
    setHost(fake);
    const none = channel<InstallEvent>();
    await expect(call("update_install", { onEvent: none })).rejects.toThrow("There’s no update to install. Check for updates first.");
    await call("update_check");
    const events = channel<InstallEvent>();
    await expect(call("update_install", { onEvent: events })).rejects.toThrow("The update couldn’t be installed: it stopped unexpectedly (quit refused). You can try again.");
    expect(fake.ops.map((o) => o.op)).toEqual(["updateCheck", "updateDownload", "updateInstall"]);
    expect(events.messages.at(0)).toEqual({ kind: "downloading", received: 100_000, total: 1_000_000 });
    expect(events.messages.slice(-3)).toEqual([{ kind: "downloading", received: 1_000_000, total: 1_000_000 }, { kind: "installing" }, { kind: "restarting" }]);
  });

  it("a download that fails verification is said plainly and keeps the update on offer", async () => {
    process.env.PHAETHON_PACKAGED = "1";
    setHost(
      new FakeHost((op) => {
        if (op.op === "updateCheck") return { kind: "available", update: { version: "0.3.0", notes: null, date: null } };
        if (op.op === "updateDownload") return { kind: "failed", error: { message: "sha512 checksum mismatch", code: "ERR_CHECKSUM_MISMATCH" } };
        return null;
      }),
    );
    await call("update_check");
    await expect(call("update_install", { onEvent: channel() })).rejects.toThrow(SIGNATURE_WORDS);
    expect((await call<{ status: { state: string } }>("update_state")).status.state).toBe("available");
  });

  it("one operation at a time", async () => {
    process.env.PHAETHON_PACKAGED = "1";
    let release!: () => void;
    setHost(
      new FakeHost((op) => {
        if (op.op === "updateCheck") return { kind: "available", update: { version: "0.3.0", notes: null, date: null } };
        if (op.op === "updateDownload") return new Promise((r) => (release = () => r({ kind: "failed", error: { message: "x" } })));
        return null;
      }),
    );
    await call("update_check");
    const first = call("update_install", { onEvent: channel() });
    await new Promise((r) => setTimeout(r, 10));
    await expect(call("update_install", { onEvent: channel() })).rejects.toThrow("Phaethon is already checking for or installing an update.");
    release();
    await expect(first).rejects.toThrow();
  });
});
