import path from "node:path";
import type { AgentEvent, ToolCategory, ToolStatus } from "../../shared/agent.ts";
import { isWithin } from "../core/fsx.ts";
import type { Record_ } from "../core/thread.ts";
import { phaethonTool, presentTool, toolResultDetail } from "./phaethon-tools.ts";

/**
 * What a CLI's tool use becomes in Phaethon: a status line, a start/end pair
 * and, once finished, a record in the conversation. The tool's category, a
 * generic label, a shown path, its status and, for a command, the command line
 * it ran (without the shell it was wrapped in, paths as in the space) and the
 * first part of its output are kept; never other raw tool arguments.
 */

export type Granted = { label: string; path: string }[];

/** The first 240 characters that aren't control characters. */
export function shortText(text: string): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (/\p{Cc}/u.test(ch)) continue;
    if (n++ >= 240) break;
    out += ch;
  }
  return out;
}

/** Up to 4000 characters of a tool's output, line breaks kept, other control characters dropped. */
export function outputText(text: string): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (ch !== "\n" && ch !== "\t" && /\p{Cc}/u.test(ch)) continue;
    if (n++ >= 4000) {
      out += "…";
      break;
    }
    out += ch;
  }
  return out.trim();
}

/** A command line as kept: up to 2000 characters, line breaks kept, other control characters dropped. */
export function commandText(text: string): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (ch !== "\n" && /\p{Cc}/u.test(ch)) continue;
    if (n++ >= 2000) {
      out += "…";
      break;
    }
    out += ch;
  }
  return out.trim();
}

export const ERROR_NOTE = "Tool reported an error";

const CATEGORY_OF: Record<string, ToolCategory> = {
  Read: "read",
  read_file: "read",
  read_many_files: "read",
  read_page: "read",
  list_files: "list",
  list_directory: "list",
  Grep: "search",
  Glob: "search",
  grep_search: "search",
  glob: "search",
  search_files: "search",
  web_search: "search",
  Bash: "command",
  run_shell_command: "command",
  command_execution: "command",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  write_file: "write",
  file_change: "write",
};

export function categoryOf(name: string): ToolCategory {
  return CATEGORY_OF[name] ?? "other";
}

const GENERIC_LABEL: Record<ToolCategory, string> = {
  read: "Reading file",
  list: "Listing files",
  search: "Searching",
  command: "Running command",
  write: "Changing file",
  other: "Using tool",
};

/** `p` as shown: named by the granted folder it is in ("work/calendar/oct.md"), else relative to `base`, else as is. */
export function shownPath(p: string, base: string, granted: Granted): { shown: string; inGrant: boolean } {
  for (const g of granted) {
    if (path.isAbsolute(p) && isWithin(p, g.path)) {
      const rel = path.relative(g.path, p).split(path.sep).join("/");
      return { shown: rel ? `${g.label}/${rel}` : g.label, inGrant: true };
    }
  }
  if (path.isAbsolute(p) && isWithin(p, base)) {
    const rel = path.relative(base, p).split(path.sep).join("/");
    return { shown: rel || ".", inGrant: false };
  }
  return { shown: p, inGrant: false };
}

/** "Reading file notes.md", or "Reading work/calendar/oct.md" in another space's granted folder. */
export function place(verb: string, p: string, base: string, granted: Granted): string {
  const { shown, inGrant } = shownPath(p, base, granted);
  return inGrant ? `${verb} ${shown}` : `${verb} file ${shown}`;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"]);
// A shell's options before its script flag (`-l`, `-NoProfile`, `/d /s`), then the flag itself (`-c`, `-lc`, `-Command`, `/c`).
const SHELL_OPTION = /^(?:-[a-z]+|\/[dsq])$/i;
const SCRIPT_FLAG = /^(?:-[a-z]*c|-command|\/c)$/i;

function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "").toLowerCase();
}

/** `'it'\''s'` → `it's`, `"say \"hi\""` → `say "hi"`; anything else as is. */
function unquote(script: string): string {
  const s = script.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'") && !s.slice(1, -1).replaceAll("'\\''", "").includes("'")) return s.slice(1, -1).replaceAll("'\\''", "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"') && !/(^|[^\\])"/.test(s.slice(1, -1))) return s.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return s;
}

/** `/bin/zsh -lc 'cat notes.md'` → `cat notes.md`; a line that isn't a shell running a script stays as it is. */
function withoutShell(line: string): string {
  const s = line.trim();
  const re = /\S+/g;
  const words: string[] = [];
  let end = 0;
  for (let m = re.exec(s); m && words.length < 8; m = re.exec(s)) {
    words.push(m[0]);
    end = re.lastIndex;
    if (words.length > 1 && SCRIPT_FLAG.test(m[0])) break;
  }
  const flag = words.at(-1) ?? "";
  if (words.length < 2 || !SHELLS.has(programName(words[0]!)) || !SCRIPT_FLAG.test(flag) || !words.slice(1, -1).every((w) => SHELL_OPTION.test(w))) return s;
  const script = s.slice(end).trim();
  return script ? unquote(script) : s;
}

/** `["bash", "-lc", "ls"]` → `ls`; any other argv joined, quoting the words that need it. */
function argvLine(words: string[]): string {
  if (words.length >= 3 && SHELLS.has(programName(words[0]!))) {
    const flag = words.findIndex((w, i) => i > 0 && SCRIPT_FLAG.test(w));
    if (flag === words.length - 2 && words.slice(1, flag).every((w) => SHELL_OPTION.test(w))) return words[flag + 1]!;
  }
  return words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`)).join(" ");
}

/** "Running cat notes.md": a command step's status line ("Running a command" when it names none). */
export function commandLabel(command: string | undefined): string {
  const line = (command ?? "").replace(/\s+/g, " ").trim();
  return line ? `Running ${[...line].slice(0, 120).join("")}` : "Running a command";
}

/**
 * The command line a coding agent ran, as the person would read it: Claude
 * Code's and Gemini CLI's `command`, Codex's `command` (a string, or the argv
 * list older versions send), or a `cmd`, without the shell it was wrapped in
 * and with paths in the space shown as they are there. Undefined when the
 * input names no command.
 */
export function commandLine(input: unknown, base: string, granted: Granted): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  let line: string | undefined;
  for (const key of ["command", "cmd", "commandLine", "argv"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) line = withoutShell(v);
    else if (Array.isArray(v) && v.length && v.every((w) => typeof w === "string")) line = argvLine(v as string[]);
    if (line) break;
  }
  if (!line) return undefined;
  // Paths in the space, or in a granted folder, read as they do there.
  const shown = line.replace(/(^|[\s'"=(])(\/[^\s'"`;|&<>()]+)/g, (_, lead: string, p: string) => lead + shownPath(p, base, granted).shown);
  return commandText(shown) || undefined;
}

export function toolStartEvent(id: string, category: ToolCategory, input: unknown, base: string, granted: Granted): AgentEvent {
  let target: string | undefined;
  if (category === "command") {
    target = commandLine(input, base, granted);
  } else if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["file_path", "absolute_path", "dir_path", "path"]) {
      const v = o[key];
      if (typeof v === "string" && v) {
        target = shortText(shownPath(v, base, granted).shown);
        break;
      }
    }
  }
  const event: AgentEvent = { kind: "toolStart", id, category, label: GENERIC_LABEL[category] };
  if (target !== undefined) event.target = target;
  return event;
}

/** Pairs a CLI's tool starts and ends by id, once each. */
/** A tool's arguments in one short line, for a step that isn't a file or a command ("query: meeting · days: 30"). */
export function argsSummary(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return typeof input === "string" && input.trim() ? shortText(input) : undefined;
  const bits = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && typeof v !== "object")
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v)}`);
  return bits.length ? shortText(bits.join(" · ")) : undefined;
}

export class ToolEvents {
  #seen = new Set<string>();
  #finished = new Set<string>();
  #category = new Map<string, ToolCategory>();
  /** Phaethon's own tools by step id (their result is Phaethon's to show). */
  #phaethon = new Map<string, string>();
  #hidden = new Set<string>();
  #next = 0;

  constructor(
    private readonly cli: string,
    private readonly base: string,
    private readonly granted: Granted,
  ) {}

  start(raw: string, category: ToolCategory, input: unknown, label: string): AgentEvent[] {
    const short = raw ? shortText(raw) : `unpaired-${++this.#next}`;
    const id = `${this.cli}:${short}`;
    if (this.#seen.has(id)) return [];
    this.#seen.add(id);
    this.#category.set(id, category);
    return [{ kind: "tool", label }, toolStartEvent(id, category, input, this.base, this.granted)];
  }

  /**
   * A tool known by name (an MCP tool, a Codex dynamic tool): one of
   * Phaethon's shows what it was about and is left out when it has its own
   * line or card; another shows its name and arguments.
   */
  startNamed(raw: string, name: string, input: unknown): AgentEvent[] {
    const short = raw ? shortText(raw) : `unpaired-${++this.#next}`;
    const id = `${this.cli}:${short}`;
    if (this.#seen.has(id)) return [];
    this.#seen.add(id);
    const tool = phaethonTool(name);
    if (tool) {
      const shown = presentTool(tool, input);
      this.#phaethon.set(id, tool);
      if (shown.hidden) {
        this.#hidden.add(id);
        return [];
      }
      this.#category.set(id, shown.category);
      return [{ kind: "tool", label: shown.label }, { kind: "toolStart", id, category: shown.category, label: shown.label, ...(shown.target ? { target: shown.target } : {}) }];
    }
    this.#category.set(id, "other");
    const label = name ? `Using ${name}` : "Using a tool";
    const target = argsSummary(input);
    return [{ kind: "tool", label }, { kind: "toolStart", id, category: "other", label: shortText(label), ...(target ? { target } : {}) }];
  }

  end(raw: string, status: ToolStatus, detail?: string): AgentEvent[] {
    const id = `${this.cli}:${shortText(raw)}`;
    if (!this.#seen.has(id) || this.#finished.has(id)) return [];
    this.#finished.add(id);
    if (this.#hidden.has(id)) return [];
    const event: AgentEvent = { kind: "toolEnd", id, status };
    const tool = this.#phaethon.get(id);
    // A command's output, what one of Phaethon's tools found, or another tool's answer is shown; what a file tool read never is.
    const category = this.#category.get(id);
    if (detail !== undefined && tool) event.detail = toolResultDetail(tool, detail);
    else if (detail !== undefined && (category === "command" || category === "other" || detail === ERROR_NOTE)) event.detail = outputText(detail);
    else if (detail !== undefined && status === "failed") event.detail = ERROR_NOTE;
    return [event];
  }
}

type ToolRecord = Extract<Record_, { kind: "tool" }>;

/** Turns finished tools into conversation records (emitted right after their end) and closes unfinished ones truthfully. */
export class ToolLog {
  #active = new Map<string, { category: ToolCategory; label: string; target?: string }>();
  readonly records: ToolRecord[] = [];

  emit(event: AgentEvent, send: (e: AgentEvent) => void): void {
    let record: ToolRecord | undefined;
    if (event.kind === "toolStart") {
      if (!this.#active.has(event.id)) {
        const entry: { category: ToolCategory; label: string; target?: string } = { category: event.category, label: shortText(event.label) };
        if (event.target !== undefined) entry.target = event.category === "command" ? commandText(event.target) : shortText(event.target);
        this.#active.set(event.id, entry);
      }
    } else if (event.kind === "toolEnd") {
      const active = this.#active.get(event.id);
      if (active) {
        this.#active.delete(event.id);
        record = { kind: "tool", id: event.id, category: active.category, label: active.label, status: event.status };
        if (active.target !== undefined) record.target = active.target;
        if (event.detail !== undefined) record.detail = outputText(event.detail);
      }
    }
    send(event);
    if (record) {
      this.records.push(record);
      send({ kind: "record", record: { ...record } });
    }
  }

  close(status: ToolStatus, send: (e: AgentEvent) => void): void {
    for (const id of [...this.#active.keys()].sort()) this.emit({ kind: "toolEnd", id, status }, send);
  }
}
