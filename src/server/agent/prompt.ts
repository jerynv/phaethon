import fs from "node:fs";
import path from "node:path";
import { isValidSpaceId, spacesRoot, vaultRoot } from "../core/vault.ts";
import { grantsFor } from "../grants/grants.ts";
import { memoryForPrompt } from "../memory/memory.ts";
import { courseIndexForPrompt } from "../lms/access.ts";
import { scopePromptSection, studyPromptSection, STUDY_CHAT_PROMPT } from "../study/prompt.ts";
import { appGuidePromptSection } from "./app-guide.ts";
import { tutorSection, type TutorMode } from "./tutor.ts";
import identity from "./prompts/00-identity.md";
import accuracy from "./prompts/10-accuracy.md";
import method from "./prompts/20-method.md";
import voice from "./prompts/30-voice.md";
import formatting from "./prompts/40-formatting.md";
import working from "./prompts/50-working.md";
import richOutput from "./prompts/60-rich-output.md";
import sendToUser from "./prompts/80-send-to-user.md";

/**
 * The system prompt, composed from fragments. The stable part (who Phaethon
 * is, how it reasons, explains, writes and formats, what the chat renders) is
 * byte-identical for every call with the same kind of model, so the provider
 * caches it; everything about this space and this user comes after it, in a
 * fixed order. The prompt is built once per turn: a grant given mid-turn is
 * enforced by the tools immediately, and a changing prompt mid-turn would
 * invalidate the model's thinking for the rest of the turn.
 */

const join = (parts: (string | null | undefined)[]) =>
  parts
    .filter((p): p is string => !!p && !!p.trim())
    .map((p) => p.trim())
    .join("\n\n");

/** The cached part. `claude` adds the note about delivering text with send_to_user. */
export function stablePrompt(claude: boolean): string {
  return join([identity, accuracy, method, voice, formatting, working, richOutput, appGuidePromptSection(), STUDY_CHAT_PROMPT, claude ? sendToUser : null]);
}

/** Other valid spaces in the vault, sorted. */
export function otherSpaces(space: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(spacesRoot());
  } catch {
    return [];
  }
  return names
    .filter((n) => n !== space && isValidSpaceId(n))
    .filter((n) => {
      try {
        return fs.lstatSync(path.join(spacesRoot(), n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function otherSpacesSection(space: string): string | undefined {
  const others = otherSpaces(space);
  if (!others.length) return undefined;
  let s = `# Other spaces\n\nThe user's other spaces are: ${others.join(", ")}. They are separate on purpose, and you cannot read them by default. If the user's request needs something from one of them, call request_access with the space, the narrowest folder or file that will do, and a short reason; the user decides. Once access is granted, read it with list_files, read_file or search_files using paths like "@<space>/<path>". Access is read-only: you can never write in another space.`;
  const granted = grantsFor(space);
  s += granted.length
    ? `\n\nThis space may already read (the user can revoke this at any time):\n${granted.map((g) => `- @${g.from}/${g.path}`).join("\n")}`
    : "\n\nThis space has no standing access to other spaces.";
  return s;
}

const MANUAL_CAP = 64 * 1024;

function manualSection(): string | undefined {
  const file = path.join(vaultRoot(), "MANUAL.md");
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MANUAL_CAP) return undefined;
    const text = fs.readFileSync(file, "utf8").trim();
    return text ? `# The user's manual\n\nThe user wrote this to tell you how they want you to work.\n\n${text}` : undefined;
  } catch {
    return undefined;
  }
}

const safe = (f: () => string | null | undefined) => {
  try {
    return f() ?? undefined;
  } catch {
    return undefined;
  }
};

/** Everything about this space, in a fixed order. */
export function volatilePrompt(space: string, mode: TutorMode): string {
  return join([
    `This space is called "${space}".`,
    otherSpacesSection(space),
    manualSection(),
    safe(() => memoryForPrompt(space)),
    safe(() => courseIndexForPrompt(space)),
    safe(() => scopePromptSection(space)),
    safe(() => studyPromptSection(space)),
    tutorSection(mode),
  ]);
}

export function systemPrompt(space: string, opts: { claude: boolean; mode: TutorMode }): { stable: string; volatile: string } {
  return { stable: stablePrompt(opts.claude), volatile: volatilePrompt(space, opts.mode) };
}

/** For CLI backends' `--append-system-prompt`: what the chat renders, plus anything else they need. */
export function cliRichOutput(more?: string): string {
  return join([richOutput, more]);
}
