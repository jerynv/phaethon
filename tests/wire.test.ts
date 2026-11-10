import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
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
