#!/usr/bin/env node
// Design rules no reviewer should have to catch by eye. Fails the build when
// source code (src/ by default, or the paths given) breaks one:
//   1. colours are oklch()/oklab() only: no hex, rgb(), hsl()
//   2. no lucide-react: Phaethon draws its own icons (src/icons)
//   3. no raw Tailwind palette colours (text-red-500 ...): use token colours
//   4. no hard-coded px/rem sizes in class names (w-[12px] ...): use a token,
//      e.g. w-(--ph-sidebar-width)
// A line can opt out with `design-check-ignore: <reason>`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["src"];
const exts = new Set([".ts", ".tsx", ".css", ".js", ".jsx", ".html"]);
const palette =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const rules = [
  { name: "hex colour", re: /(?<![\w&])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b(?![\w-])/ },
  { name: "rgb()/hsl() colour", re: /\b(?:rgba?|hsla?)\(/ },
  { name: "lucide-react import", re: /from\s+["']lucide-react["']/ },
  { name: "raw Tailwind palette colour", re: new RegExp(`(?<![\\w-])(?:[a-z]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|placeholder|caret|accent|shadow)-(?:${palette})-\\d{2,3}(?:/\\d+)?\\b|(?<![\\w-])(?:bg|text|border|fill|stroke)-(?:white|black)\\b`) },
  { name: "hard-coded size in a class", re: /(?<![\w-])[a-z-]+-\[-?\d+(?:\.\d+)?(?:px|rem|em)\]/ },
  // UI copy uses the typographic apostrophe (don’t, Phaethon’s); .ts/.tsx, comments skipped.
  { name: "straight apostrophe in UI copy", re: /\b[A-Za-z]+'(?:t|s|re|ll|ve|d|m)\b/, only: /\.tsx?$/, skipComments: true },
];

const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) if (f !== "node_modules") walk(join(p, f));
  } else if (exts.has(extname(p))) files.push(p);
};
roots.forEach(walk);

const problems = [];
for (const f of files) {
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.includes("design-check-ignore")) return;
      const isComment = /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line);
      for (const r of rules) {
        if (r.only && !r.only.test(f)) continue;
        if (r.skipComments && isComment) continue;
        if (r.re.test(line)) problems.push(`${f}:${i + 1}: ${r.name}: ${line.trim().slice(0, 140)}`);
      }
    });
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\ncheck-design: ${problems.length} problem(s) in ${files.length} files.`);
  process.exit(1);
}
console.log(`check-design: ${files.length} files clean.`);
