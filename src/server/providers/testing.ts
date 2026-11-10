import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test helpers: a local HTTP server that answers from a queue, and builders
 * for Anthropic and OpenAI-compatible streamed replies. Never used by the app.
 */

export type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; text: string; json: any };
export type Reply = { status?: number; headers?: Record<string, string>; chunks?: (string | Buffer)[]; body?: string; delayMs?: number; holdAfter?: { chunk: number; ms: number } };

export async function fakeServer(replies: (Reply | ((seen: Seen) => Reply))[]) {
  const seen: Seen[] = [];
  const queue = [...replies];
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const text = Buffer.concat(parts).toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, text, json };
    seen.push(s);
    const next = queue.shift();
    const r = typeof next === "function" ? next(s) : next ?? { status: 500, body: "no more replies" };
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    res.writeHead(r.status ?? 200, r.headers ?? { "content-type": "text/event-stream" });
    if (r.chunks) {
      for (const [i, c] of r.chunks.entries()) {
        if (res.destroyed) break;
        res.write(c);
        await new Promise((ok) => setTimeout(ok, r.holdAfter?.chunk === i ? r.holdAfter.ms : 2));
      }
      res.end();
    } else res.end(r.body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    left: () => queue.length,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

const sse = (event: object) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;

/** An Anthropic streamed reply with these blocks. Text and tool input are split into several deltas. */
export function anthropicReply(blocks: Record<string, unknown>[], stopReason = "end_turn"): Reply {
  const events: string[] = [sse({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } })];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push(sse({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      const t = String(b.text);
      const mid = Math.ceil(t.length / 2);
      for (const part of [t.slice(0, mid), t.slice(mid)]) if (part) events.push(sse({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } }));
    } else if (b.type === "tool_use") {
      events.push(sse({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }));
      const raw = typeof b.raw === "string" ? b.raw : JSON.stringify(b.input);
      const mid = Math.ceil(raw.length / 2);
      for (const part of [raw.slice(0, mid), raw.slice(mid)]) if (part) events.push(sse({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } }));
    } else if (b.type === "thinking") {
      events.push(sse({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }));
      if (b.thinking) events.push(sse({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } }));
      events.push(sse({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } }));
    }
    events.push(sse({ type: "content_block_stop", index }));
  });
  events.push(sse({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }));
  events.push(sse({ type: "message_stop" }));
  return { chunks: events };
}

/** An OpenAI-compatible streamed reply: text deltas, then tool calls split across chunks. */
export function openaiReply(text: string, calls: { id: string; name: string; args: string }[] = [], finish?: string): Reply {
  const chunks: string[] = [];
  const data = (v: unknown) => chunks.push(`data: ${JSON.stringify(v)}\n\n`);
  for (const piece of text.match(/.{1,4}/gs) ?? []) data({ choices: [{ index: 0, delta: { content: piece } }] });
  calls.forEach((c, i) => {
    const mid = Math.ceil(c.args.length / 2);
    data({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: c.args.slice(0, mid) } }] } }] });
    data({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: c.args.slice(mid) } }] } }] });
  });
  data({ choices: [{ index: 0, delta: {}, finish_reason: finish ?? (calls.length ? "tool_calls" : "stop") }] });
  chunks.push("data: [DONE]\n\n");
  return { chunks };
}

/** An address where nothing listens (a port just freed). */
export async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((ok) => server.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}
