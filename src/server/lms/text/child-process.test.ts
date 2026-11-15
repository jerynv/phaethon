import { describe, expect, it } from "vitest";
import { startChild } from "./child-process.ts";

describe("text child process cancellation", () => {
  it("kills the underlying process without replacing its native kill method", async () => {
    const child = startChild({ cmd: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const start = Date.now();
    child.kill();
    await closed;
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
