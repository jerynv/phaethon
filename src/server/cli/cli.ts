/**
 * The three coding-agent CLIs Phaethon can answer through, and what differs
 * between them: names, setup-folder variables, the variables a parent session
 * leaves behind, how each says "not signed in" or "that session is gone", and
 * the user-facing messages (kept byte-exact from the Rust core).
 */

export type CliId = "claude" | "codex" | "gemini";
export const CLI_IDS: readonly CliId[] = ["claude", "codex", "gemini"];

export function isCliId(value: unknown): value is CliId {
  return value === "claude" || value === "codex" || value === "gemini";
}

/** `"claude-cli"` → `"claude"`; Phaethon's own loop (or anything else) → null. */
export function cliOfBackend(backend: unknown): CliId | null {
  switch (backend) {
    case "claude-cli":
      return "claude";
    case "codex-cli":
      return "codex";
    case "gemini-cli":
      return "gemini";
    default:
      return null;
  }
}

export const MISSING_CLI_MESSAGE = "Claude Code was not found. Install it, then connect it in Settings › Assistant.";
export const CODEX_MISSING_MESSAGE = "Codex was not found. Install Codex, then sign in to it in Settings › Assistant.";
export const GEMINI_MISSING_MESSAGE = "Gemini CLI was not found. Install Gemini CLI, then sign in to it in Settings › Assistant.";
export const NOT_LOGGED_IN_MESSAGE = "Claude Code isn’t signed in. Sign in to this connection in Settings › Assistant, then retry.";
export const OWN_SETTINGS_MESSAGE =
  "This space has its own Gemini CLI settings folder (.gemini), which could let Gemini CLI change files or reach beyond the space. Move or delete that folder to use Gemini CLI here, or choose another assistant in Settings.";
export const INELIGIBLE_MESSAGE =
  "Gemini CLI is signed in, but Google no longer lets it answer with this account: the free plan for individuals now points to Google’s Antigravity instead. A Gemini API key set up in Gemini CLI itself, or a Google Cloud or paid plan, still works. Or choose another assistant in Settings.";
export const BUSY_MESSAGE = "This space is still answering the previous message. Stop it or wait for it to finish.";
export const FULL_ACCESS_NOTE =
  "# Full access\n\nThe user turned on full access for this space: you may read and change files anywhere on this computer, run any command and use the internet, without asking. Do only what the user asked, and say in your reply exactly which files you changed or created (full paths) and which commands you ran that changed anything.";
export const REASONING_UNSUPPORTED = "That assistant does not support this reasoning level.";

type Meta = {
  name: string;
  configVar: string;
  /** Always runs with a home of its own for the vault, never the person's. */
  ownHome: boolean;
  /** How its sessions are tagged in `.phaethon/session` (built-in instance). */
  sessionTag: string | null;
  missing: string;
  /** Variables a parent session of this CLI sets for its children. */
  inheritedVars: readonly string[];
  /** Credentials a named account must not inherit from the parent environment. */
  credentialVars: readonly string[];
  notLoggedIn: (s: string) => boolean;
  isStale: (s: string) => boolean;
  login: string;
};

export const CLI: Record<CliId, Meta> = {
  claude: {
    name: "Claude Code",
    configVar: "CLAUDE_CONFIG_DIR",
    ownHome: false,
    sessionTag: null,
    missing: MISSING_CLI_MESSAGE,
    inheritedVars: [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ATTENDED",
      "CLAUDE_CODE_SSE_PORT",
      "CLAUDE_CODE_BRIDGE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_PID",
    ],
    credentialVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
    notLoggedIn: (s) => s.includes("Not logged in") || s.includes("/login"),
    isStale: (s) => s.includes("No conversation found"),
    login: "claude",
  },
  codex: {
    name: "Codex",
    configVar: "CODEX_HOME",
    ownHome: true,
    sessionTag: "codex",
    missing: CODEX_MISSING_MESSAGE,
    inheritedVars: ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI"],
    credentialVars: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
    notLoggedIn: (s) => s.includes("401 Unauthorized") || s.includes("Not logged in") || s.includes("Missing bearer"),
    isStale: (s) => s.includes("no rollout found"),
    login: "codex login",
  },
  gemini: {
    name: "Gemini CLI",
    configVar: "GEMINI_CLI_HOME",
    ownHome: true,
    sessionTag: "gemini",
    missing: GEMINI_MISSING_MESSAGE,
    inheritedVars: [
      "GEMINI_CLI",
      "GEMINI_SYSTEM_MD",
      "GEMINI_WRITE_SYSTEM_MD",
      "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
      "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
      "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
      "GEMINI_SANDBOX",
      "SANDBOX",
      "SEATBELT_PROFILE",
      "GEMINI_CLI_IDE_SERVER_PORT",
      "GEMINI_CLI_IDE_WORKSPACE_PATH",
    ],
    credentialVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
    notLoggedIn: (s) => s.includes("FatalAuthenticationError") || s.includes("Please set an Auth method") || s.includes("must specify the GEMINI_API_KEY"),
    isStale: (s) => s.includes("Error resuming session"),
    login: "gemini",
  },
};

export function cliName(cli: CliId): string {
  return CLI[cli].name;
}

/** The command that signs the person in, for them to run themselves; names the setup folder when there is one. */
export function loginCommand(cli: CliId, configDir: string | null): string {
  const meta = CLI[cli];
  return configDir ? `${meta.configVar}="${configDir}" ${meta.login}` : meta.login;
}

export function notLoggedInMessage(cli: CliId, configDir: string | null): string {
  if (cli === "claude" && configDir === null) return NOT_LOGGED_IN_MESSAGE;
  if (CLI[cli].ownHome) {
    return `${cliName(cli)} isn’t signed in for this Phaethon folder yet. Sign in to it in Settings › Assistant, then send your message again.`;
  }
  return `${cliName(cli)} isn’t signed in. Sign in to this connection in Settings › Assistant, then retry.`;
}

/** Exactly 36 chars, `-` at 8, 13, 18 and 23, ASCII hex elsewhere (not RFC-validated; UUIDv7 passes). */
export function isUuid(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}

/** A model id a CLI may be given: one line of plain characters that can't be read as a flag. */
export function isValidCliModel(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  if (Buffer.byteLength(name, "utf8") > 100) return false;
  if (/^[-./:]/.test(name) || name.includes("..")) return false;
  return /^[A-Za-z0-9\-_.:/@+]+$/.test(name);
}

const REASONING: Record<CliId, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  gemini: [],
};

export function validReasoning(cli: string, level: string): boolean {
  return isCliId(cli) && REASONING[cli].includes(level);
}

/** The line of a CLI's stderr that says what went wrong: the last one naming an error, else the last line. Stack frames never are. */
export function stderrSummary(s: string): string {
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("at "));
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes("Error") || lines[i].includes("error")) return lines[i];
  return lines.at(-1) ?? "";
}

export function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) return lines[i];
  return "";
}

/** How one run of a CLI ended, as its output said. */
export type Outcome =
  | { kind: "success"; sessionId: string | null }
  /** `stale`: the session to resume is gone; `notLoggedIn`: the protocol said so directly. */
  | { kind: "failed"; message: string; stale?: boolean; notLoggedIn?: boolean }
  /** Output ended without a result. */
  | { kind: "incomplete"; message: string };
