import { cliName, type CliId } from "./cli.ts";

/**
 * A named connection may add its own launch arguments, but in a read-only
 * space they must not be able to switch off what keeps the CLI read-only
 * (bypassing permissions, extra writable folders, MCP servers, settings
 * files, sandbox overrides…). So in a walled turn only arguments known to be
 * harmless pass; anything else stops the turn before launch with a message
 * naming the argument. With full access every argument passes.
 */

type Flags = Record<string, "flag" | "value">;

const CLAUDE: Flags = {
  "--fallback-model": "value",
  "--betas": "value",
  "--max-budget-usd": "value",
  "--autocompact": "value",
  "--debug-file": "value",
  "--debug": "flag",
  "-d": "flag",
  "--verbose": "flag",
  "--disallowedTools": "value",
  "--disallowed-tools": "value",
  "--exclude-dynamic-system-prompt-sections": "flag",
  "--ax-screen-reader": "flag",
};

const CODEX: Flags = {
  "-c": "value",
  "--config": "value",
  "--disable": "value",
  "--strict-config": "flag",
};

/** Codex `-c key=value` overrides that choose a model or provider; none of them loosens the sandbox. */
const CODEX_CONFIG_KEYS = [/^model_provider$/, /^model_providers\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_]+)*$/, /^model_reasoning_summary$/, /^model_verbosity$/, /^service_tier$/, /^model_context_window$/, /^model_auto_compact_token_limit$/];

const GEMINI: Flags = {
  "--debug": "flag",
  "-d": "flag",
  "--proxy": "value",
  "--sandbox": "flag",
  "-s": "flag",
  "--screen-reader": "flag",
};

const ALLOWED: Record<CliId, Flags> = { claude: CLAUDE, codex: CODEX, gemini: GEMINI };

/** The first instance argument that isn't allowed in a read-only turn, or null when all are. */
export function wallBreakingArg(cli: CliId, args: string[]): string | null {
  const flags = ALLOWED[cli];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) return arg;
    const eq = arg.indexOf("=");
    const name = eq > 0 && arg.startsWith("--") ? arg.slice(0, eq) : arg;
    const kind = flags[name];
    if (!kind) return arg;
    let value: string | undefined;
    if (kind === "value") {
      if (name !== arg) value = arg.slice(eq + 1);
      else {
        value = args[++i];
        if (value === undefined || value.startsWith("-")) return arg;
      }
    } else if (name !== arg) return arg;
    if (cli === "codex" && (name === "-c" || name === "--config")) {
      const key = (value ?? "").split("=")[0].trim();
      if (!CODEX_CONFIG_KEYS.some((re) => re.test(key))) return `${name} ${value}`;
    }
  }
  return null;
}

export function wallBreakingMessage(cli: CliId, arg: string): string {
  return `This connection’s launch arguments could let ${cliName(cli)} change files or reach beyond the space, so nothing was sent: ${arg}. Remove them in Settings › Assistant, or turn on full access for this space.`;
}
