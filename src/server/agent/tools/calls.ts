import path from "node:path";
import type { ToolCategory } from "../../../shared/agent.ts";
import { target } from "./files.ts";

/**
 * Input checks and display labels for tool calls. Error texts are wrapped as
 * "Not run: {message}." by the loop; labels are the status lines the UI shows.
 */

const ALLOWED: Record<string, string[]> = {
  list_files: ["path"],
  read_file: ["path"],
  read_page: ["path", "page"],
  search_files: ["query", "path"],
  write_file: ["path", "contents"],
  request_access: ["space", "path", "reason"],
  app_guide: [],
  study_attempt: ["path"],
  send_to_user: ["message"],
};
const REQUIRED: Record<string, string[]> = {
  read_file: ["path"],
  read_page: ["path"],
  search_files: ["query"],
  write_file: ["path", "contents"],
  request_access: ["space", "path", "reason"],
  send_to_user: ["message"],
};
export const MAX_REASON = 500;

export type Call = { name: string; input: Record<string, unknown> };

/** Validates a base tool's input; lesson tools are checked against their schema instead. Returns the cleaned input or an error message. */
export function parseCall(name: string, input: unknown): { ok: true; call: Call } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "input must be a JSON object" };
  const allowed = ALLOWED[name];
  if (!allowed) return { ok: false, error: `there is no tool named ${name}` };
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return { ok: false, error: `unexpected field "${k}"` };
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k === "page") continue;
    const v = obj[k];
    const required = REQUIRED[name]?.includes(k);
    if (v === undefined || v === null) {
      if (required) return { ok: false, error: `"${k}" is required and must be a string` };
      out[k] = "";
      continue;
    }
    if (typeof v !== "string") return { ok: false, error: required ? `"${k}" is required and must be a string` : `"${k}" must be a string` };
    out[k] = v;
  }
  if (name === "read_page") {
    const page = obj.page;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 10000) return { ok: false, error: "page must be a whole number from 1 to 10000" };
    out.page = page;
  }
  if (name === "write_file" && String(out.path).startsWith("@")) {
    const p = String(out.path);
    const rest = p.slice(1);
    const other = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
    return { ok: false, error: `write_file can only write in this space; "${p}" is in the ${other} space, and other spaces can never be written` };
  }
  if (name === "request_access") out.reason = [...String(out.reason)].slice(0, MAX_REASON).join("");
  return { ok: true, call: { name, input: out } };
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** The status line for a call (sent as a `tool` event). */
export function label(space: string, call: Call): string {
  const i = call.input;
  const p = String(i.path ?? "");
  const t = target(space, p);
  const other = t.kind === "other" ? (t.rel ? `${t.space}/${trimSlash(t.rel)}` : t.space) : "";
  switch (call.name) {
    case "list_files":
      return t.kind === "other" ? `Listing ${other}` : p ? `Listing ${p}` : "Listing the space";
    case "read_file":
      return t.kind === "other" ? `Reading ${other}` : `Reading file ${p}`;
    case "read_page":
      return `Reading page ${i.page} of ${p}`;
    case "search_files":
      return t.kind === "other" ? `Searching ${other} for “${i.query}”` : `Searching files for “${i.query}”`;
    case "write_file":
      return `Writing file ${p}`;
    case "request_access":
      return `Asking for read access to ${String(i.space).replace(/^@/, "")}/${trimSlash(p)}`;
    case "app_guide":
      return "Looking up where things are in Phaethon";
    case "study_attempt":
      return p ? "Reading a completed quiz" : "Finding completed quizzes";
    case "plan_lesson":
      return "Planning the lesson";
    case "check":
      return "Asking a question";
    case "explain_back":
      return "Asking you to explain";
    default:
      return "Using tool";
  }
}

/** Category and short label for the activity row (`toolStart`). */
export function activity(name: string): { category: ToolCategory; label: string } {
  switch (name) {
    case "read_file":
    case "read_page":
      return { category: "read", label: "Reading file" };
    case "list_files":
      return { category: "list", label: "Listing files" };
    case "search_files":
      return { category: "search", label: "Searching" };
    case "write_file":
      return { category: "write", label: "Changing file" };
    case "plan_lesson":
      return { category: "other", label: "Planning the lesson" };
    case "check":
      return { category: "other", label: "Asking a question" };
    case "explain_back":
      return { category: "other", label: "Asking you to explain" };
    default:
      return { category: "other", label: "Using tool" };
  }
}

const MAX_SHOWN = 240;

export function clip(s: string): string {
  return [...s].slice(0, MAX_SHOWN).join("");
}

/** The activity row's target: the first path-like input, relative to the space when it is inside it. */
export function activityTarget(input: unknown, spaceRoot: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const k of ["file_path", "absolute_path", "dir_path", "path"]) {
    const v = obj[k];
    if (typeof v !== "string" || !v) continue;
    let shown = v;
    if (path.isAbsolute(v)) {
      const rel = path.relative(spaceRoot, v);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) shown = rel || ".";
    }
    // eslint-disable-next-line no-control-regex
    return clip(shown.replace(/[\u0000-\u001f\u007f]/g, ""));
  }
  return undefined;
}
