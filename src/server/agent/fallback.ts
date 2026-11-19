import type { ErrorCode } from "../../shared/agent.ts";
import { CLI, CLI_IDS, INELIGIBLE_MESSAGE, isGeminiIneligible } from "../cli/cli.ts";
import * as instances from "../cli/instances.ts";
import { isExecutable } from "../cli/process.ts";
import { isTest } from "../env.ts";
import { readKey } from "../providers/build.ts";
import { baseUrl, chosen, chosenModel, defaultRef, keyFor, parseRef, PRESETS, savedRef } from "../providers/presets.ts";
import { readSettings, type Backend } from "../settings/settings.ts";
import type { ModelPick } from "../threads/pick.ts";

/**
 * Automatic model fallback: detects when a turn failed before emitting any
 * output for a provider/connectivity/auth reason, discovers other ready API
 * providers or signed-in CLIs on this machine, and formats calm labels for the
 * handoff note.
 */

const ELIGIBLE_CODES = new Set<ErrorCode>([
  "network",
  "unavailable",
  "rateLimit",
  "billing",
  "noApiKey",
  "apiKey",
  "missingCli",
  "notLoggedIn",
  "provider",
  "cli",
]);

const MODEL_OR_PROVIDER_BAD_REQUEST =
  /couldn[’']t find the model|model[_ ]not[_ ]found|does not exist|not supported|unknown model|deprecated|redirected|sent Phaethon to another address/i;

/** Whether an error before any assistant output should trigger automatic fallback. */
export function isFallbackEligible(code: ErrorCode, message: string): boolean {
  if (ELIGIBLE_CODES.has(code)) return true;
  if (code === "badRequest" && MODEL_OR_PROVIDER_BAD_REQUEST.test(message)) return true;
  return false;
}

/** Provider id for a Phaethon API pick, or null for CLI backends. */
export function phaethonProviderId(pick: ModelPick): string | null {
  if (pick.backend !== "phaethon") return null;
  const parsed = pick.model ? parseRef(pick.model) : undefined;
  return parsed?.provider.id ?? chosen(readSettings()).id;
}

/** Whether two picks target the same backend/provider (avoid retrying the same broken provider). */
export function sameModelPick(a: ModelPick, b: ModelPick): boolean {
  if (a.backend !== b.backend) return false;
  if (a.backend !== "phaethon") return a.model === b.model;
  return phaethonProviderId(a) === phaethonProviderId(b);
}

/**
 * Discovers all other ready models/providers on this machine:
 * 1. Ready Phaethon API providers (vault default first if ready, then others).
 * 2. Installed and signed-in CLI backends (`claude`, `codex`, `gemini`).
 */
export async function readyFallbackCandidates(exclude: ModelPick): Promise<ModelPick[]> {
  const out: ModelPick[] = [];
  const settings = readSettings();
  const excludedProvider = phaethonProviderId(exclude);

  // 1. Ready Phaethon API providers (configured default provider first).
  const preferred = chosen(settings);
  const orderedPresets = [preferred, ...PRESETS.filter((p) => p.id !== preferred.id)];
  for (const p of orderedPresets) {
    if (exclude.backend === "phaethon" && p.id === excludedProvider) continue;
    const model = chosenModel(settings, p);
    if (!model) continue;
    try {
      const base = baseUrl(settings, p);
      keyFor(p, base, readKey);
    } catch {
      continue;
    }
    out.push({ backend: "phaethon", model: savedRef({ provider: p, model }), effort: null });
  }

  // 2. Installed AND signed-in CLI backends (probed concurrently).
  const cliPicks = await Promise.all(
    CLI_IDS.map(async (cli): Promise<ModelPick | null> => {
      const backend: Backend = `${cli}-cli`;
      if (exclude.backend === backend) return null;
      const sel = instances.selected(cli);
      // In tests, never probe real system CLIs unless the test explicitly wired a binary.
      if (isTest() && !process.env[`PHAETHON_${cli.toUpperCase()}_BIN`] && !sel.binary) return null;
      const dir = instances.configDirFor(cli);
      if (CLI[cli].ownHome && dir === null) return null;
      const found = instances.binary(cli, dir);
      const bin = found && isExecutable(found) ? found : null;
      if (!bin) return null;
      let loggedIn: boolean | null = null;
      try {
        if (cli === "codex") loggedIn = await instances.codexLoggedIn(bin, dir);
        else loggedIn = (await instances.account(cli, dir)).loggedIn;
      } catch {
        loggedIn = null;
      }
      if (loggedIn !== true) return null;
      return { backend, model: null, effort: null };
    }),
  );

  for (const pick of cliPicks) {
    if (pick) out.push(pick);
  }
  return out;
}

function claudeShortName(model: string): string | null {
  const m = model.toLowerCase();
  if (m.includes("sonnet")) return "Claude Sonnet";
  if (m.includes("opus")) return "Claude Opus";
  if (m.includes("haiku")) return "Claude Haiku";
  return null;
}

/** Human-readable model/provider label for handoff notes and model-switch events. */
export function friendlyModelLabel(pick: ModelPick): string {
  if (pick.backend === "claude-cli") {
    if (pick.model) return claudeShortName(pick.model) ?? `Claude Code (${pick.model})`;
    return "Claude Code";
  }
  if (pick.backend === "codex-cli") return pick.model ? `Codex (${pick.model})` : "Codex";
  if (pick.backend === "gemini-cli") return pick.model ? `Gemini CLI (${pick.model})` : "Gemini CLI";
  const settings = readSettings();
  const ref = pick.model ? parseRef(pick.model) : defaultRef(settings);
  if (!ref) return chosen(settings).name;
  if (ref.provider.id === "anthropic") return claudeShortName(ref.model) ?? `Anthropic (${ref.model})`;
  if (ref.provider.id === "google") return `Google Gemini (${ref.model})`;
  return `${ref.provider.name} (${ref.model})`;
}

/** Short, calm, non-technical failure reason for handoff notes. */
export function shortFailureReason(code: ErrorCode, message: string): string {
  if (message === INELIGIBLE_MESSAGE || isGeminiIneligible(message)) return "account isn’t supported";
  switch (code) {
    case "network":
      return "couldn’t be reached";
    case "unavailable":
      return "was unavailable";
    case "rateLimit":
      return "hit its rate limit";
    case "billing":
      return "has a billing issue";
    case "notLoggedIn":
      return "isn’t signed in";
    case "missingCli":
      return "isn’t installed";
    case "noApiKey":
      return "has no API key";
    case "apiKey":
      return "rejected the API key";
    case "badRequest":
      return "couldn’t use that model";
    default: {
      if (/timed out|ECONN|ENOTFOUND|network|couldn[’']t reach/i.test(message)) return "couldn’t be reached";
      if (/rate[ _-]?limit|\b429\b|quota/i.test(message)) return "hit its rate limit";
      if (/\.gemini/i.test(message)) return "couldn’t run in this space";
      return "was unavailable";
    }
  }
}
