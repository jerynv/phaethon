/**
 * The Anthropic API key, shared by Settings › Assistant and the first-run card:
 * check a pasted key, save it only when it works (or the person says to), and
 * say what happened in plain words. Also the links and model names both show.
 */
import { checkApiKey, setApiKey, type KeyProblem } from "@/lib/backend";

export const CONSOLE_KEYS_URL = "https://console.anthropic.com/settings/keys";
export const CONSOLE_BILLING_URL = "https://console.anthropic.com/settings/billing";
export const ANTHROPIC_PRIVACY_URL = "https://www.anthropic.com/legal/privacy";

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
  if (o.kind === "saved") return `Your key works. It’s saved in ${KEY_STORE}.`;
  if (o.kind === "no-credit")
    return "Your key is saved, but your Anthropic account has no credit yet, so Phaethon can’t answer. Add credit under Billing in the Anthropic console; nothing else needs changing here.";
  switch (o.problem) {
    case "empty":
      return "Paste your key first. It starts with sk-ant-.";
    case "format":
      return "That doesn’t look like an Anthropic API key, so it wasn’t saved. A key starts with sk-ant- and is one long line. Copy it again from the Anthropic console.";
    case "rejected":
      return "Anthropic didn’t accept this key, so it wasn’t saved. It may have a typo or have been deleted. Create a new key in the Anthropic console and paste it here.";
    case "network":
      return "Phaethon couldn’t reach Anthropic to check this key, so it wasn’t saved. Check your internet connection and try again, or save it without checking.";
    case "unchecked":
      return "Phaethon couldn’t check this key, so it wasn’t saved. Try again, or save it without checking.";
    case "billing":
      // Only when billing comes back with ok: false and the save then failed.
      return "Your Anthropic account has no credit yet. Add credit under Billing in the Anthropic console.";
    case "not-saved":
      return `The key works, but it couldn’t be saved in ${KEY_STORE}.${o.detail ? ` ${o.detail}` : ""}`;
  }
}

/** The problems a person can get past by saving without the check. */
export const canSaveUnchecked = (o: KeyOutcome | null) => o?.kind === "problem" && (o.problem === "network" || o.problem === "unchecked");

/**
 * Check the key, then save it if it works. A key that is real but whose
 * account has no credit is saved too: adding credit is done at Anthropic, and
 * the person should not have to paste the key again afterwards.
 * `skipCheck` saves without checking (after a network failure).
 */
export async function checkAndSave(raw: string, skipCheck = false): Promise<KeyOutcome> {
  const key = raw.trim();
  if (!key) return { kind: "problem", problem: "empty" };
  let noCredit = false;
  if (!skipCheck) {
    try {
      const r = await checkApiKey(key);
      if (!r.ok) {
        if (r.problem === "billing") noCredit = true;
        else return { kind: "problem", problem: r.problem ?? "rejected", detail: r.message };
      }
    } catch (e) {
      return { kind: "problem", problem: "unchecked", detail: String(e) };
    }
  }
  try {
    await setApiKey(key);
  } catch (e) {
    return { kind: "problem", problem: "not-saved", detail: String(e) };
  }
  return noCredit ? { kind: "no-credit" } : { kind: "saved" };
}
