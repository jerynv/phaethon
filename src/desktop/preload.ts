import { contextBridge, ipcRenderer } from "electron";

/**
 * The renderer's whole view of the desktop shell: where the core is, plus a
 * few window-level niceties. No Node, no filesystem, no credentials.
 */
contextBridge.exposeInMainWorld("phaethonDesktop", {
  connection: (): Promise<{ url: string; token: string }> => ipcRenderer.invoke("phaethon:connection"),
  platform: process.platform,
});
