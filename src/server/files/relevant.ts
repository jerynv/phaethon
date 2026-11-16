import fs from "node:fs";
import path from "node:path";
import { lstatOrNull } from "../core/fsx.ts";
import { resolveIn } from "../core/resolve.ts";
import { ATTACHMENT_TYPE, LEGACY_ATTACHMENT_TYPE, RECORD_TYPE, isValidThreadId, parseThread, readThreadText, threadsDirIn, type Message } from "../core/thread.ts";

/**
 * "Relevant" for the Files view: the space's files an agent recently read or
 * wrote, and files attached to messages, taken from the conversations that
 * changed last (at most 12, each at most 8 MiB, so it stays a few
 * milliseconds). Phaethon's own reads and writes are its tool calls and
 * approval records; the coding agents' are their tool records. Only files
 * that are still in the space are returned, newest first.
 */

export type Touched = { path: string; how: "read" | "wrote" | "attached"; at: number; size: number; modified: number };

const THREADS = 12;
const THREAD_MAX = 8 * 1024 * 1024;
const RESULTS = 24;
const OWN_READS = new Set(["read_file", "read_page"]);

function threadFiles(dir: string): { file: string; mtime: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(threadsDirIn(dir));
  } catch {
    return [];
  }
  const out: { file: string; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".json") || !isValidThreadId(n.slice(0, -5))) continue;
    const file = path.join(threadsDirIn(dir), n);
    const st = lstatOrNull(file);
    if (st?.isFile() && st.size <= THREAD_MAX) out.push({ file, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, THREADS);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Every file a conversation's messages name as read, written or attached, with the message's time. */
export function touchedIn(msgs: Message[], fallback: number): { path: string; how: Touched["how"]; at: number }[] {
  const out: { path: string; how: Touched["how"]; at: number }[] = [];
  for (const m of msgs) {
    const at = typeof m.at === "number" ? m.at : fallback;
    for (const b of m.content) {
      if (b.type === "tool_use" && OWN_READS.has(String(b.name))) {
        const p = str((b.input as { path?: unknown } | undefined)?.path);
        if (p && !p.startsWith("@")) out.push({ path: p, how: "read", at });
      } else if (b.type === RECORD_TYPE) {
        if (b.kind === "approval" && b.allowed === true) {
          const p = str(b.path);
          if (p) out.push({ path: p, how: "wrote", at });
        } else if (b.kind === "tool" && (b.category === "read" || b.category === "write") && b.status !== "failed") {
          const p = str(b.target);
          if (p && !/\s/.test(p) && !p.startsWith("@")) out.push({ path: p, how: b.category === "write" ? "wrote" : "read", at });
        }
      } else if (b.type === ATTACHMENT_TYPE || b.type === LEGACY_ATTACHMENT_TYPE) {
        const p = str(b.path);
        if (p) out.push({ path: p, how: "attached", at });
      }
    }
  }
  return out;
}

export function relevantFiles(spaceRoot: string): Touched[] {
  const best = new Map<string, { how: Touched["how"]; at: number }>();
  for (const { file, mtime } of threadFiles(spaceRoot)) {
    let msgs: Message[];
    try {
      const text = readThreadText(file);
      if (!text) continue;
      msgs = parseThread(text);
    } catch {
      continue;
    }
    for (const t of touchedIn(msgs, mtime)) {
      const key = t.path.replace(/^\.\//, "");
      const had = best.get(key);
      if (!had || t.at > had.at) best.set(key, { how: t.how, at: t.at });
    }
  }
  const out: Touched[] = [];
  for (const [p, t] of [...best.entries()].sort((a, b) => b[1].at - a[1].at)) {
    if (out.length >= RESULTS) break;
    let real: string;
    try {
      real = resolveIn(spaceRoot, p, true);
    } catch {
      continue;
    }
    const st = lstatOrNull(real);
    if (!st?.isFile()) continue;
    const clean = p.split(/[/\\]+/).filter((c) => c && c !== ".").join("/");
    if (out.some((o) => o.path === clean)) continue;
    out.push({ path: clean, how: t.how, at: t.at, size: st.size, modified: st.mtimeMs });
  }
  return out;
}
