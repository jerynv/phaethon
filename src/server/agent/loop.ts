import type { AccessAnswer, AgentEvent, ErrorCode, LessonAnswer, ToolCategory, UiRecord } from "../../shared/agent.ts";
import type { Channel } from "../rpc/channel.ts";
import { messageOf, Refusal } from "../rpc/registry.ts";
import type { Run } from "../core/runs.ts";
import { ask } from "../core/pending.ts";
import { spaceDir } from "../core/vault.ts";
import { log } from "../log.ts";
import {
  CONTINUE_TYPE,
  forProvider,
  load,
  openQuestionCall,
  recordBlock,
  records,
  save,
  stamped,
  userMessage,
  type Block,
  type Message,
  type Record_,
} from "../core/thread.ts";
import { expandForProvider, preparePdfTexts } from "../attachments/attachments.ts";
import { addAlways, checkRequest, covers } from "../grants/grants.ts";
import { readSettings } from "../settings/settings.ts";
import { cutAt } from "../threads/store.ts";
import { ProviderError, type Delta, type ModelTurn, type Provider, type WireMessage } from "../providers/types.ts";
import { PLACES } from "./app-guide.ts";
import { compactionBlock, compactionStart, compactionText, COMPACT_TYPE, needsCompaction, summarize } from "./compaction.ts";
import { CONTINUE_INSTRUCTION, continueBlock, settle, stoppedReply } from "./continuation.ts";
import { effortFor, turnKind } from "./effort.ts";
import { healInput, schemaProblems } from "./heal.ts";
import {
  answerResult,
  checkQuestion,
  MOVED_ON,
  validateCheck,
  validateExplain,
  validatePlan,
  type CheckInput,
  type ExplainInput,
  type PlanInput,
} from "./lesson.ts";
import { systemPrompt } from "./prompt.ts";
import { activity, activityTarget, clip, label, parseCall, type Call } from "./tools/calls.ts";
import { toolDefs, toolNamed } from "./tools/definitions.ts";
import {
  describeWrite,
  isCovered,
  listFiles,
  MAX_PAGES_PER_TURN,
  PAGE_GATE_BLIND,
  PAGE_GATE_SIX,
  readFile,
  readPage,
  runWrite,
  searchFiles,
  studyAttempt,
  target,
  type ToolCtx,
} from "./tools/files.ts";
import { tutorMode } from "./tutor.ts";

/**
 * Phaethon's own agent turn: the user's message, then up to MAX_STEPS model
 * calls with tool calls run between them, everything saved to thread.json as
 * it happens. The caller (turn.ts) claims the space and sends the single
 * `end` event.
 */

export const MAX_STEPS = 30;
const STOPPED = "Not run: the user stopped the reply.";

export type TurnMode =
  | { kind: "prompt"; prompt: string; attachments: Block[]; replaceFrom?: number }
  | { kind: "continue"; from: number }
  | { kind: "answer"; call: Block; answer: LessonAnswer };

export type OwnTurn = {
  space: string;
  provider: Provider;
  events: Channel<AgentEvent>;
  run: Run;
  mode: TurnMode;
};

const CODES: Record<ProviderError["kind"], ErrorCode> = {
  auth: "apiKey",
  billing: "billing",
  rateLimit: "rateLimit",
  unavailable: "unavailable",
  badRequest: "badRequest",
  network: "network",
};

/** What the model sees: from the latest summary on, Phaethon's own blocks turned into text or removed, attachments inlined. */
export function wireFor(space: string, msgs: Message[], provider: Provider): WireMessage[] {
  const view = msgs.slice(compactionStart(msgs)).map((m) => {
    if (!m.content.some((b) => b.type === CONTINUE_TYPE || b.type === COMPACT_TYPE)) return m;
    return {
      role: m.role,
      content: m.content.map((b) => (b.type === CONTINUE_TYPE ? { type: "text", text: CONTINUE_INSTRUCTION } : b.type === COMPACT_TYPE ? compactionText(b) : b)),
    };
  });
  const anthropic = provider.id === "anthropic";
  return expandForProvider(space, forProvider(view as Message[]), { images: anthropic || provider.imageInput() !== "no", pdf: anthropic });
}

/** Closes a question the user moved past by sending a new message, so every tool call keeps its result. */
function closeOpenQuestion(msgs: Message[]): void {
  const open = openQuestionCall(msgs);
  if (!open) return;
  const result: Block = { type: "tool_result", tool_use_id: open.block.id, content: MOVED_ON };
  const last = msgs[msgs.length - 1];
  if (msgs.length - 1 > open.index && last.role === "user") last.content.push(result);
  else msgs.push(stamped({ role: "user", content: [result] }));
}

/** Puts the student's answer in as the question's tool result and marks its record. */
function applyAnswer(msgs: Message[], call: Block, answer: LessonAnswer): void {
  const open = openQuestionCall(msgs);
  if (!open || open.block.id !== call.id) throw new Refusal("That question is no longer open. Reload the conversation.");
  const graded = answerResult(call, answer);
  const result: Block = { type: "tool_result", tool_use_id: call.id, content: graded.content };
  const last = msgs[msgs.length - 1];
  if (msgs.length - 1 > open.index && last.role === "user") last.content.push(result);
  else msgs.push(stamped({ role: "user", content: [result] }));
  for (const b of msgs[open.index].content) {
    if (b.type === "phaethon_record" && b.kind === "check" && b.id === call.id) {
      b.answered = true;
      if (graded.correct !== undefined) b.correct = graded.correct;
      if (answer.confidence !== undefined) b.confidence = answer.confidence;
    }
  }
}

function denied(msgs: Message[], space: string, p: string): boolean {
  return records(msgs).some((r) => (r.kind === "access" && r.answer === "deny" && r.space === space && covers(r.path, p)) || (r.kind === "deniedEarlier" && r.space === space && covers(r.path, p)));
}

/** Tools whose call the user sees as a card rather than a work-log step. */
const LESSON_CARDS = new Set(["check", "explain_back", "plan_lesson"]);

export async function runOwnTurn(t: OwnTurn): Promise<void> {
  const { space, provider, events, run } = t;
  const signal = run.abort.signal;
  const emit = (e: AgentEvent) => events.send(e);
  const storage = (message: string) => emit({ kind: "error", code: "storage", message });

  let msgs: Message[];
  try {
    msgs = load(space);
  } catch (e) {
    return storage(`This space’s conversation file couldn’t be read, so nothing was sent: ${messageOf(e)}`);
  }
  const root = spaceDir(space);
  const ctx: ToolCtx = { space, root, once: [] };
  const mode = tutorMode(space);

  // The continue bookkeeping, settled after the loop.
  let settleAt: { start: number; stoppedAt: number } | undefined;

  if (t.mode.kind === "prompt") {
    if (t.mode.replaceFrom !== undefined) {
      try {
        msgs = cutAt(space, msgs, t.mode.replaceFrom);
      } catch (e) {
        return storage(messageOf(e));
      }
    }
    closeOpenQuestion(msgs);
    if (needsCompaction(msgs, provider, root)) {
      emit({ kind: "tool", label: "Summarizing the earlier conversation" });
      try {
        msgs.push(stamped({ role: "user", content: [compactionBlock(await summarize(provider, msgs, signal))] }));
      } catch (e) {
        if (signal.aborted) {
          emit({ kind: "cancelled" });
          return;
        }
        log.warn("compaction failed; sending the whole conversation", { error: messageOf(e) });
      }
    }
    msgs.push(stamped(userMessage(t.mode.prompt, t.mode.attachments)));
  } else if (t.mode.kind === "continue") {
    let stoppedAt: number;
    try {
      stoppedAt = stoppedReply(msgs, t.mode.from);
    } catch (e) {
      return storage(messageOf(e));
    }
    settleAt = { start: msgs.length, stoppedAt };
    msgs.push(stamped({ role: "user", content: [continueBlock()] }));
  } else {
    try {
      applyAnswer(msgs, t.mode.call, t.mode.answer);
    } catch (e) {
      return storage(messageOf(e));
    }
  }
  try {
    save(space, msgs);
    if (t.mode.kind === "answer") {
      // The question's record now says how it went; the open reply shows that at once.
      const callId = t.mode.call.id;
      const marked = records(msgs).find((r) => r.kind === "check" && r.id === callId);
      if (marked) emit({ kind: "record", record: marked as UiRecord });
    }
  } catch (e) {
    return storage(`The conversation could not be saved, so nothing was sent: ${messageOf(e)}`);
  }

  try {
    await steps(t, msgs, ctx, mode);
  } finally {
    if (settleAt) {
      try {
        const now = load(space);
        if (settle(now, settleAt.start, settleAt.stoppedAt)) save(space, now);
      } catch (e) {
        log.warn("couldn't tidy a continued reply", { error: messageOf(e) });
      }
    }
  }
}

async function steps(t: OwnTurn, msgs: Message[], ctx: ToolCtx, mode: ReturnType<typeof tutorMode>): Promise<void> {
  const { space, provider, events, run } = t;
  const signal = run.abort.signal;
  const emit = (e: AgentEvent) => events.send(e);
  const storage = (message: string) => emit({ kind: "error", code: "storage", message });

  // Built once per turn (see prompt.ts).
  const system = systemPrompt(space, { claude: provider.isClaude, mode });
  const tools = toolDefs({ claude: provider.isClaude, lesson: mode !== "normal" });
  const offered = new Set(tools.map((x) => x.name));
  const effort = effortFor(turnKind(mode, msgs), readSettings().effort);
  let anyText = false;
  let seq = 0;
  let pages = 0;

  const shownText = (text: string) => {
    if (!text) return;
    if (anyText) emit({ kind: "text", delta: "\n\n" });
    emit({ kind: "text", delta: text });
    anyText = true;
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const partials: string[] = [];
    const progress: string[] = [];
    let started = false;
    const onDelta = (d: Delta) => {
      switch (d.type) {
        case "textStart":
          if (anyText) emit({ kind: "text", delta: "\n\n" });
          partials.push("");
          started = true;
          break;
        case "text":
          if (!started) {
            partials.push("");
            started = true;
          }
          partials[partials.length - 1] += d.text;
          if (d.text) {
            emit({ kind: "text", delta: d.text });
            anyText = true;
          }
          break;
        case "progress":
          progress.push(d.text);
          emit({ kind: "progress", text: d.text });
          break;
        case "thinking":
          emit({ kind: "thinking", delta: d.text });
          break;
      }
    };

    let turn: ModelTurn;
    try {
      // Models other than Anthropic's get an attached PDF as its text.
      if (provider.id !== "anthropic") await preparePdfTexts(space, msgs, signal);
      turn = await provider.turn({ system, messages: wireFor(space, msgs, provider), tools, effort }, onDelta, signal);
    } catch (e) {
      const partialBlocks: Block[] = partials.filter((p) => p.trim()).map((p) => ({ type: "text", text: p.trimEnd() }));
      if (signal.aborted) {
        const content: Block[] = [...partialBlocks, ...progress.map((text) => recordBlock({ kind: "progress", text })), recordBlock({ kind: "stopped" })];
        msgs.push(stamped({ role: "assistant", content }));
        emit({ kind: "record", record: { kind: "stopped" } });
        try {
          save(space, msgs);
        } catch (err) {
          storage(`The stopped reply could not be saved: ${messageOf(err)}`);
        }
        emit({ kind: "cancelled" });
        return;
      }
      if (partialBlocks.length) {
        msgs.push(stamped({ role: "assistant", content: partialBlocks }));
        try {
          save(space, msgs);
        } catch {
          // the error below is what matters
        }
      }
      if (e instanceof ProviderError) {
        emit({ kind: "error", code: CODES[e.kind], message: e.message, ...(e.retryAfter !== undefined && (e.kind === "rateLimit" || e.kind === "unavailable") ? { retryAfterSecs: e.retryAfter } : {}) });
      } else if (e instanceof Refusal) {
        emit({ kind: "error", code: "noApiKey", message: e.message });
      } else {
        log.error("model call failed", e);
        emit({ kind: "error", code: "provider", message: `The model call failed: ${messageOf(e)}` });
      }
      return;
    }

    if (turn.stopReason === "refusal") {
      emit({ kind: "error", code: "declined", message: "The model declined to answer this. Try rephrasing your message." });
      return;
    }

    const reply = msgs.length;
    msgs.push(stamped({ role: "assistant", content: [...turn.content, ...progress.map((text) => recordBlock({ kind: "progress", text }))] }));
    try {
      save(space, msgs);
    } catch (e) {
      return storage(`The reply could not be saved: ${messageOf(e)}`);
    }

    const uses = turn.content.filter((b) => b.type === "tool_use");
    if (!uses.length) {
      if (turn.stopReason === "pause_turn") continue;
      if (turn.stopReason === "max_tokens" || turn.stopReason === "model_context_window_exceeded") {
        emit({ kind: "error", code: "provider", message: "The reply reached its length limit and was cut off." });
      }
      return;
    }

    const results: Block[] = [];
    let endTurn = false;
    let question: AgentEvent | undefined;
    const addRecord = (record: Record_, show = true) => {
      msgs[reply].content.push(recordBlock(record));
      if (show) emit({ kind: "record", record: record as UiRecord });
    };

    for (const use of uses) {
      const useId = String(use.id);
      const name = String(use.name);
      seq++;
      const activityId = `phaethon:${seq}:${useId}`;
      const result = (content: string | Block[], isError: boolean): Block =>
        isError ? { type: "tool_result", tool_use_id: useId, content, is_error: true } : { type: "tool_result", tool_use_id: useId, content };

      if (name === "send_to_user" && !signal.aborted) {
        const msg = (healInput(use.input, toolNamed("send_to_user")!.input_schema) as { message?: unknown })?.message;
        if (typeof msg === "string" && msg.trim()) {
          shownText(msg);
          results.push(result("Shown to the user.", false));
        } else results.push(result('Not run: "message" is required and must be a string.', true));
        continue;
      }

      const wasCancelled = signal.aborted;
      const act = activity(name);
      const shownTarget = activityTarget(use.input, ctx.root);
      // Lesson tools appear as their own card (question, plan), not as a step in the work log.
      const logged = !LESSON_CARDS.has(name);
      if (!wasCancelled && logged) emit({ kind: "toolStart", id: activityId, category: act.category, label: act.label, ...(shownTarget ? { target: shownTarget } : {}) });

      let outcome: { block: Block | undefined; status: "success" | "failed" | "cancelled" };
      if (wasCancelled) outcome = { block: result(STOPPED, true), status: "cancelled" };
      else {
        outcome = await runOne({
          t,
          msgs,
          ctx,
          use,
          name,
          turn,
          offered,
          result,
          addRecord,
          pagesUsed: () => pages,
          pageShown: () => pages++,
          questionAsked: () => question !== undefined,
          ask: (q) => {
            question = q;
            endTurn = true;
          },
          endTurn: () => {
            endTurn = true;
          },
        });
      }
      if (outcome.block) results.push(outcome.block);
      if (!wasCancelled && logged) {
        const detail = outcome.status === "failed" ? "Tool reported an error" : undefined;
        emit({ kind: "toolEnd", id: activityId, status: outcome.status, ...(detail ? { detail } : {}) });
        addRecord({ kind: "tool", id: activityId, category: act.category as ToolCategory, label: clip(act.label), status: outcome.status, ...(shownTarget ? { target: shownTarget } : {}), ...(detail ? { detail } : {}) });
      }
    }

    if (signal.aborted) addRecord({ kind: "stopped" });
    if (results.length) msgs.push(stamped({ role: "user", content: results }));
    try {
      save(space, msgs);
    } catch (e) {
      return storage(`The conversation could not be saved: ${messageOf(e)}`);
    }
    if (signal.aborted) {
      emit({ kind: "cancelled" });
      return;
    }
    if (question) emit(question);
    if (endTurn) return;
  }
  emit({ kind: "error", code: "provider", message: `Phaethon stopped the agent after ${MAX_STEPS} steps. Send another message to let it continue.` });
}

type One = {
  t: OwnTurn;
  msgs: Message[];
  ctx: ToolCtx;
  use: Block;
  name: string;
  turn: ModelTurn;
  offered: Set<string>;
  result: (content: string | Block[], isError: boolean) => Block;
  addRecord: (r: Record_, show?: boolean) => void;
  pagesUsed: () => number;
  pageShown: () => void;
  questionAsked: () => boolean;
  ask: (q: AgentEvent) => void;
  endTurn: () => void;
};

type Outcome = { block: Block | undefined; status: "success" | "failed" | "cancelled" };

async function runOne(o: One): Promise<Outcome> {
  const { t, ctx, use, name, result } = o;
  const emit = (e: AgentEvent) => t.events.send(e);
  const signal = t.run.abort.signal;
  const ok = (content: string | Block[]): Outcome => ({ block: result(content, false), status: "success" });
  const fail = (content: string): Outcome => ({ block: result(content, true), status: "failed" });
  const useId = String(use.id);

  if (o.turn.stopReason === "max_tokens") return fail("Not run: the reply was cut off before this call was complete. Try again with less content.");
  const invalid = o.turn.invalidInputs.find(([id]) => id === useId);
  if (invalid) {
    const raw = invalid[1];
    const chars = [...raw];
    const shown = chars.length > 500 ? `${chars.slice(0, 500).join("")}… (${chars.length - 500} more characters)` : raw;
    return fail(`Not run: the input was not valid JSON: ${shown}`);
  }
  const def = toolNamed(name);
  const input = def ? healInput(use.input, def.input_schema) : use.input;

  // Lesson tools: schema problems first, then meaning, each with how to fix it.
  if (name === "plan_lesson" || name === "check" || name === "explain_back") {
    if (!def || !o.offered.has(name)) return fail(`Not run: there is no tool named ${name}.`);
    const problems = schemaProblems(input, def.input_schema);
    if (problems.length) return fail(`Not run: ${problems.join("; ")}. Fix these and call ${name} again.`);
    try {
      if (name === "plan_lesson") {
        const plan = input as PlanInput;
        const parsed = validatePlan(plan);
        o.addRecord({ kind: "lessonPlan", id: useId, goal: plan.goal, map: plan.map, nodes: parsed.nodes });
        o.endTurn();
        return ok(`Plan saved and shown to the user with its map (node ids: ${parsed.nodes.map((n) => n.id).join(", ")}). Wait for their reply before teaching.`);
      }
      if (o.questionAsked()) return fail("Not run: a question is already waiting for the user in this reply. Ask one question at a time.");
      if (name === "check") {
        const q = input as CheckInput;
        validateCheck(q, o.msgs);
        const question = checkQuestion(useId, q);
        o.addRecord({ kind: "check", id: useId, question: q.question });
        o.ask({ kind: "check", question });
        return { block: undefined, status: "success" };
      }
      const q = input as ExplainInput;
      validateExplain(q, o.msgs);
      o.addRecord({ kind: "check", id: useId, question: q.question });
      o.ask({ kind: "explainBack", question: { id: useId, question: q.question } });
      return { block: undefined, status: "success" };
    } catch (e) {
      return fail(`Not run: ${messageOf(e)}`);
    }
  }

  const parsed = parseCall(name, input);
  if (!parsed.ok) return fail(`Not run: ${parsed.error}.`);
  const call = parsed.call;
  const i = call.input;
  const p = String(i.path ?? "");

  try {
    switch (name) {
      case "list_files":
      case "read_file":
      case "search_files": {
        const tgt = target(ctx.space, p);
        if (tgt.kind === "local") emit({ kind: "tool", label: label(ctx.space, call) });
        const text = name === "list_files" ? listFiles(ctx, p) : name === "read_file" ? readFile(ctx, p) : searchFiles(ctx, String(i.query), p);
        if (tgt.kind === "other") recordOtherRead(o, call, tgt.space, tgt.rel);
        return ok(text);
      }
      case "read_page": {
        if (t.provider.imageInput() !== "yes") return fail(PAGE_GATE_BLIND);
        if (o.pagesUsed() >= MAX_PAGES_PER_TURN) return fail(PAGE_GATE_SIX);
        const tgt = target(ctx.space, p);
        if (tgt.kind === "local") emit({ kind: "tool", label: label(ctx.space, call) });
        const blocks = await readPage(ctx, p, Number(i.page));
        if (tgt.kind === "other") recordOtherRead(o, call, tgt.space, tgt.rel);
        o.pageShown();
        return ok(blocks);
      }
      case "write_file":
        return await writeFlow(o, call);
      case "request_access":
        return await accessFlow(o, call);
      case "app_guide":
        emit({ kind: "tool", label: label(ctx.space, call) });
        return ok(PLACES);
      case "study_attempt":
        emit({ kind: "tool", label: label(ctx.space, call) });
        return ok(studyAttempt(ctx, p));
      default:
        return fail(`Not run: there is no tool named ${name}.`);
    }
  } catch (e) {
    if (signal.aborted && messageOf(e) === "cancelled") return { block: result(STOPPED, true), status: "cancelled" };
    return fail(messageOf(e));
  }
}

function recordOtherRead(o: One, call: Call, other: string, rel: string): void {
  const clean = rel.split("/").filter((s) => s && s !== ".").join("/");
  o.t.events.send({ kind: "tool", label: label(o.ctx.space, call) });
  const tool = call.name === "list_files" ? "list" : call.name === "search_files" ? "search" : "read";
  o.addRecord({ kind: "read", space: other, path: clean, tool, ...(tool === "search" ? { query: String(call.input.query) } : {}) });
}

async function writeFlow(o: One, call: Call): Promise<Outcome> {
  const { t, ctx, use, result } = o;
  const emit = (e: AgentEvent) => t.events.send(e);
  const signal = t.run.abort.signal;
  const id = String(use.id);
  const contents = String(call.input.contents);
  let plan;
  try {
    plan = describeWrite(ctx, String(call.input.path), contents);
  } catch (e) {
    return { block: result(`Not run: ${messageOf(e)}.`, true), status: "failed" };
  }
  emit({ kind: "tool", label: `Waiting for you to allow: ${label(ctx.space, call)}` });
  const waiting = ask<boolean>(t.space, `write:${id}`, signal);
  emit({ kind: "approval", id, summary: plan.summary, detail: plan.detail, action: plan.action, path: plan.rel, space: t.space, before: plan.before, truncated: plan.truncated });
  let allowed = false;
  try {
    allowed = (await waiting) === true;
  } catch {
    allowed = false;
  }
  const cancelled = signal.aborted;
  emit({ kind: "approvalDone", id, allowed: allowed && !cancelled });
  if (cancelled) return { block: result(STOPPED, true), status: "cancelled" };
  o.addRecord({ kind: "approval", path: plan.rel, action: plan.action, allowed });
  if (!allowed) return { block: result("The user declined this write. Nothing was changed.", true), status: "failed" };
  emit({ kind: "tool", label: label(ctx.space, call) });
  try {
    return { block: result(runWrite(ctx, plan, contents), false), status: "success" };
  } catch (e) {
    return { block: result(messageOf(e), true), status: "failed" };
  }
}

async function accessFlow(o: One, call: Call): Promise<Outcome> {
  const { t, ctx, use, result, msgs } = o;
  const emit = (e: AgentEvent) => t.events.send(e);
  const signal = t.run.abort.signal;
  const id = String(use.id);
  const other = String(call.input.space).replace(/^@/, "");
  let p: string;
  try {
    p = checkRequest(ctx.space, other, String(call.input.path));
  } catch (e) {
    return { block: result(`Not asked: ${messageOf(e)}.`, true), status: "failed" };
  }
  const readHint = `Read it with paths starting "@${other}/${p}".`;
  if (isCovered(ctx, other, p)) return { block: result(`This space can already read @${other}/${p}. ${readHint}`, false), status: "success" };
  if (denied(msgs, other, p)) {
    return {
      block: result(
        `Not asked: the user already declined access to @${other}/${p} (or a folder holding it) in this conversation. Do not ask for it again in this conversation. Work without it, or tell the user plainly what you would need and why.`,
        true,
      ),
      status: "failed",
    };
  }
  emit({ kind: "tool", label: `Waiting for you to answer: ${label(ctx.space, call)}` });
  const waiting = ask<AccessAnswer>(t.space, `access:${id}`, signal);
  emit({ kind: "accessRequest", id, space: other, path: p, reason: String(call.input.reason) });
  let answer: AccessAnswer = "deny";
  try {
    const a = await waiting;
    answer = a === "once" || a === "always" ? a : "deny";
  } catch {
    answer = "deny";
  }
  const cancelled = signal.aborted;
  emit({ kind: "accessRequestDone", id, answer: cancelled ? "deny" : answer });
  if (cancelled) return { block: result("Not asked: the user stopped the reply.", true), status: "cancelled" };
  o.addRecord({ kind: "access", space: other, path: p, answer });
  if (answer === "deny") {
    return {
      block: result(
        `The user declined access to @${other}/${p}. Phaethon will refuse any further request for it in this conversation, so do not ask again; work without it or ask them what they would like.`,
        true,
      ),
      status: "failed",
    };
  }
  if (answer === "once") {
    ctx.once.push({ from: other, path: p });
    return { block: result(`The user allowed reading @${other}/${p} for this reply only. ${readHint}`, false), status: "success" };
  }
  try {
    addAlways(ctx.space, other, p);
    return { block: result(`The user allowed reading @${other}/${p} from now on. ${readHint}`, false), status: "success" };
  } catch (e) {
    ctx.once.push({ from: other, path: p });
    return {
      block: result(`The user allowed reading @${other}/${p}, but the permission could not be saved (${messageOf(e)}), so it lasts for this reply only. ${readHint}`, false),
      status: "success",
    };
  }
}
