import { create } from "zustand";

import { errorText } from "@/lib/core";

import { getSettings, listModels, listSpaceModels, listSpaces, type ModelInfo, type ProviderId, type Settings, type SpaceView } from "./api";

/** A provider's model list as last asked: loading, its models, or the core's sentence for why not. */
export type ModelList = { status: "loading" | "ready" | "error"; models: ModelInfo[]; error?: string };

type AssistantState = {
  status: "loading" | "ready" | "error";
  error: string;
  settings: Settings | null;
  spaces: SpaceView[];
  /** Space id → its own model reference (for the backend that answers now). */
  spaceModels: Record<string, string>;
  models: Partial<Record<ProviderId, ModelList>>;
  /** Reads the settings, the spaces and their own models again. */
  load(): Promise<boolean>;
  /** A provider's models, asked once (or again with `force`). */
  loadModels(provider: ProviderId, force?: boolean): Promise<void>;
};

export const useAssistant = create<AssistantState>((set, get) => ({
  status: "loading",
  error: "",
  settings: null,
  spaces: [],
  spaceModels: {},
  models: {},
  async load() {
    // Spaces and their models are read even when the settings can't be.
    const [spaces, spaceModels] = await Promise.all([listSpaces().catch(() => get().spaces), listSpaceModels().catch(() => get().spaceModels)]);
    set({ spaces, spaceModels });
    try {
      const settings = await getSettings();
      set({ status: "ready", error: "", settings });
      return true;
    } catch (e) {
      set({ status: get().settings ? "ready" : "error", error: errorText(e) });
      return false;
    }
  },
  async loadModels(provider, force = false) {
    const had = get().models[provider];
    if (had && (had.status === "loading" || (!force && had.status === "ready"))) return;
    set((s) => ({ models: { ...s.models, [provider]: { status: "loading", models: had?.models ?? [] } } }));
    try {
      const models = await listModels(provider);
      set((s) => ({ models: { ...s.models, [provider]: { status: "ready", models } } }));
    } catch (e) {
      set((s) => ({ models: { ...s.models, [provider]: { status: "error", models: had?.models ?? [], error: errorText(e) } } }));
    }
  },
}));
