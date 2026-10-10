/**
 * Claude Code as the assistant: whether it is installed, and switching to it
 * only when it is. Shared by Settings › Assistant and the first-run card.
 *
 * `claude_cli_status` only looks for the `claude` command. It never reads or
 * reports anything about the person's sign-in (Anthropic's subscription rule,
 * CLAUDE.md), so "installed" is all Phaethon can say; signing in stays in
 * Claude Code.
 */
import { invoke } from "@tauri-apps/api/core";

import { setBackend } from "@/lib/backend";

/** Where to get Claude Code. */
export const CLAUDE_CODE_INSTALL_URL = "https://docs.anthropic.com/en/docs/claude-code/setup";

/** What to say when it is missing: what happened, then the way on. */
export const CLAUDE_CODE_MISSING =
  "Claude Code isn’t installed on this computer. To use it, install Claude Code from Anthropic and sign in to it, then try again. Until then, Phaethon answers using an Anthropic API key.";

/**
 * Whether the `claude` command is on this computer. Resolves null when the
 * check itself could not run (an older core without the command): the caller
 * then goes ahead as before rather than blocking on an unknown.
 */
export async function checkClaudeCode(): Promise<{ installed: boolean; path?: string } | null> {
  try {
    return await invoke<{ installed: boolean; path?: string }>("claude_cli_status");
  } catch (e) {
    console.error("claude_cli_status failed:", e);
    return null;
  }
}

/**
 * Switch to Claude Code if it is installed. Rejects with CLAUDE_CODE_MISSING
 * (a plain sentence, shown as is) when it is not, without switching.
 */
export async function switchToClaudeCode(): Promise<void> {
  const status = await checkClaudeCode();
  if (status && !status.installed) throw new ClaudeCodeMissing();
  await setBackend("claude-cli");
}

/** Claude Code is not installed. Its text is the plain sentence to show. */
export class ClaudeCodeMissing extends Error {
  constructor() {
    super(CLAUDE_CODE_MISSING);
    this.name = "ClaudeCodeMissing";
  }
  override toString() {
    return this.message;
  }
}
