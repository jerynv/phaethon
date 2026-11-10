/**
 * Typed calls for Settings › Coding agents: CLI status, the CLI's own sign-in,
 * instances (named homes), model catalogs and reasoning, the space's
 * workspace folder, full access and grants between spaces (research
 * core-head §1.2, §1.5; cli.md §2, §5, §8, §9). Phaethon never handles a
 * CLI's credentials: sign-in always runs the CLI's own login.
 */
import { invoke } from "@/lib/core";

import type { CliId } from "../providers/api";

export type { CliId };

/** `CliInfo`: whether a CLI is on this computer, and (where it can say without a real question) signed in. */
export type CliStatus = {
  id: CliId | "opencode";
  name: string;
  installed: boolean;
  loggedIn: boolean | null;
  loginCommand: string;
  supported: boolean;
  ownHome: boolean;
};
export type SignInOutcome = { status: "signedIn" | "notSignedIn" | "cancelled" | "busy" | "missing"; message: string };
export type InstanceConfig = { id: string; cli: CliId; name: string; binary: string; args: string[] };
export type InstanceView = {
  config: InstanceConfig;
  installed: boolean;
  loggedIn: boolean | null;
  account: string | null;
  plan: string | null;
  selected: boolean;
  managedHome: boolean;
  source: "system" | "managed";
  readOnly: boolean;
};
export type UsageWindow = { label: string; usedPercent: number; resetsAt: string | number | null };
export type Usage = { available: boolean; windows: UsageWindow[]; reason: string | null };
export type CliModel = {
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
};
export type CliModels = { models: CliModel[]; note?: string; defaultModel?: string };

export type GrantView = { id: string; from: string; path: string; created: string; scope: "always" | "once" };
export type IncomingGrantView = { id: string; to: string; path: string; created: string; scope: "always" | "once" };
export type GrantsView = { grants: GrantView[]; incoming: IncomingGrantView[]; problems: string[] };

export type WorkspaceView = { path: string; kind: "folder" | "managed"; available: boolean };
export type WorkspaceChoice = { token: string; path: string; name: string };

export const cliStatuses = () => invoke<CliStatus[]>("agent_clis_status");
export const listInstances = () => invoke<InstanceView[]>("agent_instances_list");
export const saveInstance = (instance: InstanceConfig) => invoke<InstanceConfig>("agent_instance_save", { instance });
/** Makes this instance its CLI's account, and that CLI the one that answers. */
export const selectInstance = (id: string) => invoke<void>("agent_instance_select", { id });
export const removeInstance = (id: string) => invoke<void>("agent_instance_remove", { id });
/** Runs the CLI's own sign-in (it opens the browser itself); resolves when the person finishes or cancels. */
export const signInInstance = (id: string) => invoke<SignInOutcome>("agent_instance_sign_in", { id });
export const cancelInstanceSignIn = (id: string) => invoke<boolean>("agent_instance_sign_in_cancel", { id });
export const signOutInstance = (id: string) => invoke<void>("agent_instance_sign_out", { id });
export const instanceUsage = (id: string) => invoke<Usage>("agent_instance_usage", { id });
export const instanceModels = (id: string) => invoke<CliModels>("agent_instance_models", { id });

export const getSpaceModel = (space: string) => invoke<string | null>("space_model_get", { space });
export const getReasoning = (space: string, cli: CliId, model: string | null) => invoke<string | null>("space_reasoning_get", { space, cli, model });
export const setReasoning = (space: string, cli: CliId, model: string | null, effort: string | null) =>
  invoke<void>("space_reasoning_set", { space, cli, model, effort });

export const listGrants = (space: string) => invoke<GrantsView>("grants_list", { space });
export const revokeGrant = (id: string) => invoke<boolean>("grant_revoke", { id });
export const restoreGrant = (id: string) => invoke<void>("grant_restore", { id });

export const fullAccessList = () => invoke<string[]>("full_access_list");
export const setFullAccess = (id: string, on: boolean) => invoke<boolean>("full_access_set", { id, on });

export const getWorkspace = (id: string) => invoke<WorkspaceView>("space_workspace_get", { id });
/** Only the native folder picker approves a folder; the renderer never sends a path. */
export const chooseWorkspace = () => invoke<WorkspaceChoice | null>("workspace_choose", { token: crypto.randomUUID() });
export const bindWorkspace = (id: string, token: string) => invoke<WorkspaceView>("space_workspace_bind", { id, token });
export const clearWorkspace = (id: string) => invoke<WorkspaceView>("space_workspace_clear", { id });

/** Each CLI's name, maker, install command and docs. */
export const CLI_INFO: Readonly<Record<CliId, { name: string; company: string; install: string; docs: string }>> = {
  claude: {
    name: "Claude Code",
    company: "Anthropic",
    install: "npm install -g @anthropic-ai/claude-code",
    docs: "https://docs.anthropic.com/en/docs/claude-code/setup",
  },
  codex: {
    name: "Codex",
    company: "OpenAI",
    install: "npm install -g @openai/codex",
    docs: "https://developers.openai.com/codex/cli",
  },
  gemini: {
    name: "Gemini CLI",
    company: "Google",
    install: "npm install -g @google/gemini-cli",
    docs: "https://github.com/google-gemini/gemini-cli",
  },
};
export const CLI_IDS: readonly CliId[] = ["claude", "codex", "gemini"];
