import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { appFiles, ensureVault, spaceDir, vaultRoot } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import {
  ApiModel,
  CliModel,
  MISSING_CLI_MESSAGE,
  NO_MODEL,
  NOT_LOGGED_IN_MESSAGE,
  OtherCliModel,
  askJson,
  cliArgs,
  cliArgsSeeing,
  cliMessage,
  extractJson,
  modelForSpace,
  parseCliOutput,
  parseOtherOutput,
  pictureBlocks,
  stderrSummary,
  withImages,
} from "./model.ts";
import { Scripted } from "./testing.ts";

const asked: unknown[] = [];
let completeReply: { text: string } | Error = { text: "{\"ok\":1}" };
let seesPictures = false;
vi.mock("../providers/complete.ts", () => ({
  completeSeesPictures: () => seesPictures,
  completeText: async (req: unknown) => {
    asked.push(req);
    if (completeReply instanceof Error) throw completeReply;
    return { text: completeReply.text, model: "m" };
  },
}));

const env = tempHome("phaethon-study-model-");
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

const unix = process.platform !== "win32";

function fakeCli(dir: string, script: string, name = "claude"): string {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function writeSettings(v: Record<string, unknown>) {
  fs.mkdirSync(path.join(vaultRoot(), ".phaethon"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot(), ".phaethon", "settings.json"), JSON.stringify(v));
}

function writeSpaceMeta(v: Record<string, unknown>) {
  const dir = path.join(spaceDir("school"), ".phaethon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify(v));
}

describe("model", () => {
  it("the provider is asked once with no tools", async () => {
    const m = new ApiModel("school", undefined);
    expect(await m.complete("sys", "hello")).toBe("{\"ok\":1}");
    expect(asked.at(-1)).toMatchObject({ space: "school", system: "sys", messages: [{ role: "user", content: "hello" }] });
    expect(asked).toHaveLength(1);
    // Pictures: each named, then shown, then the question.
    const pic = { label: "courses/C/files/n.pdf, page 2", mime: "image/png", data: "iVBO" };
    const blocks = pictureBlocks("read it", [pic]);
    expect(blocks[0]).toEqual({ type: "text", text: "Picture: courses/C/files/n.pdf, page 2" });
    expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } });
    expect(blocks[2]).toEqual({ type: "text", text: "read it" });
    // A model that can't see pictures is asked without them; one that can gets them before the question.
    expect(m.showsPictures()).toBe(false);
    await m.completeSeeing("sys", "read it", [pic]);
    expect(asked.at(-1)).toMatchObject({ messages: [{ role: "user", content: "read it" }] });
    seesPictures = true;
    expect(m.showsPictures()).toBe(true);
    await m.completeSeeing("sys", "read it", [pic]);
    expect(asked.at(-1)).toMatchObject({ messages: [{ role: "user", content: blocks }] });
    seesPictures = false;
    completeReply = new Error("Phaethon couldn’t reach Anthropic.");
    await expect(m.complete("s", "u")).rejects.toBe("Phaethon couldn’t reach Anthropic.");
    // No provider set up and no Claude Code to fall back on: the provider's reason.
    completeReply = new Refusal(NO_MODEL);
    await expect(new ApiModel("school", undefined, undefined, () => null).complete("s", "u")).rejects.toBe(NO_MODEL);
    // With a fallback, it is asked instead.
    const fallback = new Scripted(["from the CLI"]);
    expect(await new ApiModel("school", undefined, undefined, () => fallback).complete("s", "u")).toBe("from the CLI");
    completeReply = { text: "{\"ok\":1}" };
  });

  it("json is found in fences, prose, and strings with brackets", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a": [1]}\n```\nEnjoy')).toEqual({ a: [1] });
    expect(extractJson('Sure! {"q": "is {x} a set? \\"}\\""} done')).toEqual({ q: 'is {x} a set? "}"' });
    expect(extractJson('[1, 2] and {"b":2}')).toEqual([1, 2]);
    expect(extractJson('{broken {"c":3}')).toEqual({ c: 3 });
    expect(extractJson("no json here")).toBeUndefined();
  });

  it("a bad answer is retried once with the problem", async () => {
    const check = (v: unknown) => {
      const n = (v as { n?: unknown })?.n;
      if (typeof n !== "number") throw '"n" must be a number';
      return n;
    };
    let m = new Scripted(['{"n": "two"}', '{"n": 2}']);
    expect(await askJson(m, "s", "make n", check)).toBe(2);
    expect(m.asked[1]!.user).toContain('"n" must be a number');
    expect(m.asked[1]!.user).toContain('{"n": "two"}');
    m = new Scripted(["nope", 'still {"n": null}']);
    const err = await askJson(m, "s", "u", check).catch((e) => e as string);
    expect(err).toContain("nothing was saved");
    expect(err).toContain("must be a number");
    expect(m.calls()).toBe(2);
    m = Scripted.failing(NO_MODEL);
    await expect(askJson(m, "s", "u", check)).rejects.toBe(NO_MODEL);
  });

  it("cli output is parsed robustly", () => {
    expect(parseCliOutput('{"type":"result","subtype":"success","is_error":false,"result":"hi"}')).toBe("hi");
    expect(parseCliOutput('[{"type":"system"},{"type":"result","subtype":"success","result":"yo"}]')).toBe("yo");
    expect(parseCliOutput('{"type":"system"}\n{"type":"result","subtype":"success","result":"z"}\n')).toBe("z");
    expect(parseCliOutput("plain text answer")).toBe("plain text answer");
    expect(() => parseCliOutput('{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}')).toThrow(NOT_LOGGED_IN_MESSAGE);
    let e: unknown;
    try {
      parseCliOutput('{"type":"result","subtype":"error_max_turns","is_error":true}');
    } catch (x) {
      e = x;
    }
    expect(String(e)).toContain("error_max_turns");
    expect(() => parseCliOutput("  ")).toThrow();
    expect(parseOtherOutput("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"a"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"b"}}\n')).toBe("a\n\nb");
    expect(() => parseOtherOutput("codex", '{"type":"turn.failed","error":{"message":"nope"}}')).toThrow("Codex said: nope");
    expect(() => parseOtherOutput("codex", "")).toThrow("Codex didn’t answer.");
    expect(parseOtherOutput("gemini", 'noise\n{"response":"hi","stats":{}}')).toBe("hi");
    expect(() => parseOtherOutput("gemini", '{"error":{"message":"bad"}}')).toThrow("Gemini CLI said: bad");
    expect(stderrSummary("boom\n\n")).toBe("boom");
    expect(stderrSummary("x\nTypeError: y\n    at z (f.js:1)\n")).toBe("TypeError: y");
  });

  it("cli args allow no tools and none of the user's setup", () => {
    const a = cliArgs("SYS");
    const pair = (xs: string[], f: string, v: string) => xs.some((x, i) => x === f && xs[i + 1] === v);
    expect(pair(a, "--tools", "")).toBe(true);
    for (const flag of ["-p", "--restricted", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"]) expect(a).toContain(flag);
    expect(pair(a, "--output-format", "json")).toBe(true);
    expect(pair(a, "--system-prompt", "SYS")).toBe(true);
    expect(a.some((x) => x.includes("dangerously") || x === "bypassPermissions" || x === "--bare" || x === "--resume")).toBe(false);
    const s = cliArgsSeeing("SYS");
    expect(pair(s, "--input-format", "stream-json")).toBe(true);
    expect(pair(s, "--output-format", "stream-json")).toBe(true);
    expect(s).toContain("--verbose");
    expect(pair(s, "--tools", "")).toBe(true);
    for (const flag of ["--restricted", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"]) expect(s).toContain(flag);
    const v = JSON.parse(cliMessage("read it", [{ label: "p. 1", mime: "image/jpeg", data: "/9j/" }]).trim());
    expect(v.type).toBe("user");
    expect(v.message.content[1].source.media_type).toBe("image/jpeg");
    expect(v.message.content[2].text).toBe("read it");
    expect(withImages(["exec", "--json", "-"], ["/t/picture-1.png"])).toEqual(["exec", "--json", "--image=/t/picture-1.png", "-"]);
  });

  it.skipIf(!unix)("study text and images use the captured model and reasoning from the selected connection", async () => {
    const cases = [
      { cli: "claude", selected: "claude-opus-5-5", next: "claude-sonnet-5-5", effort: "max" },
      { cli: "codex", selected: "gpt-6.1-sol", next: "gpt-6-luna", effort: "xhigh" },
    ] as const;
    for (const c of cases) {
      const fake = path.join(env.home, `fake-${c.cli}`);
      const bin = fakeCli(
        fake,
        `for a in "$@"; do printf '%s\\n' "$a"; done > "$(dirname "$0")/args"
cat > "$(dirname "$0")/stdin"
for a in "$@"; do case "$a" in --image=*) cat "\${a#--image=}" > "$(dirname "$0")/image";; esac; done
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}' '{"type":"result","subtype":"success","result":"{\\"ok\\":true}"}'`,
      );
      const id = `${c.cli}-study`;
      const home = path.join(appFiles.claudeConfigRoot(), `default-instance-${id}`);
      fs.mkdirSync(home, { recursive: true });
      const instance = { id, cli: c.cli, name: "Study test", binary: bin, args: [] };
      fs.writeFileSync(path.join(home, "phaethon-instance.json"), JSON.stringify(instance));
      writeSettings({ backend: `${c.cli}-cli`, agentInstances: [instance], activeAgentInstances: { [c.cli]: id } });
      writeSpaceMeta({ cliModels: { [c.cli]: c.selected }, cliReasoning: { [c.cli]: { [c.selected]: c.effort } } });
      const captured = modelForSpace("school");
      // A later change doesn't touch a workflow already holding this model.
      writeSpaceMeta({ cliModels: { [c.cli]: c.next }, cliReasoning: { [c.cli]: { [c.next]: "low" } } });
      expect(await captured.complete("Make a quiz.", "Study material.")).toBe('{"ok":true}');
      const readArgs = () => fs.readFileSync(path.join(fake, "args"), "utf8");
      const has = (args: string, f: string, v: string) => {
        const l = args.split("\n");
        return l.some((x, i) => x === f && l[i + 1] === v);
      };
      const checkSelected = (args: string) => {
        expect(has(args, c.cli === "claude" ? "--model" : "-m", c.selected)).toBe(true);
        if (c.cli === "claude") {
          expect(has(args, "--effort", c.effort) && has(args, "--tools", "")).toBe(true);
          expect(args.split("\n")).toContain("--restricted");
        } else {
          expect(has(args, "-c", `model_reasoning_effort="${c.effort}"`)).toBe(true);
          expect(args.includes('approval_policy="never"') && args.includes("--ephemeral") && args.includes("shell_tool")).toBe(true);
        }
        expect(args.includes("Study material.") || args.includes("dangerously")).toBe(false);
      };
      checkSelected(readArgs());
      expect(fs.readFileSync(path.join(fake, "stdin"), "utf8")).toBe("Study material.");
      const picture = { label: "Original page 1", mime: "image/png", data: "aGk=" };
      expect(await captured.completeSeeing("Make a quiz.", "Read handwriting.", [picture])).toBe('{"ok":true}');
      checkSelected(readArgs());
      const input = fs.readFileSync(path.join(fake, "stdin"), "utf8");
      expect(input.includes("Read handwriting.") && input.includes("Original page 1")).toBe(true);
      if (c.cli === "claude") expect(input).toContain("aGk=");
      else expect(fs.readFileSync(path.join(fake, "image"), "utf8")).toBe("hi");
      writeSpaceMeta({ cliReasoning: { [c.cli]: { $default: "high" } } });
      await modelForSpace("school").complete("Grade the answer.", "Answer.");
      let args = readArgs();
      expect(args.split("\n").some((a) => a === "--model" || a === "-m")).toBe(false);
      if (c.cli === "claude") expect(has(args, "--effort", "high")).toBe(true);
      else expect(has(args, "-c", 'model_reasoning_effort="high"')).toBe(true);
      writeSpaceMeta({});
      await modelForSpace("school").complete("Grade the answer.", "Answer.");
      args = readArgs();
      expect(args.split("\n").some((a) => ["--model", "-m", "--effort"].includes(a)) || args.includes("model_reasoning_effort")).toBe(false);
    }
    writeSettings({});
  });

  it.skipIf(!unix)("study rejects unsupported reasoning without spawning a process", async () => {
    const root = path.join(env.home, "unsupported");
    const bin = fakeCli(root, 'touch "$(dirname "$0")/called"');
    const m = new CliModel({ bin, cwd: root, configDir: null, model: "claude-opus-5-5", reasoning: "ultra" });
    await expect(m.complete("s", "u")).rejects.toContain("does not support");
    expect(fs.existsSync(path.join(root, "called"))).toBe(false);
    const other = new OtherCliModel("gemini", { bin, cwd: root, configDir: null, model: "pro", reasoning: "high" });
    expect(() => other.invocation("s", "u")).toThrow("does not support");
    expect(fs.existsSync(path.join(root, "called"))).toBe(false);
  });

  it.skipIf(!unix)("a fake CLI gets the question on stdin and its answer is read", async () => {
    const dir = path.join(env.home, "cli");
    const bin = fakeCli(
      dir,
      `for a in "$@"; do printf '%s\\n' "$a"; done > "$(dirname "$0")/args"
cat > "$(dirname "$0")/stdin"
printf '%s' "\${CLAUDECODE:-unset}" > "$(dirname "$0")/env"
printf '{"type":"result","subtype":"success","is_error":false,"result":"\`\`\`json\\\\n{\\\\"cards\\\\": []}\\\\n\`\`\`"}'`,
    );
    process.env.CLAUDECODE = "1";
    try {
      const m = new CliModel({ bin, cwd: dir, configDir: null, model: null, reasoning: null });
      const reply = await m.complete("You make flashcards.", "Material: sets");
      expect(extractJson(reply)).toEqual({ cards: [] });
      expect(fs.readFileSync(path.join(dir, "stdin"), "utf8")).toBe("Material: sets");
      const args = fs.readFileSync(path.join(dir, "args"), "utf8");
      expect(args).toContain("--tools\n\n");
      expect(args).toContain("--system-prompt\nYou make flashcards.\n");
      expect(args).not.toContain("Material");
      expect(fs.readFileSync(path.join(dir, "env"), "utf8")).toBe("unset");
    } finally {
      delete process.env.CLAUDECODE;
    }
    const loggedOut = fakeCli(path.join(dir, "out"), `cat >/dev/null; echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'`);
    await expect(new CliModel({ bin: loggedOut, cwd: dir, configDir: null, model: null, reasoning: null }).complete("s", "u")).rejects.toBe(NOT_LOGGED_IN_MESSAGE);
    const crashed = fakeCli(path.join(dir, "crash"), "cat >/dev/null; echo 'boom: something broke' >&2; exit 3");
    await expect(new CliModel({ bin: crashed, cwd: dir, configDir: null, model: null, reasoning: null }).complete("s", "u")).rejects.toBe(
      "Claude Code stopped: boom: something broke",
    );
    await expect(new CliModel({ bin: path.join(dir, "missing"), cwd: dir, configDir: null, model: null, reasoning: null }).complete("s", "u")).rejects.toBe(
      MISSING_CLI_MESSAGE,
    );
  });

  it.skipIf(!unix)("cancelling stops the CLI and rejects", async () => {
    const dir = path.join(env.home, "slow");
    const bin = fakeCli(dir, "sleep 30");
    const ac = new AbortController();
    const m = new CliModel({ bin, cwd: dir, configDir: null, model: null, reasoning: null, signal: ac.signal });
    const p = m.complete("s", "u");
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toBe("Stopped.");
  });

  it("the backend picks the model", () => {
    writeSettings({ backend: "codex-cli" });
    process.env.PHAETHON_CODEX_BIN = "/nonexistent/codex";
    expect(modelForSpace("school")).toBeInstanceOf(OtherCliModel);
    delete process.env.PHAETHON_CODEX_BIN;
    writeSettings({});
    expect(modelForSpace("school")).toBeInstanceOf(ApiModel);
    writeSettings({ backend: "claude-cli", activeAgentInstances: { claude: "claude-missing" }, agentInstances: [{ id: "claude-missing", cli: "claude", name: "x" }] });
    // A named connection has a computed home, so selection succeeds; with no binary found it says Claude Code is missing.
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(() => modelForSpace("school")).toThrow(MISSING_CLI_MESSAGE);
    } finally {
      process.env.PATH = saved;
    }
    writeSettings({});
    expect(() => modelForSpace("nope")).toThrow('space "nope" does not exist in this vault');
  });
});
