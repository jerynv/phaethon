import { create } from "zustand";

import { errorText } from "@/lib/core";

import {
  cancelInstanceSignIn,
  cliStatuses,
  instanceModels,
  listInstances,
  signInInstance,
  type CliModels,
  type CliStatus,
  type InstanceView,
  type SignInOutcome,
} from "./api";

/** A model catalog as last asked of an instance's CLI. */
export type CatalogState = { status: "loading" | "ready" | "error"; catalog: CliModels; error?: string };

type AgentsState = {
  status: "loading" | "ready" | "error";
  error: string;
  clis: CliStatus[];
  instances: InstanceView[];
  /** Instance ids whose CLI sign-in is waiting on the browser. Kept here so it survives Settings closing. */
  signingIn: Record<string, true>;
  /** The last sign-in result per instance, until the next attempt. */
  outcomes: Record<string, SignInOutcome | undefined>;
  catalogs: Record<string, CatalogState | undefined>;
  load(): Promise<boolean>;
  signIn(id: string): Promise<SignInOutcome | null>;
  cancelSignIn(id: string): Promise<void>;
  clearOutcome(id: string): void;
  loadCatalog(id: string, force?: boolean): Promise<void>;
};

export const useAgents = create<AgentsState>((set, get) => ({
  status: "loading",
  error: "",
  clis: [],
  instances: [],
  signingIn: {},
  outcomes: {},
  catalogs: {},
  async load() {
    try {
      const [clis, instances] = await Promise.all([cliStatuses(), listInstances()]);
      set({ status: "ready", error: "", clis, instances });
      return true;
    } catch (e) {
      set({ status: get().instances.length ? "ready" : "error", error: errorText(e) });
      return false;
    }
  },
  async signIn(id) {
    if (get().signingIn[id]) return null;
    set((s) => ({ signingIn: { ...s.signingIn, [id]: true }, outcomes: { ...s.outcomes, [id]: undefined } }));
    let outcome: SignInOutcome;
    try {
      outcome = await signInInstance(id);
    } catch (e) {
      outcome = { status: "notSignedIn", message: errorText(e) };
    }
    set((s) => {
      const { [id]: _done, ...rest } = s.signingIn;
      return { signingIn: rest, outcomes: { ...s.outcomes, [id]: outcome } };
    });
    await get().load();
    return outcome;
  },
  async cancelSignIn(id) {
    try {
      await cancelInstanceSignIn(id);
    } catch {
      // The sign-in call itself reports how it ended.
    }
  },
  clearOutcome(id) {
    set((s) => ({ outcomes: { ...s.outcomes, [id]: undefined } }));
  },
  async loadCatalog(id, force = false) {
    const had = get().catalogs[id];
    if (had && (had.status === "loading" || (!force && had.status === "ready"))) return;
    set((s) => ({ catalogs: { ...s.catalogs, [id]: { status: "loading", catalog: had?.catalog ?? { models: [] } } } }));
    try {
      const catalog = await instanceModels(id);
      set((s) => ({ catalogs: { ...s.catalogs, [id]: { status: "ready", catalog } } }));
    } catch (e) {
      set((s) => ({ catalogs: { ...s.catalogs, [id]: { status: "error", catalog: had?.catalog ?? { models: [] }, error: errorText(e) } } }));
    }
  },
}));

export { currentInstance, instanceStatus } from "./logic";
