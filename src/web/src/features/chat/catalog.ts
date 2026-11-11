import { create } from "zustand";
import { errorText, invoke } from "@/lib/core";
import { CLI_INFO, type CliModels, type CliStatus } from "@/features/settings/agents/api";
import { getSettings, listModels, SETTINGS_CHANGED_EVENT, type ModelInfo, type ProviderId, type Settings } from "@/features/settings/providers/api";
import { isAdded, providerModel, readableModel, splitRef, toRef } from "@/features/settings/providers/logic";
import type { Backend, ModelPick } from "./api";

/**
 * What the composer's model picker offers: every provider set up for
 * Phaethon's own agent and every coding agent on this computer, each with its
 * models (loaded when first needed) and the reasoning levels a model takes.
 */

export type CatalogModel = {
  /** The pick this row makes (effort filled in by the picker). */
  backend: Backend;
  model: string | null;
  name: string;
  efforts: string[];
  defaultEffort?: string;
};

export type CatalogGroup = {
  id: string;
  name: string;
  backend: Backend;
  /** What still has to happen before it can answer, or null when ready. */
  need: string | null;
  needAction?: "providers" | "agents";
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  note?: string;
  models: CatalogModel[];
};

type Catalog = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  settings?: Settings;
  groups: CatalogGroup[];
  load(force?: boolean): Promise<void>;
  loadModels(groupId: string): Promise<void>;
};

const OWN_EFFORTS = ["low", "medium", "high"];
const CLI_BACKEND = { claude: "claude-cli", codex: "codex-cli", gemini: "gemini-cli" } as const;

function ownModels(provider: ProviderId, list: ModelInfo[]): CatalogModel[] {
  return list.map((m) => ({
    backend: "phaethon",
    model: toRef(provider, m.id),
    name: m.name || readableModel(m.id),
    efforts: provider === "anthropic" ? OWN_EFFORTS : (m.reasoningEfforts ?? []).filter((e) => OWN_EFFORTS.includes(e)),
    defaultEffort: provider === "anthropic" ? "medium" : m.defaultReasoningEffort,
  }));
}

function cliModels(cli: "claude" | "codex" | "gemini", catalog: CliModels): CatalogModel[] {
  const backend = CLI_BACKEND[cli];
  const rows: CatalogModel[] = catalog.models.map((m) => ({
    backend,
    model: m.id,
    name: m.name || m.id,
    efforts: m.reasoningEfforts ?? [],
    defaultEffort: m.defaultReasoningEffort,
  }));
  const def = catalog.models.find((m) => m.id === catalog.defaultModel);
  return [{ backend, model: null, name: `${CLI_INFO[cli].name} default`, efforts: def?.reasoningEfforts ?? [], defaultEffort: def?.defaultReasoningEffort }, ...rows];
}

export const useCatalog = create<Catalog>((set, get) => ({
  status: "idle",
  groups: [],

  async load(force = false) {
    if (!force && (get().status === "loading" || get().status === "ready")) return;
    set({ status: "loading", error: undefined });
    try {
      const [settings, clis] = await Promise.all([getSettings(), invoke<CliStatus[]>("agent_clis_status").catch(() => [] as CliStatus[])]);
      const prev = new Map(get().groups.map((g) => [g.id, g]));
      const own: CatalogGroup[] = settings.providers
        .filter((p) => isAdded(p) || p.id === settings.provider || p.id === "anthropic")
        .sort((a, b) => Number(b.id === settings.provider) - Number(a.id === settings.provider))
        .map((p) => {
          const old = prev.get(p.id);
          const chosen = providerModel(p, settings);
          return {
            id: p.id,
            name: p.name,
            backend: "phaethon" as Backend,
            need: p.ready ? null : p.key === "required" && !p.hasKey ? "Needs an API key" : "Not set up",
            needAction: "providers" as const,
            status: old && !force ? old.status : "idle",
            error: old?.error,
            models: old && !force ? old.models : chosen ? ownModels(p.id, [{ id: chosen, name: readableModel(chosen) }]) : [],
          };
        });
      const agents: CatalogGroup[] = clis
        .filter((c): c is CliStatus & { id: "claude" | "codex" | "gemini" } => c.id !== "opencode" && c.supported)
        .map((c) => {
          const id = CLI_BACKEND[c.id];
          const old = prev.get(id);
          return {
            id,
            name: CLI_INFO[c.id].name,
            backend: id,
            need: !c.installed ? "Not installed" : c.loggedIn === false ? "Not signed in" : null,
            needAction: "agents" as const,
            status: old && !force ? old.status : "idle",
            error: old?.error,
            models: old && !force ? old.models : [],
          };
        });
      set({ status: "ready", settings, groups: [...own, ...agents] });
    } catch (e) {
      set({ status: "error", error: errorText(e) });
    }
  },

  async loadModels(groupId) {
    const g = get().groups.find((x) => x.id === groupId);
    if (!g || g.status === "loading" || g.status === "ready") return;
    const patch = (p: Partial<CatalogGroup>) => set((s) => ({ groups: s.groups.map((x) => (x.id === groupId ? { ...x, ...p } : x)) }));
    patch({ status: "loading", error: undefined });
    try {
      if (g.backend === "phaethon") {
        const list = await listModels(g.id as ProviderId);
        const models = ownModels(g.id as ProviderId, list);
        // Keep the provider's chosen model even if the list doesn't name it.
        const keep = g.models.filter((m) => !models.some((x) => x.model === m.model));
        patch({ status: "ready", models: [...keep, ...models] });
      } else {
        const cli = g.backend.slice(0, -4) as "claude" | "codex" | "gemini";
        const catalog = await invoke<CliModels>("agent_cli_models", { cli });
        patch({ status: "ready", models: cliModels(cli, catalog), note: catalog.note });
      }
    } catch (e) {
      patch({ status: "error", error: errorText(e) });
    }
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener(SETTINGS_CHANGED_EVENT, () => void useCatalog.getState().load(true));
}

/** The group a pick belongs to (its provider, or its coding agent). */
export function groupIdOf(pick: ModelPick): string {
  if (pick.backend !== "phaethon") return pick.backend;
  return pick.model ? splitRef(pick.model).provider : (useCatalog.getState().settings?.provider ?? "anthropic");
}

/** The catalog row for a pick, if it's loaded. */
export function findModel(groups: CatalogGroup[], pick: ModelPick): CatalogModel | undefined {
  return groups.find((g) => g.id === groupIdOf(pick))?.models.find((m) => m.model === pick.model);
}

/** A pick's model as words: "Claude Opus 5.5", "gpt-5.5", "Claude Code default". */
export function pickName(groups: CatalogGroup[], pick: ModelPick): string {
  const found = findModel(groups, pick);
  if (found) return found.name;
  if (pick.backend === "phaethon") return pick.model ? readableModel(splitRef(pick.model).model) : "Default model";
  const cli = pick.backend.slice(0, -4) as "claude" | "codex" | "gemini";
  return pick.model ?? `${CLI_INFO[cli].name} default`;
}

export const EFFORT_LABEL: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
