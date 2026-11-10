/** Pure helpers for Settings › Coding agents (unit-tested in logic.test.ts). */
import type { InstanceView } from "./api";

/** The instance a CLI uses: the selected one, else its built-in. */
export function currentInstance(instances: InstanceView[], cli: string): InstanceView | undefined {
  return instances.find((i) => i.config.cli === cli && i.selected) ?? instances.find((i) => i.config.id === cli);
}

/** A short status line for an instance, in words. */
export function instanceStatus(i: InstanceView): { text: string; tone: "ready" | "warning" | "neutral" | "error" } {
  if (!i.installed) return { text: i.readOnly || i.config.id !== i.config.cli ? "Unavailable" : "Not installed", tone: "neutral" };
  if (i.loggedIn === true) return { text: [i.account ? `Signed in as ${i.account}` : "Signed in", i.plan].filter(Boolean).join(" · "), tone: "ready" };
  if (i.loggedIn === false) return { text: "Not signed in", tone: "warning" };
  return { text: "Installed", tone: "neutral" };
}
