import path from "node:path";
import { appGuideCliSection, REASONING_PROMPT, RICH_OUTPUT_PROMPT, tutorModeSection } from "../agent/prompt-sections.ts";
import type { Block, Message } from "../core/thread.ts";
import { studyPromptForCli } from "../study/prompt.ts";
import { toUi } from "../threads/store.ts";
import { FULL_ACCESS_NOTE } from "./cli.ts";

/** Said to a fresh session before a conversation it never saw. */
export const HISTORY_INTRO =
  'This conversation began before this session, so you haven\'t seen it. Here it is so far, as plain text ("Phaethon" is you). Carry on from it.';

const TRANSCRIPT_CAP = 120_000;

/** The conversation as plain text: `User:`/`Phaethon:` lines, the last 120 000 bytes when longer. */
export function transcript(msgs: Message[]): string {
  let out = "";
  for (const m of toUi(msgs)) {
    const who = m.role === "user" ? "User" : "Phaethon";
    const files = m.attachments.length ? ` [attached: ${m.attachments.map((a) => a.name).join(", ")}]` : "";
    out += `${who}:${files} ${m.text.trim()}\n\n`;
  }
  const bytes = Buffer.from(out, "utf8");
  if (bytes.length <= TRANSCRIPT_CAP) return out;
  let start = bytes.length - TRANSCRIPT_CAP;
  // Move forward to a character boundary (skip UTF-8 continuation bytes).
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return `[The start of the conversation is left out.]\n\n${bytes.subarray(start).toString("utf8")}`;
}

/** What the CLI is asked: the new message, after the conversation so far when the session starts fresh on one that has messages. */
export function cliPrompt(ask: string, msgs: Message[], fresh: boolean): string {
  if (!fresh || toUi(msgs).length === 0) return ask;
  return `${HISTORY_INTRO}\n\n<conversation>\n${transcript(msgs)}</conversation>\n\nThe user's new message:\n\n${ask}`;
}

function attachmentPaths(attachments: Block[]): string[] {
  return attachments.map((a) => a.path).filter((p): p is string => typeof p === "string");
}

/** The note naming the message's saved files: space-relative, or absolute when the CLI works in an outside project folder. */
export function attachmentNote(attachments: Block[], spaceDir: string, external: boolean): string {
  const paths = attachmentPaths(attachments);
  if (!paths.length) return "";
  if (external) {
    return `\n\nThe user attached these files in the managed Phaethon space context, not the project folder:\n${paths.map((p) => `- ${path.join(spaceDir, p)}`).join("\n")}`;
  }
  return `\n\nThe user attached these files, saved in this folder:\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/**
 * The text added to the CLI's own system prompt: how to reason and explain,
 * how replies are shown, the app guide, study (course scope, study files and
 * exam dates, the study-chat block), the tutor mode (in that order), then the
 * workspace block for an outside project folder and the full-access note in
 * front.
 */
export function systemText(o: { space: string; spaceDir: string; workingDir: string; fullAccess: boolean }): string {
  const parts = [REASONING_PROMPT, RICH_OUTPUT_PROMPT, appGuideCliSection()];
  const study = studyPromptForCli(o.space);
  if (study) parts.push(study);
  const tutor = tutorModeSection(o.space);
  if (tutor) parts.push(tutor);
  let mode = parts.join("\n\n");
  if (o.workingDir !== o.spaceDir) {
    mode = `# Workspace\n\nProject working folder: ${JSON.stringify(o.workingDir)}\nPhaethon space context: ${JSON.stringify(o.spaceDir)}\nRelative project paths resolve under the project working folder. Saved message attachments and app-generated study, notes and practice belong to the Phaethon space context; use its absolute path to read or reference them. Keep Phaethon's conversation and internal metadata in that managed context, not in the project.\n\n${mode}`;
  }
  if (o.fullAccess) mode = `${FULL_ACCESS_NOTE}\n\n${mode}`;
  return mode;
}
