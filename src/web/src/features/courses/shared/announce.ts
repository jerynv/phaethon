/**
 * A polite (or assertive) live region for async results that have no visible
 * spot to land in: a finished import, a saved rating, a timer phase. One
 * region per politeness, made on first use; nothing happens outside a page.
 */
const regions = new Map<string, HTMLElement>();

export function announce(text: string, politeness: "polite" | "assertive" = "polite"): void {
  if (typeof document === "undefined" || !text) return;
  let el = regions.get(politeness);
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.setAttribute("aria-live", politeness);
    el.setAttribute("aria-atomic", "true");
    el.setAttribute("data-edu-announcer", politeness);
    el.className = "sr-only";
    document.body.append(el);
    regions.set(politeness, el);
  }
  const target = el;
  // Cleared first, so the same words said twice are heard twice.
  target.textContent = "";
  setTimeout(() => (target.textContent = text), 60);
}
