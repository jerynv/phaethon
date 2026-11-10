import path from "node:path";
import type { AgentEvent, ToolCategory, ToolStatus } from "../../shared/agent.ts";
import { isWithin } from "../core/fsx.ts";
import type { Record_ } from "../core/thread.ts";

/**
 * What a CLI's tool use becomes in Phaethon: a status line, a start/end pair
 * and, once finished, a record in the conversation. Only the tool's category,
 * a generic label, a shown path and its status are ever kept; never command
 * arguments or tool output.
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
      const rel = path.relative(g.path, p);
      return { shown: rel ? `${g.label}/${rel}` : g.label, inGrant: true };
    }
  }
  if (path.isAbsolute(p) && isWithin(p, base)) {
    const rel = path.relative(base, p);
    return { shown: rel || ".", inGrant: false };
  }
  return { shown: p, inGrant: false };
}

/** "Reading file notes.md", or "Reading work/calendar/oct.md" in another space's granted folder. */
export function place(verb: string, p: string, base: string, granted: Granted): string {
  const { shown, inGrant } = shownPath(p, base, granted);
  return inGrant ? `${verb} ${shown}` : `${verb} file ${shown}`;
}

export function toolStartEvent(id: string, category: ToolCategory, input: unknown, base: string, granted: Granted): AgentEvent {
  let target: string | undefined;
  if (category !== "command" && input && typeof input === "object") {
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
export class ToolEvents {
  #seen = new Set<string>();
  #finished = new Set<string>();
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
    return [{ kind: "tool", label }, toolStartEvent(id, category, input, this.base, this.granted)];
  }

  end(raw: string, status: ToolStatus, detail?: string): AgentEvent[] {
    const id = `${this.cli}:${shortText(raw)}`;
    if (!this.#seen.has(id) || this.#finished.has(id)) return [];
    this.#finished.add(id);
    const event: AgentEvent = { kind: "toolEnd", id, status };
    if (detail !== undefined) event.detail = shortText(detail);
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
        if (event.target !== undefined) entry.target = shortText(event.target);
        this.#active.set(event.id, entry);
      }
    } else if (event.kind === "toolEnd") {
      const active = this.#active.get(event.id);
      if (active) {
        this.#active.delete(event.id);
        record = { kind: "tool", id: event.id, category: active.category, label: active.label, status: event.status };
        if (active.target !== undefined) record.target = active.target;
        if (event.detail !== undefined) record.detail = shortText(event.detail);
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
