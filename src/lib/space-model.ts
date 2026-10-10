import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { readableModel } from "@/components/settings/api-key";

import { getSettings, listModels, SETTINGS_CHANGED_EVENT, type Backend, type ModelInfo, type SettingsChangedDetail } from "./backend";
import { inTauri } from "./tauri";

/**
 * Which model answers in each space. A space may choose its own (saved in its
 * space.json, so it syncs with the space; src-tauri/src/space_model.rs);
 * every other space uses the default model from Settings. Only Phaethon's own
 * agent uses either: Claude Code picks its own model.
 */
export type ModelsState = {
  status: "loading" | "ready" | "error";
  backend: Backend;
  /** The default model's id (Settings › Assistant). */
  defaultModel: string;
  /** Space id → the model that space chose. Spaces using the default are absent. */
  own: Readonly<Record<string, string>>;
  /** The models to choose from; the fixed list until the provider's has loaded. */
  models: readonly ModelInfo[];
};

const FALLBACK: readonly ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

let state: ModelsState = {
  status: inTauri() ? "loading" : "ready",
  backend: "phaethon",
  defaultModel: FALLBACK[0].id,
  own: {},
  models: FALLBACK,
};
const listeners = new Set<() => void>();
let modelsAsked = false;

function set(patch: Partial<ModelsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Read the backend, the default and every space's own model again. */
export async function refreshModels(): Promise<void> {
  if (!inTauri()) return;
  try {
    const [settings, own] = await Promise.all([getSettings(), invoke<Record<string, string>>("space_models_list")]);
    set({ status: "ready", backend: settings.backend, defaultModel: settings.model, own });
  } catch {
    set({ status: state.status === "ready" ? "ready" : "error" });
  }
  // The provider's list once per launch (it is a network call); the fixed list stands in until then.
  if (!modelsAsked) {
    modelsAsked = true;
    listModels().then(
      (models) => models.length && set({ models }),
      () => {},
    );
  }
}

/** The model's name for people ("Claude Sonnet 5.5"). */
export function modelName(id: string, models: readonly ModelInfo[] = state.models): string {
  return models.find((m) => m.id === id)?.name ?? readableModel(id);
}

/** The model a space answers with, and whether it is the space's own choice. */
export function modelOf(s: ModelsState, spaceId: string): { id: string; own: boolean } {
  const own = s.own[spaceId];
  return own ? { id: own, own: true } : { id: s.defaultModel, own: false };
}

/** The choices: every listed model, plus the ones in use that the list lacks, so a choice never disappears. */
export function modelChoices(s: ModelsState): ModelInfo[] {
  const list = [...s.models];
  for (const id of [s.defaultModel, ...Object.values(s.own)]) {
    if (!list.some((m) => m.id === id)) list.push({ id, name: modelName(id, s.models) });
  }
  return list;
}

/**
 * Give `spaceId` its own model, or with `null` put it back on the default.
 * Takes effect from the next message in that space; a reply already running
 * keeps the model it started with.
 */
export async function setSpaceModel(spaceId: string, model: string | null): Promise<void> {
  if (inTauri()) await invoke<void>("space_model_set", { space: spaceId, model });
  const own = { ...state.own };
  if (model) own[spaceId] = model;
  else delete own[spaceId];
  set({ own });
}

/** What was done, in words: "Work now uses Claude Opus 5.5." */
export function changedText(spaceName: string, model: string | null, s: ModelsState = state): string {
  return model
    ? `${spaceName} now uses ${modelName(model, s.models)}.`
    : `${spaceName} now uses the default model, ${modelName(s.defaultModel, s.models)}.`;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

let watching = 0;
function onChanged(e: Event) {
  // A new key may see more models.
  if ((e as CustomEvent<SettingsChangedDetail>).detail?.what === "key") modelsAsked = false;
  void refreshModels();
}

/**
 * The models state, kept fresh: read on first use, again when the backend,
 * the key or the default model changes anywhere, and when the window regains
 * focus (a synced or hand-edited space.json may have changed a space's model).
 */
export function useModels(): ModelsState {
  useEffect(() => {
    if (!inTauri()) return;
    if (watching++ === 0) {
      void refreshModels();
      window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
      window.addEventListener("focus", onChanged);
    }
    return () => {
      if (--watching > 0) return;
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", onChanged);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}
