import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@/lib/core";

/**
 * Light, dark or the system's choice, saved in the vault (`appearance.theme`)
 * and mirrored in localStorage so the first paint already has the right one.
 */
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "phaethon.theme";

function initial(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // ignore
  }
  return "system";
}

type Theme = { choice: ThemeChoice; appearance: Record<string, unknown>; set(choice: ThemeChoice): Promise<void>; hydrate(appearance: unknown): void };

export const useTheme = create<Theme>((set, get) => ({
  choice: initial(),
  appearance: {},
  hydrate(appearance) {
    const a = appearance && typeof appearance === "object" ? (appearance as Record<string, unknown>) : {};
    const t = a.theme;
    // The vault's choice wins; with none saved there, the one remembered on this computer stays.
    const choice: ThemeChoice = t === "light" || t === "dark" || t === "system" ? t : get().choice;
    set({ appearance: a, choice });
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // ignore
    }
  },
  async set(choice) {
    const appearance = { ...get().appearance, theme: choice };
    set({ choice, appearance });
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // ignore
    }
    await invoke("appearance_set", { appearance });
  },
}));

export function applyTheme(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Keeps `<html class="dark">` in step with the choice and the system. */
export function useApplyTheme() {
  const choice = useTheme((s) => s.choice);
  useEffect(() => {
    applyTheme(choice);
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);
}
