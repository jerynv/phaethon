import { afterEach, describe, expect, it } from "vitest";
import type { HostEventBody, HostOp } from "#shared/host.ts";
import { call } from "../../../tests/harness.ts";
import { setHost, type Host } from "../host.ts";
import { DID_NOT_START, NOT_HERE, startDictation } from "./commands.ts";

function fakeHost(answer: (op: HostOp) => unknown): Host & { ops: HostOp[] } {
  const ops: HostOp[] = [];
  return {
    available: true,
    ops,
    async call<T>(op: HostOp) {
      ops.push(op);
      return (await answer(op)) as T;
    },
    on: (_l: (e: HostEventBody) => void) => () => {},
  };
}
const noHost: Host = { available: false, call: () => Promise.reject(new Error("no")), on: () => () => {} };
afterEach(() => setHost(noHost));

describe("voice_dictation_start", () => {
  it("points to the OS shortcut outside macOS, without asking the shell", async () => {
    const host = fakeHost(() => null);
    setHost(host);
    await expect(startDictation("linux")).rejects.toThrow(NOT_HERE);
    await expect(startDictation("win32")).rejects.toThrow(NOT_HERE);
    expect(host.ops).toEqual([]);
  });

  it("asks the shell to start dictation on macOS", async () => {
    const host = fakeHost(() => null);
    setHost(host);
    await expect(startDictation("darwin")).resolves.toBeNull();
    expect(host.ops).toEqual([{ op: "dictationStart" }]);
  });

  it("says it didn't start when there is no shell", async () => {
    setHost(noHost);
    await expect(startDictation("darwin")).rejects.toThrow(DID_NOT_START);
  });

  it("is registered", async () => {
    if (process.platform !== "darwin") await expect(call("voice_dictation_start")).rejects.toThrow(NOT_HERE);
  });
});
