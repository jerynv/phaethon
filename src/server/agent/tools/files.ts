import fs from "node:fs";
import path from "node:path";
import { Refusal } from "../../rpc/registry.ts";
import { cleanRel, resolveIn, resolveInOther } from "../../core/resolve.ts";
import { isWithin, realpath, writeFileAtomic } from "../../core/fsx.ts";
import { spaceDir } from "../../core/vault.ts";
import type { Block } from "../../core/thread.ts";
import { covers, grantsFor } from "../../grants/grants.ts";
import { filterCourseText, resolveCoursePath, visibleCourses } from "../../lms/access.ts";
import { renderPdfPage } from "../../lms/text/pages.ts";
import { listAttempts, loadAttempt } from "../../study/attempts.ts";
import { search as runSearch, type Root } from "./search.ts";

/**
 * The file tools: every path is checked lexically and then against the real
 * filesystem. `@<space>/…` reaches another space only through a grant (saved
 * grants are re-read for every call, so a revoke is immediate) and only for
 * reading. `courses/…` is the vault's imported courses this space may see.
 */

export const MAX_LIST = 500;
export const MAX_READ = 262_144;
export const PREVIEW_CAP = 512 * 1024;

export type ToolCtx = {
  space: string;
  root: string;
  /** "Allow once" grants for this turn only. */
  once: { from: string; path: string }[];
};

export type Target = { kind: "local"; rel: string } | { kind: "other"; space: string; rel: string };

/** `@<space>/<rest>` is another space (`@<this space>/x` is just `x`); a local name starting with "@" is `./@name`. */
export function target(space: string, p: string): Target {
  if (!p.startsWith("@")) return { kind: "local", rel: p };
  const rest = p.slice(1);
  const slash = rest.indexOf("/");
  const other = slash < 0 ? rest : rest.slice(0, slash);
  const rel = slash < 0 ? "" : rest.slice(slash + 1);
  if (other === space) return { kind: "local", rel };
  return { kind: "other", space: other, rel };
}

export function isCoursesPath(rel: string): boolean {
  const first = cleanRel(rel)[0];
  return first !== undefined && first.toLowerCase() === "courses";
}

export function resolveLocal(ctx: ToolCtx, rel: string, mustExist: boolean): { real: string; course: boolean } {
  if (isCoursesPath(rel)) return { real: resolveCoursePath(ctx.space, cleanRel(rel).join("/"), mustExist), course: true };
  return { real: resolveIn(ctx.root, rel, mustExist), course: false };
}

export type OtherPlace = { real: string; otherRoot: string; clean: string };

export function resolveOther(ctx: ToolCtx, other: string, rel: string): OtherPlace {
  let dir: string;
  try {
    dir = spaceDir(other);
  } catch {
    throw new Refusal(`there is no space called "${other}"`);
  }
  let parts: string[];
  try {
    parts = cleanRel(rel);
  } catch {
    throw new Refusal(`"@${other}/${rel}" must be a path inside the ${other} space, like "@${other}/notes/today.md"`);
  }
  const clean = parts.join("/");
  const grants = [...grantsFor(ctx.space).filter((g) => g.from === other).map((g) => g.path), ...ctx.once.filter((g) => g.from === other).map((g) => g.path)];
  const grant = grants.find((g) => covers(g, clean));
  if (!grant) throw new Refusal(`"@${other}/${rel}" is in the ${other} space; ask for access with request_access first`);
  let granted: string;
  try {
    granted = resolveIn(dir, grant, true);
  } catch {
    throw new Refusal(`the granted path "@${other}/${grant}" no longer exists`);
  }
  const real = resolveInOther(dir, other, clean, true);
  if (!isWithin(real, granted)) throw new Refusal(`"@${other}/${rel}" leads outside the part of the ${other} space you have access to`);
  return { real, otherRoot: realpath(dir), clean };
}

/** Is this (other space, path) covered by a current grant? */
export function isCovered(ctx: ToolCtx, other: string, clean: string): boolean {
  return [...grantsFor(ctx.space).filter((g) => g.from === other).map((g) => g.path), ...ctx.once.filter((g) => g.from === other).map((g) => g.path)].some((g) =>
    covers(g, clean),
  );
}

function listDir(real: string, rel: string): string[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch (e) {
    throw new Refusal(`cannot list "${rel}": ${(e as Error).message}`);
  }
  if (!st.isDirectory()) throw new Refusal(`"${rel}" is a file, not a folder`);
  let names: string[];
  try {
    names = fs.readdirSync(real);
  } catch (e) {
    throw new Refusal(`cannot list "${rel}": ${(e as Error).message}`);
  }
  return names
    .filter((n) => n !== ".phaethon")
    .map((n) => {
      try {
        return fs.statSync(path.join(real, n)).isDirectory() ? `${n}/` : n;
      } catch {
        return n;
      }
    });
}

function formatList(names: string[]): string {
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!names.length) return "(empty folder)";
  const shown = names.slice(0, MAX_LIST).join("\n");
  return names.length > MAX_LIST ? `${shown}\n… and ${names.length - MAX_LIST} more` : shown;
}

export function listFiles(ctx: ToolCtx, p: string): string {
  const t = target(ctx.space, p);
  if (t.kind === "other") {
    const place = resolveOther(ctx, t.space, t.rel);
    return formatList(listDir(place.real, p));
  }
  const parts = cleanRel(t.rel);
  if (!parts.length) {
    const names = listDir(resolveIn(ctx.root, "", true), t.rel).filter((n) => n.replace(/\/$/, "").toLowerCase() !== "courses");
    if (visibleCourses(ctx.space).length) names.push("courses/");
    return formatList(names);
  }
  if (parts[0].toLowerCase() === "courses") {
    if (parts.length === 1) return formatList(visibleCourses(ctx.space).map((c) => `${c.folder}/`));
    const rel = parts.join("/");
    const real = resolveCoursePath(ctx.space, rel, true);
    const names = listDir(real, t.rel).filter((n) => {
      try {
        resolveCoursePath(ctx.space, `${rel}/${n.replace(/\/$/, "")}`, true);
        return true;
      } catch {
        return false;
      }
    });
    return formatList(names);
  }
  return formatList(listDir(resolveIn(ctx.root, t.rel, true), t.rel));
}

function readText(real: string, rel: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch (e) {
    throw new Refusal(`cannot read "${rel}": ${(e as Error).message}`);
  }
  if (st.isDirectory()) throw new Refusal(`"${rel}" is a folder; use list_files`);
  if (st.size > MAX_READ) throw new Refusal(`"${rel}" is ${st.size} bytes, more than the ${MAX_READ}-byte limit`);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(real);
  } catch (e) {
    throw new Refusal(`cannot read "${rel}": ${(e as Error).message}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Refusal(`"${rel}" is not a text file`);
  }
}

export function readFile(ctx: ToolCtx, p: string): string {
  const t = target(ctx.space, p);
  if (t.kind === "other") return readText(resolveOther(ctx, t.space, t.rel).real, p);
  const { real, course } = resolveLocal(ctx, t.rel, true);
  const text = readText(real, t.rel);
  return course ? filterCourseText(ctx.space, cleanRel(t.rel).join("/"), text) : text;
}

export const PAGE_GATE_BLIND =
  "The selected model is not known to accept page images. Choose a model with image input; until then, use the OCR text and ask the user to clarify unreadable handwriting or equations. No page image was sent.";
export const PAGE_GATE_SIX = "Six PDF pages have been shown in this reply. Work from those pages or ask the user which page to inspect next.";
export const MAX_PAGES_PER_TURN = 6;

export async function readPage(ctx: ToolCtx, p: string, page: number): Promise<Block[]> {
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Refusal("page must be from 1 to 10000");
  const t = target(ctx.space, p);
  let real: string;
  if (t.kind === "other") real = resolveOther(ctx, t.space, t.rel).real;
  else {
    const parts = cleanRel(t.rel);
    if (parts.length === 1 && parts[0].toLowerCase() === "courses") throw new Refusal("Choose a PDF file, not the courses folder.");
    real = resolveLocal(ctx, t.rel, true).real;
  }
  if (!real.toLowerCase().endsWith(".pdf") || !fs.statSync(real).isFile()) throw new Refusal("read_page needs the original PDF file. Use read_file for its text copy.");
  let picture: { mime: string; data: string } | null;
  try {
    picture = await renderPdfPage(real, page);
  } catch (e) {
    throw new Refusal(`the page renderer crashed: ${(e as Error).message}`);
  }
  if (!picture) throw new Refusal(`Page ${page} of ${p} could not be rendered. Check the page number, or ask the user to attach a clear image of that page.`);
  return [
    {
      type: "text",
      text: `Source: ${p}, page ${page}. This is the original page image; inspect its handwriting, equations and diagrams directly and cite this path and page. If a symbol is unclear, ask instead of inventing it.`,
    },
    { type: "image", source: { type: "base64", media_type: picture.mime, data: picture.data } },
  ];
}

export function searchFiles(ctx: ToolCtx, query: string, p: string): string {
  const t = target(ctx.space, p);
  if (t.kind === "other") {
    const place = resolveOther(ctx, t.space, t.rel);
    const prefix = `@${t.space}/${place.clean ? `${place.clean}/` : ""}`;
    if (!fs.statSync(place.real).isDirectory()) throw new Refusal(`"${p}" is a file, not a folder`);
    return runSearch([{ dir: place.real, prefix }], query);
  }
  const parts = cleanRel(t.rel);
  const courseRoot = (folder: string): Root | undefined => {
    let dir: string;
    try {
      dir = resolveCoursePath(ctx.space, `courses/${folder}`, true);
    } catch {
      return undefined;
    }
    const base = `courses/${folder}/`;
    return {
      dir,
      prefix: base,
      allow: (rel) => {
        try {
          return resolveCoursePath(ctx.space, `${base}${rel}`, true);
        } catch {
          return undefined;
        }
      },
      filter: (rel, text) => filterCourseText(ctx.space, `${base}${rel}`, text),
    };
  };
  if (!parts.length) {
    // Whole space: the space's own files (its real courses folder hidden), then the visible courses.
    const roots: Root[] = [{ dir: resolveIn(ctx.root, "", true), prefix: "", skipRootCourses: true }];
    for (const c of visibleCourses(ctx.space)) {
      const r = courseRoot(c.folder);
      if (r) roots.push(r);
    }
    return runSearch(roots, query);
  }
  if (parts[0].toLowerCase() === "courses") {
    if (parts.length === 1) {
      return runSearch(visibleCourses(ctx.space).map((c) => courseRoot(c.folder)).filter((r): r is Root => !!r), query);
    }
    const folder = parts[1];
    const r = courseRoot(folder);
    if (!r) resolveCoursePath(ctx.space, parts.join("/"), true);
    const sub = parts.slice(2).join("/");
    if (!sub) return runSearch([r!], query);
    const dir = resolveCoursePath(ctx.space, parts.join("/"), true);
    return runSearch([{ ...r!, dir, prefix: `courses/${folder}/${sub}/`, allow: (rel) => r!.allow!(`${sub}/${rel}`), filter: (rel, text) => r!.filter!(`${sub}/${rel}`, text) }], query);
  }
  const real = resolveIn(ctx.root, t.rel, true);
  if (!fs.statSync(real).isDirectory()) throw new Refusal(`"${t.rel}" is a file, not a folder`);
  return runSearch([{ dir: real, prefix: `${parts.join("/")}/` }], query);
}

export type WritePlan = { real: string; rel: string; action: "create" | "replace"; before: string | null; summary: string; detail: string; truncated: boolean };

function cut(text: string, cap: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return { text, cut: false };
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), cut: true };
}

/** Rust's `str::lines().count()`: a trailing newline doesn't add a line. */
export function lineCount(text: string): number {
  if (!text) return 0;
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** Everything the approval card shows, checked before asking. */
export function describeWrite(ctx: ToolCtx, p: string, contents: string): WritePlan {
  if (p.startsWith("@") && target(ctx.space, p).kind === "other") throw new Refusal("write_file can only write in this space; other spaces can never be written");
  const rel0 = target(ctx.space, p).rel;
  if (isCoursesPath(rel0)) {
    throw new Refusal(`"${rel0}" is in courses/, the course site's copy, which can't be changed here (importing again would overwrite it); write notes elsewhere in this space, e.g. notes/`);
  }
  const parts = cleanRel(rel0);
  if (!parts.length) throw new Refusal("path must name a file");
  const real = resolveIn(ctx.root, rel0, false);
  const rel = parts.join("/");
  let action: "create" | "replace" = "create";
  let before: string | null = null;
  let beforeCut = false;
  const st = fs.lstatSync(real, { throwIfNoEntry: false });
  if (st?.isDirectory()) throw new Refusal(`"${p}" is a folder`);
  if (st?.isFile()) {
    action = "replace";
    try {
      const fd = fs.openSync(real, "r");
      const buf = Buffer.alloc(Math.min(st.size, PREVIEW_CAP + 1));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const c = cut(buf.subarray(0, n).toString("utf8"), PREVIEW_CAP);
      before = c.text;
      beforeCut = c.cut;
    } catch {
      before = "";
    }
  }
  const n = lineCount(contents);
  const lines = `${n} line${n === 1 ? "" : "s"}`;
  const detail = cut(contents, PREVIEW_CAP);
  return {
    real,
    rel,
    action,
    before,
    summary: action === "replace" ? `Replace the file ${rel} with new contents (${lines}).` : `Create a new file ${rel} (${lines}).`,
    detail: detail.text,
    truncated: detail.cut || beforeCut,
  };
}

/** Writes after approval, re-checking the path (it may have changed while the user decided). */
export function runWrite(ctx: ToolCtx, plan: WritePlan, contents: string): string {
  const real = resolveIn(ctx.root, plan.rel, false);
  try {
    fs.mkdirSync(path.dirname(real), { recursive: true });
  } catch (e) {
    throw new Refusal(`cannot create the folder for "${plan.rel}": ${(e as Error).message}`);
  }
  try {
    writeFileAtomic(real, contents, { tmp: path.join(path.dirname(real), `.${path.basename(real)}.phaethon-tmp`) });
  } catch (e) {
    throw new Refusal(`cannot write "${plan.rel}": ${(e as Error).message}`);
  }
  return `Wrote ${Buffer.byteLength(contents, "utf8")} bytes to ${plan.rel}.`;
}

export function studyAttempt(ctx: ToolCtx, p: string): string {
  if (!p) {
    const list = [...listAttempts(ctx.space)].sort((a, b) => b.taken - a.taken).slice(0, 100);
    return JSON.stringify(list.map((a) => ({ path: a.path, quiz: a.quiz, taken: a.taken, score: a.score })));
  }
  return JSON.stringify(loadAttempt(ctx.space, p));
}
