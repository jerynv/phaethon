import { symlink } from "../../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../../tests/harness.ts";
import type { CliId } from "../cli.ts";
import { errors, FakeLog, fakeBin, request, send, setup } from "./helpers.ts";

const env = tempHome("phaethon-cli-workspace-");
afterAll(() => env.cleanup());
let log: FakeLog;
let school: string;
let project: string;

beforeAll(() => {
  const s = setup(env.home, "workspace");
  log = new FakeLog(s.log);
  school = s.school;
  project = fs.realpathSync.native(fs.mkdtempSync(path.join(env.home, "project-")));
  const bins = path.join(env.home, "bin");
  process.env.PHAETHON_CLAUDE_BIN = fakeBin(bins, "claude");
  process.env.PHAETHON_CODEX_BIN = fakeBin(bins, "codex");
  process.env.PHAETHON_GEMINI_BIN = fakeBin(bins, "gemini");
});

const home = (cli: CliId) => (cli === "claude" ? null : path.join(env.appData, "claude-config", `default-${cli}`));
const attachments = [{ type: "phaethon_attachment", path: "attachments/a.pdf", media_type: "application/pdf", name: "a.pdf" }];

describe("a bound project folder", () => {
  for (const cli of ["claude", "codex", "gemini"] as CliId[]) {
    it(`is ${cli}'s working folder; the space stays readable and holds all metadata`, async () => {
      const n = log.runs() + 1;
      const events = await send(request(cli, "school", "Look", { workingDir: project, configDir: home(cli), attachments }));
      expect(errors(events)).toEqual([]);
      expect(log.env(n).cwd).toBe(project);
      const args = log.args(n);
      let said: string;
      if (cli === "claude") {
        expect(log.flag(n, "--add-dir")).toBe(school);
        said = log.text(`stdin-${n}`) + log.flag(n, "--append-system-prompt");
      } else if (cli === "codex") {
        expect(args.find((a) => a.startsWith("permissions.phaethon.filesystem="))).toContain(`${JSON.stringify(project)}="read",${JSON.stringify(school)}="read"`);
        const rpc = log.rpc(n);
        const input = rpc.find((m) => m.method === "turn/start")!.params!.input as { text: string }[];
        said = String(rpc.find((m) => m.method === "thread/start")!.params!.developerInstructions) + input[0].text;
        expect(rpc.find((m) => m.method === "thread/start")!.params!.cwd).toBe(project);
      } else {
        expect(log.flag(n, "--include-directories")).toBe(school);
        said = log.text(`prompt-${n}`);
        expect(log.rpc(n).find((m) => m.method === "session/new")!.params!.cwd).toBe(project);
      }
      expect(said).toContain(`# Workspace\n\nProject working folder: ${JSON.stringify(project)}\nPhaethon space context: ${JSON.stringify(school)}\n`);
      expect(said).toContain(path.join(school, "attachments/a.pdf"));
      expect(fs.existsSync(path.join(project, ".phaethon"))).toBe(false);
      expect(fs.existsSync(path.join(school, ".phaethon", "thread.json"))).toBe(true);
    });
  }

  it("stays the working folder with full access", async () => {
    const n = log.runs() + 1;
    await send(request("claude", "school", "Go", { workingDir: project, fullAccess: true }));
    expect(log.env(n).cwd).toBe(project);
    expect(log.args(n)).toContain("--dangerously-skip-permissions");
    expect(log.flag(n, "--append-system-prompt")!.startsWith("# Full access\n\n")).toBe(true);
  });

  it("is refused before launch when it moved or was replaced by a link", async () => {
    const n = log.runs();
    const gone = await send(request("claude", "school", "Go", { workingDir: path.join(env.home, "moved") }));
    expect(errors(gone)[0].message).toMatch(/^The workspace folder is unavailable\. Choose it again: /);
    const link = path.join(env.home, "linked");
    symlink(project, link);
    const linked = await send(request("claude", "school", "Go", { workingDir: link }));
    expect(errors(linked)).toEqual([{ code: "cli", message: "The workspace folder changed or is unavailable. Choose it again." }]);
    expect(log.runs()).toBe(n);
  });

  it("is released: the space is the working folder again", async () => {
    const n = log.runs() + 1;
    await send(request("claude", "school", "Back"));
    expect(log.env(n).cwd).toBe(school);
    expect(log.args(n)).not.toContain("--add-dir");
  });
});

describe("the space's reasoning level", () => {
  it("is read from space.json for the model, and a bad saved value stops the turn", async () => {
    const meta = path.join(school, ".phaethon", "space.json");
    fs.writeFileSync(meta, JSON.stringify({ name: "School", cliReasoning: { claude: { "claude-opus-5-5": "max", $default: "low" } } }));
    let n = log.runs() + 1;
    await send({ ...request("claude", "school", "Think", { model: "claude-opus-5-5" }), reasoning: undefined });
    expect(log.flag(n, "--effort")).toBe("max");
    n = log.runs() + 1;
    await send({ ...request("claude", "school", "Think"), reasoning: undefined });
    expect(log.flag(n, "--effort")).toBe("low");
    fs.writeFileSync(meta, JSON.stringify({ cliReasoning: { claude: { $default: "ultra" } } }));
    const bad = await send({ ...request("claude", "school", "Think"), reasoning: undefined });
    expect(errors(bad)).toEqual([{ code: "storage", message: "Invalid saved reasoning level." }]);
    fs.rmSync(meta);
  });
});
