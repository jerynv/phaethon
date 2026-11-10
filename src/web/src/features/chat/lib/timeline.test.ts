import { describe, expect, test } from "vitest";

import type { AgentEvent, UiMessage } from "#shared/agent.ts";
import { applyEvent, continueReply, fromUi, mergeSaved, needsYou, replyText, segments, startReply, workSummary, type AssistantMessage } from "./timeline.ts";

const run = (events: AgentEvent[], from: AssistantMessage = startReply()) => events.reduce((m, e) => applyEvent(m, e, 1000), from);

describe("a streamed reply", () => {
  test("text, tools and records land in order; the work groups together", () => {
    const m = run([
      { kind: "toolStart", id: "t1", category: "read", label: "Reading file", target: "notes.md" },
      { kind: "tool", label: "Reading file notes.md" },
      { kind: "toolEnd", id: "t1", status: "success" },
      { kind: "record", record: { kind: "tool", id: "t1", category: "read", label: "Reading file", target: "notes.md", status: "success" } },
      { kind: "toolStart", id: "t2", category: "search", label: "Searching", target: "eigen" },
      { kind: "toolEnd", id: "t2", status: "failed", detail: "No such folder" },
      { kind: "progress", text: "Found the definition; checking an example." },
      { kind: "text", delta: "An eigenvalue " },
      { kind: "text", delta: "is a scalar." },
      { kind: "end", sessionId: null },
    ]);
    expect(m.status).toBe("done");
    expect(m.at).toBe(1000);
    expect(replyText(m)).toBe("An eigenvalue is a scalar.");
    const segs = segments(m.parts);
    expect(segs.map((s) => s.type)).toEqual(["work", "progress", "text"]);
    const work = segs[0];
    expect(work.type === "work" && work.tools.map((t) => t.status)).toEqual(["success", "failed"]);
    expect(work.type === "work" && workSummary(work.tools)).toBe("Read 1 file, searched once, 1 failed");
  });

  test("a write waits on the person, and the wait clears when answered", () => {
    let m = run([
      { kind: "toolStart", id: "w", category: "write", label: "Changing file", target: "plan.md" },
      { kind: "tool", label: "Waiting for you to allow: Writing file plan.md" },
      { kind: "approval", id: "w", summary: "Create a new file plan.md (3 lines).", detail: "a\nb\nc", action: "create", path: "plan.md", space: "school", before: null, truncated: false },
    ]);
    expect(needsYou(m)).toBe(true);
    expect(m.approval?.path).toBe("plan.md");
    m = run([{ kind: "approvalDone", id: "w", allowed: true }, { kind: "record", record: { kind: "approval", path: "plan.md", action: "create", allowed: true } }], m);
    expect(m.approval).toBeUndefined();
    expect(m.toolStatus).toBeUndefined();
    expect(needsYou(m)).toBe(false);
  });

  test("an error settles running tools and keeps what arrived", () => {
    const m = run([
      { kind: "toolStart", id: "t", category: "read", label: "Reading file" },
      { kind: "text", delta: "Partly" },
      { kind: "error", code: "rateLimit", message: "slow down", retryAfterSecs: 30 },
      { kind: "end", sessionId: null },
    ]);
    expect(m.status).toBe("failed");
    expect(m.error).toEqual({ code: "rateLimit", message: "slow down", retryAfterSecs: 30 });
    expect(m.parts[0].type === "record" && m.parts[0].record.kind === "tool" && m.parts[0].record.status).toBe("failed");
  });

  test("a stopped reply continues after a paragraph break, without its stop marker", () => {
    const stopped = run([{ kind: "text", delta: "First part. " }, { kind: "cancelled" }, { kind: "record", record: { kind: "stopped" } }, { kind: "end", sessionId: null }]);
    expect(stopped.status).toBe("stopped");
    const cont = run([{ kind: "text", delta: "Second part." }, { kind: "end", sessionId: null }], continueReply(stopped));
    expect(replyText(cont)).toBe("First part.\n\nSecond part.");
    expect(cont.continuedAfter).toBe("First part.".length);
    expect(cont.parts.some((p) => p.type === "record" && p.record.kind === "stopped")).toBe(false);
  });

  test("a lesson question ends the turn and stays pending", () => {
    const m = run([
      { kind: "text", delta: "Before we start:" },
      { kind: "check", question: { id: "q1", role: "predict", question: "What is 2+2?", options: [{ value: "a", label: "4" }], multiSelect: false } },
      { kind: "end", sessionId: null },
    ]);
    expect(m.status).toBe("done");
    expect(m.question?.kind).toBe("check");
    expect(needsYou(m)).toBe(true);
  });

  test("thinking deltas gather into one block", () => {
    const m = run([{ kind: "thinking", delta: "Let me " }, { kind: "thinking", delta: "see." }, { kind: "text", delta: "Done." }]);
    expect(m.parts[0]).toEqual({ type: "thinking", text: "Let me see." });
  });
});

describe("the saved conversation", () => {
  const saved: UiMessage[] = [
    { role: "user", text: "Hi", attachments: [{ name: "a.png", path: "files/a.png", mediaType: "image/png" }], index: 0, records: [], at: 5 },
    {
      role: "assistant",
      text: "Hello",
      attachments: [],
      index: 1,
      records: [
        { kind: "approval", path: "x.md", action: "create", allowed: true },
        { kind: "tool", id: "t", category: "read", label: "Reading file", status: "success" },
      ],
      at: 6,
    },
  ];

  test("loads with tool work first, then words, then receipts", () => {
    const [u, a] = fromUi(saved);
    expect(u.role === "user" && u.attachments[0].path).toBe("files/a.png");
    expect(a.role === "assistant" && a.parts.map((p) => (p.type === "record" ? p.record.kind : p.type))).toEqual(["tool", "text", "approval"]);
  });

  test("after a turn the live messages get the saved positions", () => {
    const live = [
      { role: "user" as const, key: "u", text: "Hi", attachments: [{ name: "a.png", mediaType: "image/png", previewUrl: "blob:x" }] },
      { ...startReply(), status: "done" as const, parts: [{ type: "text" as const, text: "Hello" }] },
    ];
    const merged = mergeSaved(live, saved);
    expect(merged[0].index).toBe(0);
    expect(merged[1].index).toBe(1);
    expect(merged[0].role === "user" && merged[0].attachments[0]).toEqual({ name: "a.png", path: "files/a.png", mediaType: "image/png", previewUrl: "blob:x" });
    expect(mergeSaved(live.slice(0, 1), saved)).toHaveLength(2);
  });
});

describe("a failed turn", () => {
  test("keeps its messages when the save doesn't line up, with positions where it does", () => {
    const saved: UiMessage[] = [{ role: "user", text: "Hi", attachments: [], index: 0, records: [] }];
    const live = [
      { role: "user" as const, key: "u", text: "Hi", attachments: [] },
      { ...startReply(), status: "failed" as const, error: { code: "noApiKey" as const, message: "x" } },
    ];
    const kept = mergeSaved(live, saved, true);
    expect(kept).toHaveLength(2);
    expect(kept[0].index).toBe(0);
    expect(kept[1].index).toBeUndefined();
    expect(mergeSaved(live, [], true)[0].index).toBeUndefined();
  });
});
