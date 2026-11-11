// Prints the stable part of Phaethon's own-agent system prompt (what every space shares), for scripts/eval/reasoning.mjs.
//   node scripts/eval/dump-prompt.mjs [tutor mode]   (quiz, explain, socratic or cram adds that mode's section)
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(import.meta.dirname, "../..");
const mode = JSON.stringify(process.argv[2] ?? "normal");
const out = await build({
  stdin: {
    contents: `import { stablePrompt } from "./src/server/agent/prompt.ts"; import { tutorSection } from "./src/server/agent/tutor.ts";
process.stdout.write([stablePrompt(false), tutorSection(${mode})].filter(Boolean).join("\\n\\n"));`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, packages: "external",
  alias: { "#shared": path.join(root, "src/shared") }, loader: { ".md": "text" },
});
// A real file, not a data: URL: bundled modules call fileURLToPath(import.meta.url).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-prompt-"));
const file = path.join(dir, "dump.mjs");
fs.writeFileSync(file, out.outputFiles[0].text);
try {
  await import(pathToFileURL(file).href);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
