import { invoke } from "@tauri-apps/api/core";
import { NEW_SPACE_EVENT } from "./chat-actions";

export type WorkspaceChoice = { token: string; path: string; name: string };
export type WorkspaceLocation = { path: string; kind: "folder" | "managed"; available: boolean };
export const WORKSPACE_CHANGED = "phaethon:workspace-changed";

/** Only the native folder picker can approve a root; the renderer never submits a path. */
export const chooseWorkspace = () => invoke<WorkspaceChoice | null>("workspace_choose", { token: crypto.randomUUID() });
export const getWorkspace = (id: string) => invoke<WorkspaceLocation>("space_workspace_get", { id });
export async function bindWorkspace(id: string, choice: WorkspaceChoice) {
  const result = await invoke<WorkspaceLocation>("space_workspace_bind", { id, token: choice.token });
  window.dispatchEvent(new Event(WORKSPACE_CHANGED));
  return result;
}
export async function clearWorkspace(id: string) {
  const result = await invoke<WorkspaceLocation>("space_workspace_clear", { id });
  window.dispatchEvent(new Event(WORKSPACE_CHANGED));
  return result;
}
export async function startWorkspaceFromFolder() {
  const choice = await chooseWorkspace();
  if (choice) window.dispatchEvent(new CustomEvent(NEW_SPACE_EVENT, { detail: { workspaceChoice: choice } }));
}
