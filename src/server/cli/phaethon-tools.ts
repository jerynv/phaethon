import type { ToolCategory } from "../../shared/agent.ts";
import type { Record_ } from "../core/thread.ts";
import type { ToolDef } from "../providers/types.ts";
import { messageOf } from "../rpc/registry.ts";
import { LIFE_TOOL_NAMES, lifeDetail, lifeLabel, lifeTarget, lifeTools, runLifeTool } from "../agent/tools/life.ts";

/**
 * Phaethon's own tools for the coding agents: memory, people, profiles, mail,
 * Shortcuts and schedules, the same ones Phaethon's own agent has and run by
 * the same code, scoped to the turn's space and conversation. Codex gets them
 * as dynamic tools (its app-server calls back to run one); Claude Code and
 * Gemini CLI through a local MCP endpoint that only answers for one turn
 * (mcp-http.ts). What a tool does that the person should see (a memory saved,
 * a person added, an email card) comes back as records for the conversation.
 */

export type ToolHostContext = {
  space: string;
  thread: string;
  signal: AbortSignal;
  /** A record for the conversation (shown at once and saved with the reply). */
  onRecord: (r: Record_) => void;
};

export type ToolHost = {
  defs: ToolDef[];
  call: (name: string, args: unknown) => Promise<{ text: string; isError: boolean }>;
};

/** The MCP server's name, so Claude Code calls them `mcp__phaethon__<tool>`. */
export const MCP_SERVER = "phaethon";

/** Tools a person sees as their own line or card (remembered, added to people, the email card), not as a work-log step. */
export const CARD_TOOLS = new Set(["remember", "update_memory", "update_person", "note_profile", "draft_email", "schedule_task"]);

export function toolHost(ctx: ToolHostContext): ToolHost {
  const defs = lifeTools(ctx.space);
  const offered = new Set(defs.map((d) => d.name));
  return {
    defs,
    async call(name, args) {
      if (!offered.has(name)) return { text: `There is no Phaethon tool named ${name} in this space.`, isError: true };
      try {
        const r = await runLifeTool(name, args, { space: ctx.space, thread: ctx.thread, signal: ctx.signal });
        for (const rec of r.records) ctx.onRecord(rec);
        return { text: r.text, isError: false };
      } catch (e) {
        return { text: `Not run: ${messageOf(e)}.`, isError: true };
      }
    },
  };
}

/** `mcp__phaethon__recall`, `phaethon__recall`, `phaethon.recall` or a Codex dynamic tool's own name → `recall`, when it is one of Phaethon's. */
export function phaethonTool(name: string): string | undefined {
  const bare = name.replace(/^mcp__phaethon__/, "").replace(/^phaethon(__|\.|\/|:)/, "");
  return LIFE_TOOL_NAMES.has(bare) ? bare : undefined;
}

/** How a Phaethon tool call shows in the work log: hidden (it has its own line or card), or a step with what it was about and what it found. */
export function presentTool(tool: string, args: unknown): { hidden: true } | { hidden: false; category: ToolCategory; label: string; target?: string } {
  if (CARD_TOOLS.has(tool)) return { hidden: true };
  const l = lifeLabel(tool, args);
  const target = lifeTarget(tool, args);
  return { hidden: false, category: l.category, label: l.label, ...(target ? { target } : {}) };
}

export function toolResultDetail(tool: string, text: string): string {
  return lifeDetail(tool, text.replace(/^Not run: /, ""));
}
