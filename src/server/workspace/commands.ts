import path from "node:path";
import { commands, Refusal } from "../rpc/registry.ts";
import { host } from "../host.ts";
import { isRunning } from "../core/runs.ts";
import { spaceDir } from "../core/vault.ts";
import { clearSession } from "../threads/store.ts";
import { bindWorkspace, clearWorkspace, getWorkspace } from "./workspace.ts";

/**
 * The folder picker runs in the desktop shell; the renderer only names a
 * one-time token, and binding consumes the folder chosen under it. The
 * renderer never supplies a path.
 */
const MAX_CHOICES = 16;
const choices: { token: string; path: string }[] = [];

export function resetWorkspaceChoices(): void {
  choices.length = 0;
}

commands({
  space_workspace_get: ({ id }: { id: string }) => getWorkspace(id, spaceDir(id)),

  workspace_choose: async ({ token }: { token: string }) => {
    if (typeof token !== "string" || token.length !== 36 || !/^[0-9A-Fa-f-]+$/.test(token)) throw new Refusal("Invalid folder choice.");
    const picked = await host().call<string | null>({ op: "pickFolder", title: "Choose a workspace folder" });
    if (!picked) return null;
    if (typeof picked !== "string" || !path.isAbsolute(picked)) throw new Refusal("That folder is not on this computer.");
    const name = path.basename(picked) || "Project";
    const i = choices.findIndex((c) => c.token === token);
    if (i >= 0) choices.splice(i, 1);
    if (choices.length >= MAX_CHOICES) choices.shift();
    choices.push({ token, path: picked });
    return { token, path: picked, name };
  },

  space_workspace_bind: ({ id, token }: { id: string; token: string }) => {
    spaceDir(id);
    if (isRunning(id)) throw new Refusal("Stop the reply before changing its workspace.");
    const at = choices.findIndex((c) => c.token === token);
    if (at < 0) throw new Refusal("Choose the folder again.");
    const view = bindWorkspace(id, choices[at]!.path);
    // A failed bind stays retryable; a successful one uses the choice up.
    choices.splice(at, 1);
    clearSession(id);
    return view;
  },

  space_workspace_clear: ({ id }: { id: string }) => {
    const dir = spaceDir(id);
    if (isRunning(id)) throw new Refusal("Stop the reply before changing its workspace.");
    const view = clearWorkspace(id, dir);
    clearSession(id);
    return view;
  },
});
