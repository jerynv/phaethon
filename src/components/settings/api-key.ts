/**
 * The Anthropic API key, shared by Settings › Assistant and the first-run card:
 * check a pasted key, save it only when it works (or the person says to), and
 * say what happened in plain words. Also the links and model names both show.
 */
import { checkApiKey, setApiKey, type KeyProblem, type ProviderId } from "@/lib/backend";

export const CONSOLE_KEYS_URL = "https://console.anthropic.com/settings/keys";
export const CONSOLE_BILLING_URL = "https://console.anthropic.com/settings/billing";

/** Where the key lives, in words a non-technical person knows. */
export const KEY_STORE = "this computer’s password store (Keychain)";

/** The model Phaethon uses when none is chosen (mirrors the core's default). */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** "claude-opus-5-5" → "Claude Opus 5.5": for an id the model list did not name. */
export function readableModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `Claude ${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** The result of Check and save. `saved` says whether the key is now stored. */
export type KeyOutcome =
  | { kind: "saved" }
  /** Saved: the key is real, but the account needs credit before it can answer. */
  | { kind: "no-credit" }
  | { kind: "problem"; problem: KeyProblem | "empty" | "unchecked" | "not-saved"; detail?: string };

export const isSaved = (o: KeyOutcome) => o.kind === "saved" || o.kind === "no-credit";

/** What to say for each outcome. One or two short sentences, the way out last. */
export function outcomeText(o: KeyOutcome): string {
  if (o.kind === "saved") return "API key saved.";
  if (o.kind === "no-credit")
    return "API key saved. Add Anthropic API credit to continue.";
  switch (o.problem) {
    case "empty":
      return "Paste your key first. It starts with sk-ant-.";
    case "format":
      return "Use an Anthropic key starting with sk-ant-. It wasn’t saved.";
    case "rejected":
      return "Anthropic rejected this key. It wasn’t saved.";
    case "network":
      return "Couldn’t reach Anthropic. Retry or save without checking.";
    case "unchecked":
      return "Couldn’t check this key. Retry or save without checking.";
    case "billing":
      // Only when billing comes back with ok: false and the save then failed.
      return "Add Anthropic API credit to continue.";
    case "not-saved":
      return `Couldn’t save the API key.${o.detail ? ` ${o.detail}` : ""}`;
  }
}

/**
 * [`outcomeText`] for any provider: Anthropic's own words for Anthropic, and
 * for the others the core's message (it names the provider and what to do).
 */
export function outcomeTextFor(o: KeyOutcome, provider: { id: ProviderId; name: string }): string {
  if (provider.id === "anthropic") return outcomeText(o);
  const name = provider.id === "custom" ? "your server" : provider.name;
  if (o.kind === "saved") return "API key saved.";
  if (o.kind === "no-credit") return `API key saved. Add ${provider.name} API credit to continue.`;
  switch (o.problem) {
    case "empty":
      return "Paste your key first.";
    case "format":
    case "rejected":
      return `${o.detail ?? `${provider.name} didn’t accept this key.`} It wasn’t saved.`;
    case "network":
      return `Couldn’t reach ${name}. Retry or save without checking.`;
    case "unchecked":
      return "Couldn’t check this key. Retry or save without checking.";
    case "billing":
      return `Add ${provider.name} API credit to continue.`;
    case "not-saved":
      return `Couldn’t save the API key.${o.detail ? ` ${o.detail}` : ""}`;
  }
}

/** The problems a person can get past by saving without the check. */
export const canSaveUnchecked = (o: KeyOutcome | null) => o?.kind === "problem" && (o.problem === "network" || o.problem === "unchecked");

/**
 * Check the key, then save it if it works. A key that is real but whose
 * account has no credit is saved too: adding credit is done at Anthropic, and
 * the person should not have to paste the key again afterwards.
 * `skipCheck` saves without checking (after a network failure); `beforeSave`
 * runs just before the key is written.
 */
export async function checkAndSave(raw: string, skipCheck = false, beforeSave?: () => void, provider: ProviderId = "anthropic"): Promise<KeyOutcome> {
  const key = raw.trim();
  if (!key) return { kind: "problem", problem: "empty" };
  let noCredit = false;
  if (!skipCheck) {
    try {
      const r = await checkApiKey(key, provider);
      if (!r.ok) {
        if (r.problem === "billing") noCredit = true;
        else return { kind: "problem", problem: r.problem ?? "rejected", detail: r.message };
      }
    } catch (e) {
      return { kind: "problem", problem: "unchecked", detail: String(e) };
    }
  }
  beforeSave?.();
  try {
    await setApiKey(key, provider);
  } catch (e) {
    return { kind: "problem", problem: "not-saved", detail: String(e) };
  }
  return noCredit ? { kind: "no-credit" } : { kind: "saved" };
}
