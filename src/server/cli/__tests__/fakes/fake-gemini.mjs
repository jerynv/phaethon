// A scripted stand-in for `gemini`, never the real one. With `--acp` it is an
// ACP (v1) agent over stdio; with `--output-format text` it plays Gemini
// CLI's own Google sign-in. Run n logs argv (args-n.json), environment
// (env-n.json) and every message it gets (rpc-n.jsonl) in $FAKE_DIR.
// Sessions listed in $FAKE_DIR/stale can't be loaded. What the message
// contains picks behaviour: "slow" streams "Partial" and waits for
// session/cancel; "tools" reads a file, asks to write one and to read one
// outside; "ineligible" fails as Google refused the account.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const n = Number(fs.existsSync(path.join(dir, "count")) ? fs.readFileSync(path.join(dir, "count"), "utf8") : 0) + 1;
fs.writeFileSync(path.join(dir, "count"), String(n));
fs.writeFileSync(path.join(dir, `args-${n}.json`), JSON.stringify(args));
const env = {};
for (const k of ["GEMINI_CLI_HOME", "GEMINI_CLI_TRUST_WORKSPACE", "GEMINI_SYSTEM_MD", "GEMINI_API_KEY"]) env[k] = process.env[k] ?? null;
env.cwd = process.cwd();
fs.writeFileSync(path.join(dir, `env-${n}.json`), JSON.stringify(env));
fs.writeFileSync(path.join(dir, `pid-${n}`), String(process.pid));

if (args.includes("text")) {
  // Sign-in: ask for consent, then (signed in) stop at "No input provided".
  const mode = process.env.FAKE_SIGN_IN ?? "ok";
  if (mode === "hang") {
    process.stdout.write("Waiting for authentication...\n");
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write("Opening the browser. Do you want to continue? [Y/n] ");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      fs.writeFileSync(path.join(dir, `consent-${n}`), d);
      if (mode === "fail") {
        process.stderr.write("Error authenticating: FatalAuthenticationError: Error: Login was cancelled in the browser\n");
        process.exit(1);
      }
      process.stderr.write("No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.\n");
      process.exit(1);
    });
  }
} else {
  const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\n");
  const log = (v) => fs.appendFileSync(path.join(dir, `rpc-${n}.jsonl`), JSON.stringify(v) + "\n");
  const stale = fs.existsSync(path.join(dir, "stale")) ? fs.readFileSync(path.join(dir, "stale"), "utf8").split("\n") : [];
  const sessionId = `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
  let current = sessionId;
  let pendingPrompt = null;
  let nextId = 500;
  const waiting = new Map();
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  const update = (u) => send({ method: "session/update", params: { sessionId: current, update: u } });

  async function prompt(msg) {
    const full = msg.params.prompt.map((b) => b.text).join("");
    fs.writeFileSync(path.join(dir, `prompt-${n}`), full);
    // Only the new message picks the behaviour, not the conversation before it.
    const text = full.split("The user's new message:\n\n").at(-1);
    if (text.includes("ineligible")) {
      send({ id: msg.id, error: { code: -32603, message: "Internal error", data: "IneligibleTierError: This client is no longer supported." } });
      return;
    }
    if (text.includes("tools")) {
      const notes = path.join(process.cwd(), "notes.md");
      update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "ReadFile notes.md", kind: "read", status: "pending", locations: [{ path: notes }], rawInput: { absolute_path: notes } });
      const readInside = await ask("session/request_permission", { sessionId: current, toolCall: { toolCallId: "read-1", kind: "read", locations: [{ path: notes }] }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
      const write = await ask("session/request_permission", { sessionId: current, toolCall: { toolCallId: "edit-1", kind: "edit", locations: [{ path: notes }] }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
      const readOutside = await ask("session/request_permission", { sessionId: current, toolCall: { toolCallId: "read-2", kind: "read", locations: [{ path: "/etc/passwd" }] }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
      fs.writeFileSync(path.join(dir, `permissions-${n}.json`), JSON.stringify({ readInside, write, readOutside }));
      update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "secret notes" } }] });
      update({ sessionUpdate: "tool_call", toolCallId: "grep-1", title: "SearchText", kind: "search", status: "in_progress", rawInput: { pattern: "Test 1" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "grep-1", status: "failed" });
    }
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    if (text.includes("slow")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial" } });
      pendingPrompt = msg.id;
      return;
    }
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reply " } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${n}.` } });
    send({ id: msg.id, result: { stopReason: "end_turn" } });
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      log(msg);
      if (msg.method === undefined) {
        waiting.get(msg.id)?.(msg.result ?? msg.error);
        continue;
      }
      switch (msg.method) {
        case "initialize":
          send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: process.env.FAKE_NO_LOAD !== "1" }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] } });
          break;
        case "session/new":
          if (process.env.FAKE_LOGGED_IN === "0") send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
          else send({ id: msg.id, result: { sessionId } });
          break;
        case "session/load":
          if (process.env.FAKE_LOGGED_IN === "0") send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
          else if (stale.includes(msg.params.sessionId)) send({ id: msg.id, error: { code: -32603, message: "Invalid session identifier" } });
          else {
            current = msg.params.sessionId;
            // History replay: not this turn's text.
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } });
            send({ id: msg.id, result: {} });
          }
          break;
        case "session/prompt":
          void prompt(msg);
          break;
        case "session/cancel":
          if (pendingPrompt !== null && !process.env.FAKE_IGNORE_CANCEL) {
            send({ id: pendingPrompt, result: { stopReason: "cancelled" } });
            pendingPrompt = null;
          }
          break;
        default:
          send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
