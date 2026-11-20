export type Appearance = "system" | "light" | "dark";
export const APPEARANCE_KEY = "phaethon.telemetry.appearance";
export function readAppearance(): Appearance {
  try { const value = localStorage.getItem(APPEARANCE_KEY); if (value === "light" || value === "dark") return value; } catch { /* In a private window the preference lasts for the page. */ }
  return "system";
}
export let appearance = readAppearance();
export function applyAppearance(value: Appearance) {
  appearance = value;
  document.documentElement.classList.toggle("dark", value === "dark" || (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
}
applyAppearance(appearance);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyAppearance(appearance));

