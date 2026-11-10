// Prints the stable part of Phaethon's own-agent system prompt (what every space shares), for scripts/eval/reasoning.mjs.
import { build } from "esbuild";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const out = await build({
  stdin: { contents: 'import { stablePrompt } from "./src/server/agent/prompt.ts"; process.stdout.write(stablePrompt(false));', resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", format: "esm", write: false, packages: "external",
  alias: { "#shared": path.join(root, "src/shared") }, loader: { ".md": "text" },
});
await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
