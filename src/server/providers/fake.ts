import fs from "node:fs";
import type { Block } from "../core/thread.ts";
import { sleep } from "./http.ts";
import { ProviderError, type Delta, type ErrorKind, type ModelRequest, type ModelTurn, type Provider, type Sees } from "./types.ts";

/**
 * A scripted provider for end-to-end UI tests. It exists only when the
 * environment variable PHAETHON_FAKE_PROVIDER names a script file; then every
 * space's own-agent turn uses it instead of a real provider (no key, no
 * network). Nothing in settings can select it.
 *
 * Script format (JSON):
 *
 *   {
 *     "model": "fake-model",          // optional, shown as the model id
 *     "claude": true,                 // optional: behave as a Claude model (adds send_to_user)
 *     "sees": "yes",                  // optional: "yes" | "no" | "unknown" (read_page gate)
 *     "repeatLast": false,            // optional: keep answering with the last step when the script runs out
 *     "steps": [                      // one entry per model call, consumed in order across the process
 *       {
 *         "progress": ["Looking at your notes."],      // optional: notes shown between tool calls
 *         "text": "Here is the plan.",                  // optional: streamed word by word
 *         "tools": [                                    // optional: tool calls, run by the real loop
 *           {"name": "write_file", "input": {"path": "a.md", "contents": "x"}, "id": "toolu_1"},
 *           {"name": "check", "input": {"role": "check", "question": "…", "options": [...], "explanation": "…", "correctAnswer": "b"}}
 *         ],
 *         "stop": "end_turn",                          // optional; defaults to "tool_use" when tools are given
 *         "error": {"kind": "rateLimit", "message": "…", "retryAfter": 5},  // optional: fail this call instead
 *         "delayMs": 0                                  // optional: wait before streaming
 *       }
 *     ]
 *   }
 *
 * Each request the loop sends is appended to `<script>.requests.jsonl`
 * (system prompt, message count, tool names, effort) so tests can assert on it.
 */

type Step = {
  progress?: string[];
  text?: string;
  tools?: { name: string; input?: unknown; id?: string }[];
  stop?: string;
  error?: { kind: ErrorKind; message: string; retryAfter?: number };
  delayMs?: number;
};
type Script = { model?: string; claude?: boolean; sees?: Sees; repeatLast?: boolean; steps: Step[] };

const cursors = new Map<string, number>();

export function fakeScriptPath(): string | undefined {
  return process.env.PHAETHON_FAKE_PROVIDER || undefined;
}

function readScript(file: string): Script {
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!v || !Array.isArray(v.steps)) throw new Error("The fake provider script needs a steps array.");
  return v as Script;
}

/** Tests: start the script over. */
export function resetFake(file?: string): void {
  if (file) cursors.delete(file);
  else cursors.clear();
}

export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly model: string;
  readonly isClaude: boolean;
  readonly #sees: Sees;
  constructor(private readonly file: string) {
    const s = readScript(file);
    this.model = s.model ?? "fake-model";
    this.isClaude = s.claude === true;
    this.#sees = s.sees ?? "yes";
  }

  imageInput(): Sees {
    return this.#sees;
  }

  async turn(req: ModelRequest, onDelta: (d: Delta) => void, signal: AbortSignal): Promise<ModelTurn> {
    const script = readScript(this.file);
    try {
      fs.appendFileSync(
        `${this.file}.requests.jsonl`,
        JSON.stringify({ system: `${req.system.stable}\n\n${req.system.volatile}`, messages: req.messages.length, tools: req.tools.map((t) => t.name), effort: req.effort, last: req.messages[req.messages.length - 1] }) + "\n",
      );
    } catch {
      // logging is best effort
    }
    let i = cursors.get(this.file) ?? 0;
    if (i >= script.steps.length) {
      if (!script.repeatLast || !script.steps.length) throw new ProviderError("unavailable", "The fake provider's script has no more steps.");
      i = script.steps.length - 1;
    }
    cursors.set(this.file, i + 1);
    const step = script.steps[i];
    if (step.delayMs) await sleep(step.delayMs, signal);
    if (step.error) throw new ProviderError(step.error.kind, step.error.message, step.error.retryAfter);
    const content: Block[] = [];
    for (const note of step.progress ?? []) {
      content.push({ type: "thinking", thinking: note, signature: "fake" });
      onDelta({ type: "progress", text: note });
    }
    if (step.text) {
      onDelta({ type: "textStart" });
      for (const piece of step.text.match(/\S+\s*|\s+/g) ?? []) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        onDelta({ type: "text", text: piece });
        await sleep(0, signal);
      }
      content.push({ type: "text", text: step.text });
    }
    (step.tools ?? []).forEach((t, n) => content.push({ type: "tool_use", id: t.id ?? `toolu_fake_${i}_${n}`, name: t.name, input: t.input ?? {} }));
    return { content, stopReason: step.stop ?? (step.tools?.length ? "tool_use" : "end_turn"), invalidInputs: [] };
  }
}
