import { describe, expect, it } from "vitest";
import { CHUNK_UNITS, ChunkedSecretStore, type SecretStore } from "./chunked-secrets.ts";

class LimitedStore implements SecretStore {
  entries = new Map<string, string>();
  fail?: (account: string) => boolean;
  key(service: string, account: string) { return `${service}\0${account}`; }
  get(service: string, account: string) { return this.entries.get(this.key(service, account)) ?? null; }
  set(service: string, account: string, value: string) {
    if (value.length > CHUNK_UNITS) throw new Error("Windows credential limit");
    if (this.fail?.(account)) throw new Error("keychain unavailable");
    this.entries.set(this.key(service, account), value);
  }
  delete(service: string, account: string) { return this.entries.delete(this.key(service, account)); }
}

const account = "default/lms/canvas-iu-instructure-com";
const service = "phaethon";
const large = JSON.stringify({ cookies: [{ name: "canvas_session", value: "s".repeat(8000) }], csrf: "token" });

describe("Windows credentials larger than one keychain entry", () => {
  it("reads existing single-entry credentials and keeps small values in their original format", () => {
    const raw = new LimitedStore();
    const store = new ChunkedSecretStore(raw);
    raw.set(service, account, "old credential");
    expect(store.get(service, account)).toBe("old credential");
    store.set(service, account, "new credential");
    expect(raw.get(service, account)).toBe("new credential");
    expect(raw.entries.size).toBe(1);
  });

  it("round-trips a large Canvas session, then replaces and deletes all its chunks", () => {
    const raw = new LimitedStore();
    const store = new ChunkedSecretStore(raw);
    store.set(service, account, large);
    expect(store.get(service, account)).toBe(large);
    expect(raw.entries.size).toBeGreaterThan(2);
    const oldChunks = [...raw.entries.keys()].filter((k) => k.includes("/chunk/"));
    store.set(service, account, "new " + large);
    expect(store.get(service, account)).toBe("new " + large);
    expect(oldChunks.every((key) => !raw.entries.has(key))).toBe(true);
    expect(store.delete(service, account)).toBe(true);
    expect(store.get(service, account)).toBeNull();
    expect(raw.entries.size).toBe(0);
  });

  it("never splits Unicode surrogate pairs or mistakes a reserved prefix for a manifest", () => {
    const raw = new LimitedStore();
    const store = new ChunkedSecretStore(raw);
    const value = "x".repeat(CHUNK_UNITS - 1) + "🌍".repeat(2000) + "é漢字";
    store.set(service, account, value);
    expect(store.get(service, account)).toBe(value);
    for (const part of raw.entries.values()) expect(Buffer.from(part, "utf8").toString("utf8")).toBe(part);
    store.set(service, account, "phaethon:chunked-secret:v1:literal");
    expect(store.get(service, account)).toBe("phaethon:chunked-secret:v1:literal");
    store.set(service, account, "short");
    expect(raw.entries.size).toBe(1);
  });

  it.each(["chunk", "manifest"])("keeps the previous sign-in when a %s write fails", (stage) => {
    const raw = new LimitedStore();
    const store = new ChunkedSecretStore(raw);
    store.set(service, account, large);
    const before = new Map(raw.entries);
    raw.fail = (key) => stage === "manifest" ? key === account : key.endsWith("/2");
    expect(() => store.set(service, account, "another " + large)).toThrow("keychain unavailable");
    expect(raw.entries).toEqual(before);
    expect(store.get(service, account)).toBe(large);
  });

  it("refuses incomplete or corrupted data and can repair it with a fresh sign-in", () => {
    const raw = new LimitedStore();
    const store = new ChunkedSecretStore(raw);
    store.set(service, account, large);
    const chunk = [...raw.entries.keys()].find((k) => k.includes("/chunk/"))!;
    raw.entries.set(chunk, "corrupt");
    expect(() => store.get(service, account)).toThrow("incomplete");
    raw.entries.delete(chunk);
    expect(() => store.get(service, account)).toThrow("incomplete");
    store.set(service, account, large);
    expect(store.get(service, account)).toBe(large);
    raw.entries.set(raw.key(service, account), "phaethon:chunked-secret:v1:broken");
    expect(() => store.get(service, account)).toThrow("incomplete");
    store.set(service, account, "fresh");
    expect(store.get(service, account)).toBe("fresh");
  });

  it("keeps services and accounts separate", () => {
    const raw = new LimitedStore();
    const store = new ChunkedSecretStore(raw);
    store.set(service, account, large);
    store.set("steward", account, "old " + large);
    store.set(service, "another-account", "other " + large);
    store.delete(service, account);
    expect(store.get("steward", account)).toBe("old " + large);
    expect(store.get(service, "another-account")).toBe("other " + large);
  });
});
