import { create } from "zustand";
import { errorText } from "@/lib/core";
import { applySpaceHue } from "@/lib/appearance";
import { api, type SpaceView } from "./api";
import { useNav } from "./nav";

/**
 * The vault's spaces, most recently used first (the core's order). The shell
 * loads them once and after every change made here; other features read them
 * through `useSpaces()` and `useCurrentSpace()`.
 */
type SpacesState = {
  spaces: SpaceView[];
  status: "loading" | "ready" | "error";
  error: string | null;
  load(): Promise<void>;
  create(input: { name: string; description?: string; hue?: number; educationEnabled?: boolean }): Promise<SpaceView>;
  update(id: string, patch: { name?: string; description?: string; hue?: number; educationEnabled?: boolean }): Promise<SpaceView>;
};

const LAST_SPACE_KEY = "phaethon.last-space";

export function rememberedSpace(): string | null {
  try {
    return localStorage.getItem(LAST_SPACE_KEY);
  } catch {
    return null;
  }
}

export function rememberSpace(id: string): void {
  try {
    localStorage.setItem(LAST_SPACE_KEY, id);
  } catch {
    // Not essential.
  }
}

export const useSpaces = create<SpacesState>((set, get) => ({
  spaces: [],
  status: "loading",
  error: null,
  async load() {
    try {
      const spaces = await api.spaces();
      set({ spaces, status: "ready", error: null });
      const nav = useNav.getState();
      if (spaces.length > 0 && !spaces.some((s) => s.id === nav.spaceId)) {
        const remembered = rememberedSpace();
        const next = spaces.find((s) => s.id === remembered) ?? spaces[0];
        nav.go({ kind: "chat" }, next.id);
      }
    } catch (e) {
      set({ status: get().spaces.length > 0 ? "ready" : "error", error: errorText(e) });
    }
  },
  async create(input) {
    const space = await api.createSpace({
      name: input.name,
      description: input.description || null,
      hue: input.hue ?? null,
      educationEnabled: input.educationEnabled ?? false,
    });
    set((s) => ({ spaces: [space, ...s.spaces.filter((x) => x.id !== space.id)] }));
    return space;
  },
  async update(id, patch) {
    const space = await api.updateSpace({ id, ...patch });
    set((s) => ({ spaces: s.spaces.map((x) => (x.id === id ? space : x)) }));
    return space;
  },
}));

/** The space on screen, once the list has loaded. */
export function useCurrentSpace(): SpaceView | undefined {
  const spaceId = useNav((s) => s.spaceId);
  return useSpaces((s) => s.spaces.find((x) => x.id === spaceId));
}

/** Switch to a space: its chat (or the view given), its accent, and a note that it was used. */
export function switchSpace(id: string, view: Parameters<ReturnType<typeof useNav.getState>["go"]>[0] = { kind: "chat" }): void {
  const nav = useNav.getState();
  if (nav.spaceId === id && view.kind === nav.view.kind) return;
  nav.go(view, id);
  rememberSpace(id);
  const hue = useSpaces.getState().spaces.find((s) => s.id === id)?.hue;
  applySpaceHue(hue);
  void api.touchSpace(id).catch(() => {});
}

/** Spaces a person may name (60 characters, no line breaks), as the core checks them. */
export function nameProblem(name: string): string | null {
  const t = name.trim();
  if (!t) return "A space needs a name.";
  if ([...t].length > 60) return "A space’s name can be at most 60 characters.";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) return "A space’s name can’t contain line breaks or tabs.";
  return null;
}

export function descriptionProblem(text: string): string | null {
  const t = text.trim();
  if ([...t].length > 160) return "A description can be at most 160 characters.";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) return "A description can’t contain line breaks or tabs.";
  return null;
}

/** Soft hues offered for a space (the old accent presets). */
export const HUE_PRESETS = [
  { label: "Sea", value: 168 },
  { label: "Lagoon", value: 200 },
  { label: "Sky", value: 240 },
  { label: "Iris", value: 280 },
  { label: "Orchid", value: 320 },
  { label: "Rose", value: 10 },
  { label: "Clay", value: 50 },
  { label: "Moss", value: 130 },
] as const;

export function hueName(h: number): string {
  let best: { label: string; value: number } = HUE_PRESETS[0];
  let bestD = 360;
  for (const p of HUE_PRESETS) {
    const d = Math.min(Math.abs(p.value - h), 360 - Math.abs(p.value - h));
    if (d < bestD) [best, bestD] = [p, d];
  }
  return bestD <= 12 ? best.label : `Hue ${Math.round(h)}`;
}
