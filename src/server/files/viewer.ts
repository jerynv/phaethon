import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import * as courseAccess from "../lms/access.ts";
import { coursesParts, extOf, target } from "./open.ts";

/**
 * Reading a file for the in-app viewer, behind the same walls as opening one:
 * only inside the space, or a visible `courses/...` path. Text comes back as
 * text (at most 1 MiB); supported documents and media come back as bytes (at
 * most 40 MiB); anything else is named so the viewer can offer its app.
 */

export const MAX_TEXT = 1024 * 1024;
export const MAX_BYTES = 40 * 1024 * 1024;

export type ViewKind = "markdown" | "tex" | "text" | "pdf" | "image" | "docx" | "spreadsheet" | "slides" | "audio" | "video" | "other";
export type FileView = {
  path: string;
  name: string;
  kind: ViewKind;
  size: number;
  mediaType: string;
  text: string | null;
  language: string | null;
  tooBig: boolean;
};

const BINARY = new Set<ViewKind>(["pdf", "image", "docx", "spreadsheet", "slides", "audio", "video"]);

const TEXT_EXT = new Set(
  (
    "txt text log csv tsv json jsonl yaml yml toml ini cfg conf xml html htm css scss js mjs cjs ts tsx jsx py rb rs go java kt swift c h cpp hpp cc cs php sh " +
    "bash zsh fish sql r m jl lua pl hs ml scala dart vue svelte bib sty cls rst adoc org diff patch env gitignore mermaid mmd dot tikz"
  ).split(" "),
);

const BY_EXT: Record<string, [ViewKind, string]> = {
  md: ["markdown", "text/markdown"],
  markdown: ["markdown", "text/markdown"],
  mdown: ["markdown", "text/markdown"],
  tex: ["tex", "text/x-tex"],
  latex: ["tex", "text/x-tex"],
  ltx: ["tex", "text/x-tex"],
  pdf: ["pdf", "application/pdf"],
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  bmp: ["image", "image/bmp"],
  // Shown in an <img>, where an SVG's scripts never run.
  svg: ["image", "image/svg+xml"],
  docx: ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  pptx: ["slides", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  mp3: ["audio", "audio/mpeg"],
  m4a: ["audio", "audio/mp4"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  oga: ["audio", "audio/ogg"],
  opus: ["audio", "audio/ogg; codecs=opus"],
  flac: ["audio", "audio/flac"],
  aac: ["audio", "audio/aac"],
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  ogv: ["video", "video/ogg"],
  mov: ["video", "video/quicktime"],
};

export function kindOf(real: string): [ViewKind, string] {
  const e = extOf(real);
  if (Object.hasOwn(BY_EXT, e)) return BY_EXT[e]!;
  if (TEXT_EXT.has(e)) return ["text", "text/plain"];
  return ["other", "application/octet-stream"];
}

const LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  kt: "kotlin",
  cs: "csharp",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  diff: "diff",
  patch: "diff",
  json: "json",
  jsonl: "json",
};
const SAME = new Set(["c", "cpp", "css", "go", "java", "jsx", "tsx", "sql", "swift", "toml", "yaml"]);

function languageOf(real: string): string | null {
  const e = extOf(real);
  if (Object.hasOwn(LANG, e)) return LANG[e]!;
  return SAME.has(e) ? e : null;
}

/** A course file's text as this space may see it, when the course layer offers a filter. */
function filterCourseText(space: string, rel: string, text: string): string {
  const f = (courseAccess as Record<string, unknown>).filterCourseText;
  return typeof f === "function" ? (f as (s: string, r: string, t: string) => string)(space, rel, text) : text;
}

function locate(spaceId: string, spaceRoot: string, p: string): { real: string; course?: string } {
  const trimmed = p.trim();
  const course = coursesParts(trimmed);
  if (course) {
    const folder = () => new Refusal(`“${trimmed}” is a folder; the viewer shows files.`);
    if (course.length < 2) throw folder();
    let real: string;
    try {
      real = courseAccess.resolveCoursePath(spaceId, course.join("/"), true);
    } catch {
      throw new Refusal(`“${trimmed}” isn’t among the courses this space can see.`);
    }
    if (course.length < 3) throw folder();
    return { real, course: course.join("/") };
  }
  return { real: target(spaceId, spaceRoot, trimmed) };
}

function statFile(real: string, shown: string): fs.Stats {
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    throw new Refusal(`“${shown}” isn’t there any more.`);
  }
  if (!st.isFile()) throw new Refusal(`“${shown}” is a folder; the viewer shows files.`);
  return st;
}

export function viewFile(spaceId: string, spaceRoot: string, p: string): FileView {
  const shown = p.trim();
  const { real, course } = locate(spaceId, spaceRoot, p);
  const st = statFile(real, shown);
  let [kind, media] = kindOf(real);
  const view: FileView = { path: shown, name: path.basename(real), kind, size: st.size, mediaType: media, text: null, language: null, tooBig: false };
  if (BINARY.has(kind)) {
    view.tooBig = st.size > MAX_BYTES;
    return view;
  }
  if (st.size > MAX_TEXT) {
    view.tooBig = kind !== "other";
    return view;
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(real);
  } catch (e) {
    throw new Refusal(`“${shown}” couldn’t be read: ${messageOf(e)}`);
  }
  let text: string | undefined;
  if (!bytes.includes(0)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = undefined;
    }
  }
  if (text === undefined) {
    kind = "other";
    media = "application/octet-stream";
    view.kind = kind;
    view.mediaType = media;
    return view;
  }
  // A file with no known extension is shown as text when it is text.
  if (kind === "other") {
    view.kind = "text";
    view.mediaType = "text/plain";
  }
  view.language = languageOf(real);
  view.text = course ? filterCourseText(spaceId, course, text) : text;
  return view;
}

/** An allowlisted binary input's bytes, after the same walls. */
export function fileBytes(spaceId: string, spaceRoot: string, p: string): Buffer {
  const shown = p.trim();
  const { real } = locate(spaceId, spaceRoot, p);
  const [kind] = kindOf(real);
  if (!BINARY.has(kind)) throw new Refusal("This file type is not a binary preview input.");
  const st = statFile(real, shown);
  if (st.size > MAX_BYTES) {
    throw new Refusal(`“${shown}” is larger than the viewer shows (${MAX_BYTES / 1024 / 1024} MB at most). Open it in its app instead.`);
  }
  try {
    return fs.readFileSync(real);
  } catch (e) {
    throw new Refusal(`“${shown}” couldn’t be read: ${messageOf(e)}`);
  }
}
