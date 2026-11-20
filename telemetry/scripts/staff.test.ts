import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("cross-spawn", () => ({ default: spawn }));
import { staffCLI } from "./staff.ts";

afterEach(() => spawn.mockReset());

function remoteOutput(confirmed: boolean) {
  spawn.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      // Remote imports emit progress even with --json, and their summary does
      // not contain RETURNING rows. Read-only query output is structured JSON.
      child.stdout.end(args.includes("--file") ? "├ Checking if file needs uploading\n[{\"success\":true,\"results\":[{\"Total queries executed\":1}]}]\n" : JSON.stringify([{ success: true, results: confirmed ? [{ id: "staff" }] : [] }]));
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  });
}

it("confirms a remote write using a separate query despite noisy import output", async () => {
  remoteOutput(true);
  await expect(staffCLI(["revoke", "--email", "staff@example.test", "--remote"])).resolves.toBeUndefined();
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[0][1]).toContain("--file");
  expect(spawn.mock.calls[1][1]).toContain("--command");
  expect(spawn.mock.calls[1][1].find((arg: string) => arg.startsWith("SELECT"))).toMatch(/^SELECT id FROM staff WHERE auth_version='[0-9a-f-]+';$/);
});

it("rejects an unconfirmed write when the atomic account guard blocked it", async () => {
  remoteOutput(false);
  await expect(staffCLI(["disable", "--email", "staff@example.test", "--remote"])).rejects.toThrow("Staff update rejected");
});
