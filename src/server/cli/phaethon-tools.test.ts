import { afterAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import type { Record_ } from "../core/thread.ts";
import { readItems } from "../memory/items.ts";
import { closeMcp, openTurnTools } from "./mcp-http.ts";
import { phaethonTool, presentTool, toolHost } from "./phaethon-tools.ts";
import { ToolEvents, argsSummary } from "./tools.ts";
import { withPhaethonTools } from "./claude.ts";

const env = tempHome();
ensureVault();
afterAll(() => {
  closeMcp();
  env.cleanup();
});

function host() {
  const records: Record_[] = [];
  const h = toolHost({ space: "work", thread: "123", signal: new AbortController().signal, onRecord: (r) => records.push(r) });
  return { h, records };
}

const post = (url: string, token: string | null, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe("Phaethon's tools for the coding agents", () => {
  it("are the same tools Phaethon's own agent has, and their records come back", async () => {
    const { h, records } = host();
    expect(h.defs.map((d) => d.name)).toEqual(expect.arrayContaining(["recall", "person", "remember", "note_profile", "update_person"]));
    const r = await h.call("remember", { kind: "state", text: "Out sick today", until: new Date(Date.now() + 3_600_000).toISOString() });
    expect(r.isError).toBe(false);
    expect(records[0]).toMatchObject({ kind: "memory", action: "saved", text: "Out sick today" });
    expect(readItems()[0]).toMatchObject({ text: "Out sick today", source: { space: "work", thread: "123" } });
    expect(await h.call("rm_rf", {})).toMatchObject({ isError: true });
  });

  it("MCP over local HTTP answers only with the turn's token, and stops when the turn ends", async () => {
    const { h, records } = host();
    const t = await openTurnTools(h);
    expect(t.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await post(t.url, null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await post(t.url, "f".repeat(64), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const init = await (await post(t.url, t.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(init.result.serverInfo.name).toBe("phaethon");
    expect((await post(t.url, t.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await (await post(t.url, t.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((x: { name: string }) => x.name)).toContain("note_profile");
    const call = await (await post(t.url, t.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "note_profile", arguments: { scope: "user", text: "Never use em dashes" } } })).json();
    expect(call.result.isError).toBe(false);
    expect(records.at(-1)).toMatchObject({ kind: "profile", scope: "vault", text: "Never use em dashes" });
    t.close();
    expect((await post(t.url, t.token, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status).toBe(401);
  });

  it("Claude Code gets only Phaethon's MCP server, allowed without asking", () => {
    const args = withPhaethonTools(["--allowedTools", "Read,Grep,Glob", "--restricted", "--strict-mcp-config", "--safe-mode"], "/tmp/x/mcp.json");
    // --safe-mode would turn the server off; the walls stay through --restricted, --strict-mcp-config and ISOLATION_ENV.
    expect(args).toEqual(["--allowedTools", "Read,Grep,Glob,mcp__phaethon", "--restricted", "--strict-mcp-config", "--mcp-config", "/tmp/x/mcp.json"]);
  });
});

describe("how tool steps show", () => {
  it("knows Phaethon's tools under every agent's naming", () => {
    expect(phaethonTool("mcp__phaethon__recall")).toBe("recall");
    expect(phaethonTool("recall")).toBe("recall");
    expect(phaethonTool("phaethon.mail_search")).toBe("mail_search");
    expect(phaethonTool("mcp__other__recall")).toBeUndefined();
    expect(phaethonTool("exec_command")).toBeUndefined();
  });

  it("a lookup says what it looked up and what it found; a saving tool has its own line instead", () => {
    const ev = new ToolEvents("codex", "/s", []);
    const start = ev.startNamed("c1", "recall", { query: "meeting with Dana" });
    expect(start[1]).toMatchObject({ kind: "toolStart", category: "search", label: "Recalling", target: "“meeting with Dana”" });
    expect(ev.end("c1", "success", "## Memories\n- Meeting with Dana")[0]).toMatchObject({ detail: "## Memories\n- Meeting with Dana" });
    expect(presentTool("remember", {})).toEqual({ hidden: true });
    expect(ev.startNamed("c2", "remember", { kind: "note", text: "x" })).toEqual([]);
    expect(ev.end("c2", "success", "Remembered")).toEqual([]);
  });

  it("another agent tool shows its name, arguments and answer, not 'Using tool'", () => {
    const ev = new ToolEvents("codex", "/s", []);
    expect(ev.startNamed("c3", "exec_command", { cmd: "ls", workdir: "/s" })[1]).toMatchObject({ label: "Using exec_command", target: "cmd: ls · workdir: /s" });
    expect(ev.end("c3", "success", "a.md\nb.md")[0]).toMatchObject({ detail: "a.md\nb.md" });
    expect(argsSummary({ nested: { a: 1 } })).toBeUndefined();
  });
});
