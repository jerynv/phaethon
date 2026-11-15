import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import net from "node:net";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { command, Refusal } from "../src/server/rpc/registry.ts";
import type { Channel } from "../src/server/rpc/channel.ts";
import { serve } from "../src/server/rpc/server.ts";
import "../src/server/commands.ts";
import { wsClient } from "./harness.ts";

let server: Awaited<ReturnType<typeof serve>>;
const token = "t".repeat(64);

beforeAll(async () => {
  command("test_echo", (args: { text: string }) => args.text);
  command("test_refuse", () => {
    throw new Refusal("No, thanks.");
  });
  command("test_stream", (args: { onEvent: Channel<{ n: number }> }) => {
    for (let n = 1; n <= 3; n++) args.onEvent.send({ n });
  });
  command("test_bytes", () => new Uint8Array([1, 2, 3]));
  server = await serve({ host: "127.0.0.1", port: 0, token, origins: ["app://phaethon"] });
});

afterAll(() => server.close());

describe("wire", () => {
  it("rejects malformed paths and missing UI files while keeping the core available", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-static-test-"));
    fs.writeFileSync(path.join(root, "index.html"), "<h1>Phaethon</h1>");
    const web = await serve({ host: "127.0.0.1", port: 0, token, origins: [], webRoot: root });
    const get = (target: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: web.port, path: target }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    try {
      for (const target of ["/%ZZ", "/%E0%A4", "/%00", "http://[invalid/"]) expect((await get(target)).status, target).toBe(400);
      expect(await get("/a-route")).toEqual({ status: 200, body: "<h1>Phaethon</h1>" });
      fs.rmSync(path.join(root, "index.html"));
      expect((await get("/missing.js")).status).toBe(404);
      expect(await get("/healthz")).toEqual({ status: 200, body: "ok" });
    } finally {
      await web.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes an unused browser preconnection without waiting for request headers", async () => {
    const idle = await serve({ host: "127.0.0.1", port: 0, token, origins: [] });
    const socket = net.connect(idle.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const closed = idle.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1000); })]);
      expect(stopped).toBe(true);
    } finally {
      clearTimeout(timer);
      socket.destroy();
      await closed;
    }
  });

  it("answers a command and refuses with the plain message", async () => {
    const client = await wsClient(server.port, token);
    expect(await client.invoke("test_echo", { text: "hi" })).toMatchObject({ t: "ok", value: "hi" });
    expect(await client.invoke("test_refuse")).toMatchObject({ t: "err", error: "No, thanks." });
    expect(await client.invoke("nope")).toMatchObject({ t: "err", error: "Unknown command nope." });
    expect((await client.invoke("core_info")).t).toBe("ok");
    client.close();
  });

  it("streams channel messages before the result", async () => {
    const client = await wsClient(server.port, token);
    const result = await client.invoke("test_stream", { onEvent: { __phaethonChannel: 7 } });
    expect(result.t).toBe("ok");
    expect(client.channelMessages.get(7)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    client.close();
  });

  it("sends bytes as base64", async () => {
    const client = await wsClient(server.port, token);
    expect(await client.invoke("test_bytes")).toMatchObject({ value: { __phaethonBytes: "AQID" } });
    client.close();
  });

  it("refuses a wrong token and a foreign origin", async () => {
    await expect(wsClient(server.port, "x".repeat(64))).rejects.toBeTruthy();
    const foreign = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`, { origin: "https://evil.example" });
    await expect(new Promise((resolve, reject) => { foreign.once("open", resolve); foreign.once("error", reject); })).rejects.toBeTruthy();
    const ok = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`, { origin: "app://phaethon" });
    await expect(new Promise((resolve, reject) => { ok.once("open", resolve); ok.once("error", reject); })).resolves.toBeUndefined();
    ok.close();
  });
});
