import { afterEach, describe, expect, it } from "vitest";
import type { HostEventBody, HostOp } from "#shared/host.ts";
import { call } from "../../../tests/harness.ts";
import { setHost, type Host } from "../host.ts";
import { MAX_DEV_LOG, devLog } from "./commands.ts";

const ops: HostOp[] = [];
const host: Host = {
  available: true,
  async call<T>(op: HostOp) {
    ops.push(op);
    return null as T;
  },
  on: (_l: (e: HostEventBody) => void) => () => {},
};
const noHost: Host = { available: false, call: () => Promise.reject(new Error("no")), on: () => () => {} };

afterEach(() => {
  setHost(noHost);
  ops.length = 0;
  delete process.env.PHAETHON_PACKAGED;
  delete process.env.PHAETHON_DIAGNOSTICS;
});

describe("dev_log", () => {
  it("writes capped lines in a development build and asks for a snapshot once the UI mounts", () => {
    setHost(host);
    const lines: string[] = [];
    expect(devLog("é".repeat(MAX_DEV_LOG + 50), (l) => lines.push(l))).toBe(true);
    expect(lines[0]).toBe(`[webview] ${"é".repeat(MAX_DEV_LOG)}\n`);
    expect(ops).toEqual([]);
    devLog("ui mounted: 12 buttons, root: 1240x820", (l) => lines.push(l));
    expect(ops).toEqual([{ op: "snapshot" }]);
  });

  it("is inert in a release unless PHAETHON_DIAGNOSTICS is set", () => {
    setHost(host);
    process.env.PHAETHON_PACKAGED = "1";
    const lines: string[] = [];
    expect(devLog("ui mounted: x", (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual([]);
    expect(ops).toEqual([]);
    process.env.PHAETHON_DIAGNOSTICS = "1";
    expect(devLog("CSP violation: script-src blocked inline", (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual(["[webview] CSP violation: script-src blocked inline\n"]);
  });

  it("returns null to the renderer", async () => {
    process.env.PHAETHON_PACKAGED = "1";
    expect(await call("dev_log", { message: "hi" })).toBeNull();
  });
});
