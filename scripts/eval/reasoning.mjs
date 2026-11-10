// Blind before/after check of how Phaethon explains things. It answers each
// question in questions.txt twice through the Claude Code CLI you are signed
// in to (one system prompt per side), then asks a second model to grade the
// pairs, shuffled, on correctness, reasoning, teaching and concision.
//
//   node scripts/eval/reasoning.mjs <promptA.txt> <promptB.txt> [model] [judgeModel]
//
// It uses your own Claude subscription or key (a few short calls); it never
// runs in CI. Dump Phaethon's current prompt with `node scripts/eval/dump-prompt.mjs`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [a, b, model = "sonnet", judge = "opus"] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node scripts/eval/reasoning.mjs <promptA.txt> <promptB.txt> [model] [judgeModel]");
  process.exit(2);
}
const here = import.meta.dirname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-eval-"));
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("CLAUDECODE") || k.startsWith("CLAUDE_CODE_")) delete env[k];
const ask = (system, prompt, m) =>
  execFileSync("claude", ["-p", "--model", m, "--system-prompt", system, "--tools", "", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"], {
    input: prompt,
    cwd: work,
    env,
    encoding: "utf8",
    timeout: 300_000,
  });

const questions = fs.readFileSync(path.join(here, "questions.txt"), "utf8").trim().split("\n");
const sides = { A: fs.readFileSync(a, "utf8"), B: fs.readFileSync(b, "utf8") };
let grading = `Grade tutor answers for a university student. For each question, grade both answers 1-10 on correctness, reasoning (derives the result from stated premises, each step justified), teaching (the student learns why and can apply it) and concision (no padding). Reply with JSON only: [{"q":n,"X":{...},"Y":{...},"better":"X"|"Y"}].\n\n`;
const order = [];
questions.forEach((q, i) => {
  const flip = Math.random() < 0.5;
  order.push(flip);
  const first = ask(flip ? sides.B : sides.A, q, model);
  const second = ask(flip ? sides.A : sides.B, q, model);
  grading += `## Question ${i + 1}: ${q}\n\n### Answer X\n${first}\n\n### Answer Y\n${second}\n\n`;
});
const verdict = JSON.parse(ask("You are a careful, strict grader. Output only JSON.", grading, judge).replace(/^```json\s*|```\s*$/g, ""));
const tally = { A: 0, B: 0 };
const reasoning = { A: [], B: [] };
verdict.forEach((v, i) => {
  const flip = order[i];
  const side = (label) => (label === "X" ? (flip ? "B" : "A") : flip ? "A" : "B");
  tally[side(v.better)]++;
  reasoning[side("X")].push(v.X.reasoning);
  reasoning[side("Y")].push(v.Y.reasoning);
});
const avg = (xs) => (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2);
console.log(`Better answer: A ${tally.A}, B ${tally.B} (of ${questions.length})`);
console.log(`Mean reasoning score: A ${avg(reasoning.A)}, B ${avg(reasoning.B)}`);
fs.rmSync(work, { recursive: true, force: true });
