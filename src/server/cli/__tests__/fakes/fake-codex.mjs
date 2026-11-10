// A scripted stand-in for `codex app-server` (JSON-RPC over stdio), never the
// real one. Notification shapes are as codex-cli 0.167 sent them. Run n logs
// argv (args-n.json), environment (env-n.json) and every message it gets
// (rpc-n.jsonl) in $FAKE_DIR. Threads listed in $FAKE_DIR/stale are unknown.
// What the message contains picks behaviour: "slow" streams "Partial" and
// waits for turn/interrupt; "unauthorized" fails the way a signed-out Codex
// does; "tools" runs a failing command and asks for an approval.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);

if (args[0] === "login") {
  fs.appendFileSync(path.join(dir, "login.log"), JSON.stringify({ args, home: process.env.CODEX_HOME }) + "\n");
  if (args[1] === "status") console.log(process.env.FAKE_LOGGED_IN === "0" ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "logout") process.exit(0);
if (args[0] === "debug") {
  console.log(JSON.stringify({ models: [{ slug: "gpt-b", display_name: "B", visibility: "list", priority: 2 }, { slug: "gpt-a", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "high" }] }, { slug: "hidden", visibility: "hide" }] }));
  process.exit(0);
}

const appServer = args.indexOf("app-server");
const n = Number(fs.existsSync(path.join(dir, "count")) ? fs.readFileSync(path.join(dir, "count"), "utf8") : 0) + 1;
fs.writeFileSync(path.join(dir, "count"), String(n));
fs.writeFileSync(path.join(dir, `args-${n}.json`), JSON.stringify(args));
fs.writeFileSync(path.join(dir, `env-${n}.json`), JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME ?? null, CODEX_THREAD_ID: process.env.CODEX_THREAD_ID ?? null, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, cwd: process.cwd() }));
fs.writeFileSync(path.join(dir, `pid-${n}`), String(process.pid));
if (appServer < 0) process.exit(2);

const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const log = (v) => fs.appendFileSync(path.join(dir, `rpc-${n}.jsonl`), JSON.stringify(v) + "\n");
const stale = fs.existsSync(path.join(dir, "stale")) ? fs.readFileSync(path.join(dir, "stale"), "utf8").split("\n") : [];
const threadId = `01a1c78a-7149-7ba2-b0b6-${String(n).padStart(12, "0")}`;
let thread = threadId;
let turn = null;
let interrupted = null;
let serverRequest = 1000;

const pages = [
  { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "Flagship", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }, { reasoningEffort: "bogus" }], defaultReasoningEffort: "ultra" }], nextCursor: "page-2" },
  { data: [{ id: "mini", model: "gpt-6.1-mini", displayName: " ", hidden: false, isDefault: false, supportedReasoningEfforts: [] }, { id: "secret", model: "secret", hidden: true }, { displayName: "no id" }], nextCursor: process.env.FAKE_CYCLE === "1" ? "page-2" : null },
];

function runTurn(text) {
  const turnId = `01a1c78b-0000-7000-8000-${String(n).padStart(12, "0")}`;
  turn = turnId;
  const note = (method, params) => send({ method, params: { threadId: thread, turnId, ...params } });
  setTimeout(() => {
    note("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
    if (text.includes("unauthorized")) {
      for (let i = 2; i <= 3; i++) note("error", { error: { message: `Reconnecting... ${i}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" }, willRetry: true });
      const error = { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null };
      note("error", { error, willRetry: false });
      send({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "failed", error, items: [] } } });
      return;
    }
    if (text.includes("tools")) {
      const cmd = { type: "commandExecution", id: "call_1", command: `/bin/bash -lc 'cat ${process.cwd()}/notes.md'`, cwd: process.cwd(), status: "inProgress", exitCode: null, aggregatedOutput: null, commandActions: [] };
      note("item/started", { item: cmd });
      send({ id: serverRequest++, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId, itemId: "call_1", command: "rm -rf /" } });
      note("item/completed", { item: { ...cmd, status: "failed", exitCode: 1, aggregatedOutput: "private output" } });
      note("item/completed", { item: { type: "webSearch", id: "ws_1", query: "C241 syllabus", action: null, results: null } });
      note("item/completed", { item: { type: "reasoning", id: "r_1", summary: ["thinking"], content: [] } });
    }
    note("item/started", { item: { type: "agentMessage", id: "msg_1", text: "" } });
    if (text.includes("slow")) {
      note("item/agentMessage/delta", { itemId: "msg_1", delta: "Partial" });
      if (text.includes("ignore")) process.on("SIGTERM", () => {});
      return;
    }
    note("item/agentMessage/delta", { itemId: "msg_1", delta: "Reply " });
    note("item/agentMessage/delta", { itemId: "msg_1", delta: `${n}.` });
    note("item/completed", { item: { type: "agentMessage", id: "msg_1", text: `Reply ${n}.` } });
    if (text.includes("tools")) note("item/completed", { item: { type: "agentMessage", id: "msg_2", text: "Second part." } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "completed", error: null, items: [] } } });
  }, 5);
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
    if (msg.method === undefined) continue; // an answer to our server request
    const reply = (result) => send({ id: msg.id, result });
    const fail = (code, message) => send({ id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize":
        reply({ userAgent: "phaethon/0.167.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" });
        break;
      case "initialized":
        break;
      case "account/read":
        reply(process.env.FAKE_LOGGED_IN === "0" ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "s@example.edu", planType: "plus" }, requiresOpenaiAuth: true });
        break;
      case "account/rateLimits/read":
        reply({ rateLimitsByLimitId: { codex: { limitId: "codex", planType: "plus", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1794349200 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } } } });
        break;
      case "model/list": {
        const page = msg.params.cursor === "page-2" ? pages[1] : pages[0];
        reply(page);
        break;
      }
      case "thread/start":
        thread = threadId;
        reply({ thread: { id: thread }, model: msg.params.model ?? "gpt-6.1-sol", approvalPolicy: msg.params.approvalPolicy, sandbox: { type: "readOnly", networkAccess: false } });
        break;
      case "thread/resume":
        if (stale.includes(msg.params.threadId)) fail(-32600, `no rollout found for thread id ${msg.params.threadId}`);
        else {
          thread = msg.params.threadId;
          reply({ thread: { id: thread } });
        }
        break;
      case "turn/start":
        reply({ turn: { id: `01a1c78b-0000-7000-8000-${String(n).padStart(12, "0")}`, status: "inProgress", items: [] } });
        runTurn(msg.params.input.map((x) => x.text).join("").split("The user's new message:\n\n").at(-1));
        break;
      case "turn/interrupt":
        interrupted = msg.params.turnId;
        reply({});
        if (!process.env.FAKE_IGNORE_INTERRUPT) send({ method: "turn/completed", params: { threadId: thread, turn: { id: interrupted, status: "interrupted", error: null, items: [] } } });
        break;
      default:
        fail(-32601, `unknown method ${msg.method}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
