import { createContext, use, useEffect, useSyncExternalStore } from "react";

import * as api from "./api";

/** The space the conversation on screen belongs to. */
export const SpaceContext = createContext("");
export const useSpaceId = () => use(SpaceContext);

/** The folder a Markdown text came from, so its relative links lead beside it ("" for a reply). */
export const LinkBaseContext = createContext("");

/** The key of the message a part is drawn in, and whether it is still streaming. */
export const MessageContext = createContext<{ key: string; streaming: boolean; question: string; reply: string }>({
  key: "",
  streaming: false,
  question: "",
  reply: "",
});

// ---- Spaces, read once per session and on demand ----

let spaces: api.SpaceView[] = [];
let asked = false;
const listeners = new Set<() => void>();

export function refreshSpaces(): void {
  asked = true;
  api.spacesList().then(
    (list) => {
      spaces = list;
      listeners.forEach((l) => l());
    },
    () => {},
  );
}

export function useSpaces(): api.SpaceView[] {
  useEffect(() => {
    if (!asked) refreshSpaces();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => spaces,
  );
}

/** A space by id; an id this vault doesn't have shows title-cased, with no hue. */
export function spaceInfo(list: api.SpaceView[], id: string): { name: string; hue?: number; known: boolean; education: boolean } {
  const s = list.find((x) => x.id === id);
  if (s) return { name: s.name, hue: s.hue, known: true, education: s.educationEnabled };
  return { name: id ? id.charAt(0).toUpperCase() + id.slice(1) : "this space", known: false, education: false };
}

export function useSpace(id: string) {
  return spaceInfo(useSpaces(), id);
}

// ---- Settings (backend and models), read once and when the picker opens ----

let settings: api.SettingsView | null = null;
const settingsListeners = new Set<() => void>();
let settingsAsked = false;

export function refreshSettings(): Promise<void> {
  settingsAsked = true;
  return api.settingsGet().then(
    (s) => {
      settings = s;
      settingsListeners.forEach((l) => l());
    },
    () => {},
  );
}

export function useSettings(): api.SettingsView | null {
  useEffect(() => {
    if (!settingsAsked) void refreshSettings();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },
    () => settings,
  );
}

/** A space mark: a dot in the space's own hue. */
export const hueColor = (hue: number | undefined) => (hue === undefined ? "var(--muted-foreground)" : `oklch(0.65 0.15 ${hue})`);
