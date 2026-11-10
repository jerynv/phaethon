import type { CheckQuestion, LessonAnswer } from "../../shared/agent.ts";
import { Refusal } from "../rpc/registry.ts";
import { records, type Block, type Message } from "../core/thread.ts";
import { healInput } from "./heal.ts";
import { toolNamed } from "./tools/definitions.ts";

/**
 * Lesson tools: a validated prerequisite map (`plan_lesson`), graded
 * multiple-choice questions (`check`) and free recall (`explain_back`). Both
 * question tools end the turn; the student's answer comes back as the tool
 * result and a new turn continues. Every validation error says how to fix it.
 */

export type PlanNode = { id: string; label: string };
export type ParsedMap = { nodes: PlanNode[]; edges: [string, string][] };

const NODE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEADER = /^(?:graph|flowchart)\s+(?:TD|TB|LR|RL|BT)\s*;?$/;
const ARROW = /\s*(?:-->|==>|-\.->|---|--)(?:\s*\|[^|]*\|)?\s*/;
const IGNORED = /^(?:%%|classDef\s|class\s|style\s|linkStyle\s|subgraph\b|end$)/;
export const MAX_PLAN_NODES = 60;

function parseNode(token: string): PlanNode {
  const m = /^([A-Za-z0-9_-]+)\s*(?:\[\(?|\(\[?|\{\{?|\[\[|\(\()?\s*(.*?)\s*(?:\)?\]|\]?\)|\}\}?|\]\]|\)\))?$/.exec(token.trim());
  if (!m) throw new Refusal(`"${token.trim()}" isn't a node. Write a node as id[Label], like limits[Limits].`);
  const id = m[1];
  if (!NODE_ID.test(id)) {
    throw new Refusal(`The node id "${id}" can't be used. Node ids are lowercase letters and digits joined by hyphens, like "chain-rule".`);
  }
  const label = m[2].replace(/^"|"$/g, "").trim();
  return { id, label: label || id };
}

/** Parses and checks a prerequisite map. Throws a Refusal saying what to fix. */
export function parseMap(text: string): ParsedMap {
  const lines = text
    .replace(/^```(?:mermaid)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || !HEADER.test(lines[0])) throw new Refusal('The map must start with the line "graph TD", then one edge per line, like "limits[Limits] --> derivative[The derivative]".');
  const nodes = new Map<string, PlanNode>();
  const edges: [string, string][] = [];
  const add = (n: PlanNode) => {
    const known = nodes.get(n.id);
    if (!known) nodes.set(n.id, n);
    else if (known.label === known.id && n.label !== n.id) known.label = n.label;
    return n.id;
  };
  for (const line of lines.slice(1)) {
    if (IGNORED.test(line)) continue;
    const parts = line.replace(/;$/, "").split(ARROW).filter((p) => p.trim());
    const ids = parts.map((p) => add(parseNode(p)));
    for (let i = 0; i + 1 < ids.length; i++) {
      if (ids[i] === ids[i + 1]) throw new Refusal(`"${ids[i]}" points to itself. Remove that edge.`);
      edges.push([ids[i], ids[i + 1]]);
    }
  }
  if (!nodes.size) throw new Refusal("The map has no nodes. Add one edge per line, like \"limits[Limits] --> derivative[The derivative]\".");
  if (nodes.size > MAX_PLAN_NODES) throw new Refusal(`The map has ${nodes.size} nodes; keep it to ${MAX_PLAN_NODES} or fewer by merging small steps.`);
  // Kahn's algorithm: whatever is left over sits on a cycle.
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const [, to] of edges) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const [from, to] of edges) {
      if (from !== id) continue;
      const d = indegree.get(to)! - 1;
      indegree.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  if (seen < nodes.size) {
    const stuck = [...indegree].filter(([, d]) => d > 0).map(([id]) => id);
    throw new Refusal(`The map has a cycle through ${stuck.slice(0, 5).join(", ")}. A prerequisite can't depend on what it leads to; remove one of those edges.`);
  }
  return { nodes: [...nodes.values()], edges };
}

/** The latest lesson plan in the conversation, if any. */
export function currentPlan(msgs: Message[]): { id: string; nodes: PlanNode[] } | undefined {
  const plans = records(msgs).filter((r) => r.kind === "lessonPlan");
  const last = plans[plans.length - 1];
  return last && last.kind === "lessonPlan" ? { id: last.id, nodes: last.nodes } : undefined;
}

export type PlanInput = { goal: string; strands: { strand: string; known: string }[]; premises: string[]; map: string };

export function validatePlan(input: PlanInput): ParsedMap {
  if (!input.goal.trim()) throw new Refusal('"goal" is empty. State in one sentence what the user will understand at the end.');
  if (!input.premises.some((p) => p.trim())) throw new Refusal('"premises" is empty. List the starting points the lesson rests on.');
  return parseMap(input.map);
}

export type CheckInput = {
  role: "predict" | "check";
  nodeId?: string;
  question: string;
  options: { value: string; label: string }[];
  multiSelect?: boolean;
  explanation: string;
  correctAnswer: string | string[];
};

const DONT_KNOW = /^\s*(i\s*do(?:n['’]?t|\s+not)\s+know|not\s+sure|no\s+idea)\b/i;

function checkNode(nodeId: string | undefined, msgs: Message[]): void {
  if (!nodeId) return;
  const plan = currentPlan(msgs);
  if (!plan || plan.nodes.some((n) => n.id === nodeId)) return;
  throw new Refusal(`nodeId "${nodeId}" isn't in the lesson plan. Copy one of its node ids exactly: ${plan.nodes.slice(0, 5).map((n) => n.id).join(", ")}${plan.nodes.length > 5 ? ", …" : ""}. Leave nodeId out if the question isn't about one node.`);
}

/** Semantic checks after the schema: returns the right answers as a list. */
export function validateCheck(input: CheckInput, msgs: Message[]): string[] {
  if (!input.question.trim()) throw new Refusal('"question" is empty. Write the question the user will answer.');
  if (!input.explanation.trim()) throw new Refusal('"explanation" is empty. Work the question out there before choosing correctAnswer.');
  const values = input.options.map((o) => o.value.trim());
  if (values.some((v) => !v) || input.options.some((o) => !o.label.trim())) throw new Refusal('Every option needs a non-empty "value" and "label".');
  if (new Set(values).size !== values.length) throw new Refusal("Two options have the same value. Give each option its own value, like a, b, c.");
  const idk = input.options.find((o) => DONT_KNOW.test(o.label));
  if (idk) throw new Refusal(`Remove the option "${idk.label}": the app always offers "I don't know" itself.`);
  const correct = (Array.isArray(input.correctAnswer) ? input.correctAnswer : [input.correctAnswer]).map((v) => v.trim());
  if (!correct.length) throw new Refusal('"correctAnswer" is empty. Give the value of the right option.');
  for (const c of correct) {
    if (!values.includes(c)) {
      throw new Refusal(`correctAnswer "${c}" isn't one of the option values (${values.join(", ")}). Use the value of the right option, not its label or position.`);
    }
  }
  if (correct.length > 1 && !input.multiSelect) throw new Refusal("There are several correct answers but multiSelect isn't true. Set multiSelect to true, or give one correctAnswer.");
  checkNode(input.nodeId, msgs);
  return correct;
}

export type ExplainInput = { nodeId?: string; question: string; modelAnswer: string };

export function validateExplain(input: ExplainInput, msgs: Message[]): void {
  if (!input.question.trim()) throw new Refusal('"question" is empty. Write what the user should explain.');
  if (!input.modelAnswer.trim()) throw new Refusal('"modelAnswer" is empty. Write the full answer you will grade against before asking.');
  checkNode(input.nodeId, msgs);
}

export function checkQuestion(id: string, input: CheckInput): CheckQuestion {
  return { id, role: input.role, question: input.question, options: input.options.map((o) => ({ value: o.value.trim(), label: o.label })), multiSelect: input.multiSelect === true };
}

const MAX_ANSWER_TEXT = 20_000;

/** The open question's call with its input healed against the tool's schema (the saved call is what the model sent). */
export function healedCall(block: Block): Block {
  const def = toolNamed(String(block.name));
  return def ? { ...block, input: healInput(block.input, def.input_schema) } : block;
}

/** Checks the renderer's answer against the open question. */
export function cleanAnswer(raw: unknown, call: Block): LessonAnswer {
  if (!raw || typeof raw !== "object") throw new Refusal("That answer couldn’t be read.");
  const a = raw as Record<string, unknown>;
  const out: LessonAnswer = {};
  if (a.dontKnow === true) out.dontKnow = true;
  if (typeof a.confidence === "number" && Number.isFinite(a.confidence)) out.confidence = Math.max(0, Math.min(100, Math.round(a.confidence)));
  if (typeof a.thinking === "string" && a.thinking.trim()) out.thinking = a.thinking.slice(0, MAX_ANSWER_TEXT);
  if (call.name === "check") {
    const input = call.input as CheckInput;
    const values = new Set((input.options ?? []).map((o) => String(o.value).trim()));
    const answers = Array.isArray(a.answers) ? a.answers.filter((x): x is string => typeof x === "string") : [];
    if (answers.some((x) => !values.has(x))) throw new Refusal("That answer isn’t one of the choices.");
    if (!out.dontKnow && !answers.length) throw new Refusal("Choose an answer, or I don’t know.");
    if (answers.length > 1 && input.multiSelect !== true) throw new Refusal("Choose one answer.");
    out.answers = out.dontKnow ? [] : answers;
  } else {
    const text = typeof a.text === "string" ? a.text.slice(0, MAX_ANSWER_TEXT) : "";
    if (!out.dontKnow && !text.trim()) throw new Refusal("Write your explanation, or choose I don’t know.");
    out.text = out.dontKnow ? "" : text;
  }
  return out;
}

/** Graded result for the model: only what the student added (the call already holds the question and key). */
export function answerResult(call: Block, answer: LessonAnswer): { content: string; correct?: boolean } {
  if (call.name === "check") {
    const input = call.input as CheckInput;
    const correctSet = new Set((Array.isArray(input.correctAnswer) ? input.correctAnswer : [input.correctAnswer]).map((v) => String(v).trim()));
    const chosen = answer.answers ?? [];
    const correct = !answer.dontKnow && chosen.length === correctSet.size && chosen.every((v) => correctSet.has(v));
    const labels = chosen.map((v) => ({ value: v, label: input.options.find((o) => o.value.trim() === v)?.label ?? v }));
    const body: Record<string, unknown> = { answers: labels, correct };
    if (answer.dontKnow) body.dontKnow = true;
    if (answer.confidence !== undefined) body.confidence = answer.confidence;
    if (answer.thinking) body.thinking = answer.thinking;
    return { content: JSON.stringify(body), correct };
  }
  const body: Record<string, unknown> = { text: answer.text ?? "" };
  if (answer.dontKnow) body.dontKnow = true;
  if (answer.confidence !== undefined) body.confidence = answer.confidence;
  if (answer.thinking) body.thinking = answer.thinking;
  return { content: JSON.stringify(body) };
}

/** What the model is told when the student sends a new message instead of answering. */
export const MOVED_ON = "The user didn’t answer this question and sent a new message instead.";
