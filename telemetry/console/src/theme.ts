export type Appearance = "system" | "light" | "dark";
const APPEARANCE_KEY = "phaethon.telemetry.appearance";

const darkScheme = matchMedia("(prefers-color-scheme: dark)");

function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // In a private window the preference lasts for the page.
  }
  return "system";
}

export let appearance = readAppearance();

function applyAppearance(value: Appearance) {
  appearance = value;
  document.documentElement.classList.toggle(
    "dark",
    value === "dark" || (value === "system" && darkScheme.matches),
  );
}

export function saveAppearance(value: Appearance) {
  applyAppearance(value);
  try {
    localStorage.setItem(APPEARANCE_KEY, value);
  } catch {
    // The page still applies it.
  }
}

applyAppearance(appearance);
darkScheme.addEventListener("change", () => applyAppearance(appearance));
