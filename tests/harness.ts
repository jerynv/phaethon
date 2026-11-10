import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { CollectingChannel } from "../src/server/rpc/channel.ts";
import { handlerFor, messageOf } from "../src/server/rpc/registry.ts";

/**
 * A throwaway home for one test file: the vault lands in `<home>/Phaethon`, app
 * data in `<home>/appdata`. Call it before the core touches any path.
 */
export function tempHome(prefix = "phaethon-test-"): { home: string; appData: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appData = path.join(home, "appdata");
  process.env.PHAETHON_HOME = home;
  process.env.PHAETHON_APP_DATA = appData;
  process.env.PHAETHON_KEYRING = "memory";
  return { home, appData, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/**
 * Calls a registered command directly, as the renderer would, and returns its
 * value or throws the message the UI would show. Channel arguments are given
 * as `channel()` placeholders and collected.
 */
export async function call<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const handler = handlerFor(cmd);
  if (!handler) throw new Error(`No command ${cmd} is registered.`);
  try {
    return (await handler(args, { signal: new AbortController().signal })) as T;
  } catch (e) {
    throw new Error(messageOf(e));
  }
}

export function channel<T = unknown>(onMessage?: (msg: T) => void): CollectingChannel<T> {
  return new CollectingChannel<T>(onMessage);
}

/** A raw WebSocket client for wire-level tests. */
export async function wsClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let next = 1;
  const pending = new Map<number, (frame: { t: string; value?: unknown; error?: string }) => void>();
  const channelMessages = new Map<number, unknown[]>();
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.t === "ch") {
      const list = channelMessages.get(frame.ch) ?? [];
      list.push(frame.msg);
      channelMessages.set(frame.ch, list);
    } else pending.get(frame.id)?.(frame);
  });
  return {
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      const id = next++;
      ws.send(JSON.stringify({ t: "req", id, cmd, args }));
      return new Promise<{ t: string; value?: unknown; error?: string }>((resolve) => pending.set(id, resolve));
    },
    channelMessages,
    close: () => ws.close(),
  };
}
