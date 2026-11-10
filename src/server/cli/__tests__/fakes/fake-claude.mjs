// A scripted stand-in for `claude`, never the real one. Run n logs its argv
// (args-n.json), stdin (stdin-n) and a few environment variables (env-n.json)
// in $FAKE_DIR. It answers "Reply n." in the session it resumed, or
// 00000000-0000-0000-0000-<n>. A resumed id listed in $FAKE_DIR/stale is
// unknown to it, as the real CLI says. What the message contains picks other
// behaviour: "slow" streams "Partial" and hangs; "stubborn" also starts a
// descendant that ignores SIGTERM and holds stderr; "notloggedin" fails as a
// signed-out CLI does; "tool" reads a file first.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const out = (v) => process.stdout.write(JSON.stringify(v) + "\n");

if (args[0] === "auth") {
  fs.appendFileSync(path.join(dir, "auth.log"), JSON.stringify({ args, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\n");
  if (args[1] === "status") out({ loggedIn: process.env.FAKE_LOGGED_IN !== "0", email: "student@example.edu", subscriptionType: "max" });
  if (args[1] === "login" && process.env.FAKE_LOGIN_HANG === "1") setInterval(() => {}, 1000);
  else process.exit(0);
} else if (args[0] === "--version") {
  console.log("2.1.290 (Claude Code)");
} else if (args.includes("--input-format")) {
  // Control protocol only (models and usage probes): no user message is ever answered.
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      fs.appendFileSync(path.join(dir, "control.log"), line + "\n");
      const req = JSON.parse(line);
      if (req.type !== "control_request") continue;
      if (req.request.subtype === "initialize") {
        out({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: req.request_id,
            response: {
              account: { email: "student@example.edu" },
              models: [
                { value: "default", resolvedModel: "claude-opus-5-5" },
                { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "high", "max", "ultra"], defaultEffortLevel: "high", description: " Most capable " },
                { value: "claude-opus-5.5", resolvedModel: "claude-opus-5-5" },
                { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
                { value: "--bad" },
              ],
            },
          },
        });
      } else if (req.request.subtype === "get_usage") {
        out({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { rate_limits: { five_hour: { utilization: 12.5, resets_at: "2026-11-10T20:00:00Z" }, seven_day: { utilization: 140 } } } } });
      }
    }
  });
} else {
  const n = Number(fs.existsSync(path.join(dir, "count")) ? fs.readFileSync(path.join(dir, "count"), "utf8") : 0) + 1;
  fs.writeFileSync(path.join(dir, "count"), String(n));
  fs.writeFileSync(path.join(dir, `args-${n}.json`), JSON.stringify(args));
  const env = {};
  for (const k of ["CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "PATH"]) env[k] = process.env[k] ?? null;
  env.cwd = process.cwd();
  fs.writeFileSync(path.join(dir, `env-${n}.json`), JSON.stringify(env));
  fs.writeFileSync(path.join(dir, `pid-${n}`), String(process.pid));
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (stdin += d));
  process.stdin.on("end", () => {
    fs.writeFileSync(path.join(dir, `stdin-${n}`), stdin);
    // Only the new message picks the behaviour, not the conversation before it.
    stdin = stdin.split("The user's new message:\n\n").at(-1);
    if (args.includes("--no-session-persistence")) {
      out({ type: "result", subtype: "success", is_error: false, result: "- Test 1 for C241 is on Thursday." });
      return;
    }
    const at = args.indexOf("--resume");
    const resume = at >= 0 ? args[at + 1] : "";
    const stale = fs.existsSync(path.join(dir, "stale")) ? fs.readFileSync(path.join(dir, "stale"), "utf8").split("\n") : [];
    if (resume && stale.includes(resume)) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: `No conversation found with session ID: ${resume}` });
      process.exitCode = 1;
      return;
    }
    const sid = resume || `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    out({ type: "system", subtype: "init", session_id: sid });
    if (stdin.includes("notloggedin")) {
      out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
      process.exitCode = 1;
      return;
    }
    if (stdin.includes("tool")) {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me look." } } });
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: path.join(process.cwd(), "notes.md") } }] } });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "secret notes" }] } });
      out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
    }
    if (stdin.includes("slow") || stdin.includes("stubborn")) {
      if (stdin.includes("stubborn")) {
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "inherit"] });
        fs.writeFileSync(path.join(dir, `descendant-${n}`), String(child.pid));
      }
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Partial" } } });
      if (stdin.includes("stubborn")) process.on("SIGTERM", () => process.exit(143));
      setInterval(() => {}, 1000);
      return;
    }
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `Reply ${n}.` } } });
    out({ type: "result", subtype: "success", is_error: false, result: `Reply ${n}.`, session_id: sid });
  });
}
