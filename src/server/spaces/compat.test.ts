import { persistedPath } from "../fullaccess/fullaccess.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { runStart } from "../lifecycle.ts";
import { appFiles, spaceDir, vaultRoot } from "../core/vault.ts";
import "./storage.ts";

/**
 * A vault and app-data folder exactly as the Rust app (0.1.x) left them, in
 * the shapes the research spec documents, read through the commands the UI
 * calls. Nothing here may be rewritten just by reading it.
 */

const env = tempHome();
afterAll(() => env.cleanup());

const S1 = "e06355fe-8387-4cb5-9fda-517b0d2b996a";
const S2 = "11111111-2222-4333-8444-555555555555";

function put(p: string, text: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
let written: Map<string, string>;

beforeAll(async () => {
  const vault = path.join(env.home, "Phaethon", "default");
  const school = path.join(vault, "spaces/school");
  const work = path.join(vault, "spaces/work");
  const files: [string, string][] = [
    [path.join(vault, ".phaethon/settings.json"), pretty({ backend: "claude-cli", model: null, provider: "openrouter", providerModels: { openrouter: "x/y" }, appearance: { version: 1, theme: "dark", tokens: { "--ph-accent-h": 290 } }, isolateClaudeConfig: false, futureKey: [1] })],
    [path.join(school, ".phaethon/space.json"), pretty({ name: "School", description: "Courses, deadlines, study notes", hue: 250, educationEnabled: true, model: "openai:gpt-5", cliModels: { codex: "gpt-6.1-sol" }, cliReasoning: { claude: { "claude-opus-5-5": "max", $default: "medium" } }, tutorMode: "socratic" }) + "\n"],
    [path.join(school, ".phaethon/last-used"), "1760000000000\n"],
    [path.join(school, ".phaethon/session"), `${S1}\n`],
    [
      path.join(school, ".phaethon/thread.json"),
      pretty([
        { role: "user", content: [{ type: "phaethon_attachment", path: "attachments/2026-10-09/pic (2).png", media_type: "image/png", name: "pic.png" }, { type: "text", text: "question" }], at: 1760000000000 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "..." },
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.md" } },
            { type: "phaethon_record", kind: "tool", id: "phaethon:1:toolu_1", category: "read", label: "Reading file", target: "a.md", status: "success" },
          ],
          at: 1760000000100,
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file text" }], at: 1760000000200 },
        { role: "assistant", content: [{ type: "text", text: "Answer." }, { type: "phaethon_record", kind: "access", space: "work", path: "calendar", answer: "always" }], at: 1760000000300 },
      ]),
    ],
    [path.join(school, ".phaethon/threads/1759000000000.json"), pretty([{ role: "user", content: [{ type: "steward_attachment", path: "attachments/2026-09-01/old.md", media_type: "text/plain", name: "old.md" }, { type: "text", text: "An older chat" }] }, { role: "assistant", content: [{ type: "text", text: "Old reply" }] }])],
    [path.join(school, ".phaethon/threads/1759000000000.session"), `codex:${S2}\n`],
    [path.join(school, ".phaethon/threads/1758000000000-1.json"), pretty([{ role: "assistant", content: [{ type: "phaethon_record", kind: "imported", from: "claude-code", session: S1, title: "Imported from Claude Code" }, { type: "text", text: "hi" }] }])],
    [path.join(school, "attachments/2026-10-09/pic (2).png"), "\x89PNG\r\n\x1a\n"],
    [path.join(school, "MEMORY.md"), "# Memory\n\nWhat Phaethon keeps for this space. It reads this file before every reply here, and nowhere else. One detail per line; edit or delete any of them. A note like `<!-- from 1760000000000 -->` marks the conversation a detail came from.\n\n- C241 Test 1 is Oct 15. <!-- from 1760000000000 -->\n- My own note\n"],
    [path.join(work, "calendar/oct.md"), "Oct 14: shift 9-5"],
    [path.join(vault, ".phaethon/grants.json"), pretty({ grants: [{ id: "6f1c0000-0000-4000-8000-000000000000", to: "school", from: "work", path: "calendar", created: "2026-10-10T14:03:00Z", scope: "always" }] })],
    [path.join(vault, ".phaethon/course-access.json"), pretty({ school: { "canvas-iu-instructure-com/2411651": ["overview", "syllabus", "files"] } })],
  ];
  fs.mkdirSync(path.join(env.home, "Project"), { recursive: true });
  const project = persistedPath(fs.realpathSync.native(path.join(env.home, "Project")));
  const st = fs.statSync(project, { bigint: true });
  const root = vault; // the canonical root once it exists (tempdir has no links here)
  fs.mkdirSync(vault, { recursive: true });
  const canonical = persistedPath(fs.realpathSync.native(root));
  files.push([appFiles.fullAccess(), pretty([`${canonical}\nwork`])]);
  files.push([
    appFiles.workspaces(),
    `{\n  ${JSON.stringify(`${canonical}\nwork`)}: {\n    "path": ${JSON.stringify(project)},\n    "identity": ${process.platform === "win32" ? "null" : `{\n      "device": ${st.dev},\n      "inode": ${st.ino}\n    }`}\n  }\n}`,
  ]);
  for (const [p, text] of files) put(p, text);
  // Archived conversations sort by their file times.
  for (const id of ["1759000000000", "1758000000000"]) {
    const f = path.join(school, `.phaethon/threads/${id === "1758000000000" ? `${id}-1` : id}.json`);
    fs.utimesSync(f, new Date(), new Date(Number(id)));
  }
  written = new Map(files.map(([p, t]) => [fs.realpathSync.native(p), t]));
  await runStart();
});

describe("files the Rust app wrote", () => {
  it("startup leaves an existing vault as it is", () => {
    for (const [p, text] of written) expect(fs.readFileSync(p, "utf8"), p).toBe(text);
  });

  it("spaces, settings and models read back", async () => {
    const spaces = await call<{ id: string; name: string; hue: number; educationEnabled: boolean; lastUsed: number | null }[]>("spaces_list");
    expect(spaces[0]).toEqual({ id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250, educationEnabled: true, lastUsed: 1760000000000 });
    expect(spaces[1]).toMatchObject({ id: "work", name: "Work", hue: 50, lastUsed: null });
    const settings = await call<Record<string, unknown>>("settings_get");
    expect(settings).toMatchObject({ backend: "claude-cli", provider: "openrouter", appearance: { version: 1, theme: "dark", tokens: { "--ph-accent-h": 290 } } });
    const { readSpaceMeta } = await import("./meta.ts");
    const m = readSpaceMeta("school");
    expect([m.model, m.cliModels, m.tutorMode]).toEqual(["openai:gpt-5", { codex: "gpt-6.1-sol" }, "socratic"]);
    expect(m.cliReasoning).toEqual({ claude: { "claude-opus-5-5": "max", $default: "medium" } });
  });

  it("conversations, sessions and records read back", async () => {
    const ui = await call<{ role: string; text: string; index: number; attachments: unknown[]; records: unknown[]; at?: number }[]>("thread_load", { space: "school" });
    expect(ui).toEqual([
      { role: "user", text: "question", attachments: [{ name: "pic.png", path: "attachments/2026-10-09/pic (2).png", mediaType: "image/png" }], index: 0, records: [], at: 1760000000000 },
      {
        role: "assistant",
        text: "Let me look.\n\nAnswer.",
        attachments: [],
        index: 1,
        records: [
          { kind: "tool", id: "phaethon:1:toolu_1", category: "read", label: "Reading file", target: "a.md", status: "success" },
          { kind: "access", space: "work", path: "calendar", answer: "always" },
        ],
        at: 1760000000300,
      },
    ]);
    const list = await call<{ id: string; title: string; messages: number; current: boolean }[]>("threads_list", { space: "school" });
    expect(list.map((t) => [t.id, t.title, t.messages, t.current])).toEqual([
      ["current", "question", 2, true],
      ["1759000000000", "An older chat", 2, false],
      ["1758000000000-1", "Imported from Claude Code", 1, false],
    ]);
    expect(list[1]).toMatchObject({ updated: 1759000000000 });
    const { readSession } = await import("../threads/store.ts");
    expect(readSession("school")).toBe(S1);
    expect(readSession("school", "codex")).toBeNull();
    await call("thread_open", { space: "school", id: "1759000000000" });
    expect(readSession("school", "codex")).toBe(S2);
    expect(readSession("school")).toBeNull();
    const back = list.find((t) => t.id !== "current" && t.title === "question");
    expect(back).toBeUndefined();
    const reopened = await call<{ id: string; title: string }[]>("threads_list", { space: "school" });
    const prev = reopened.find((t) => t.title === "question")!;
    await call("thread_open", { space: "school", id: prev.id });
    expect(readSession("school")).toBe(S1);
    expect(fs.readFileSync(path.join(spaceDir("school"), ".phaethon/thread.json"), "utf8")).toBe(written.get(path.join(spaceDir("school"), ".phaethon/thread.json")));
  });

  it("memory, grants, full access and the workspace binding read back", async () => {
    const { memoryForPrompt } = await import("../memory/memory.ts");
    expect(memoryForPrompt("school")).toContain("- C241 Test 1 is Oct 15.\n- My own note");
    expect(await call("thread_forget_preview", { space: "school", id: "current" })).toEqual({ files: 1, sharedFiles: 0, facts: 1 });
    const grants = await call<{ grants: { id: string; from: string; path: string; created: string }[]; problems: string[] }>("grants_list", { space: "school" });
    expect(grants.problems).toEqual([]);
    expect(grants.grants).toEqual([{ id: "6f1c0000-0000-4000-8000-000000000000", from: "work", path: "calendar", created: "2026-10-10T14:03:00Z", scope: "always" }]);
    expect(await call("full_access_list")).toEqual(["work"]);
    const ws = await call<{ path: string; kind: string; available: boolean }>("space_workspace_get", { id: "work" });
    expect(ws).toEqual({ path: persistedPath(fs.realpathSync.native(path.join(env.home, "Project"))), kind: "folder", available: true });
    const hits = await call<{ conversations: { title: string; current: boolean }[] }>("conversations_search", { space: "school", query: "older", allSpaces: true });
    // Reopened and put back above, so it is archived under a new id now.
    expect(hits.conversations.map((c) => [c.title, c.current])).toEqual([["An older chat", false]]);
    expect(vaultRoot()).toBe(path.join(env.home, "Phaethon", "default"));
  });
});
