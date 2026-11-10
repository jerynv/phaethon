/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from "electron";

/**
 * The renderer's whole view of the desktop shell: a way to get a MessagePort
 * to the core, and the platform name for title-bar layout. No Node, no
 * filesystem, no credentials.
 *
 * A MessagePort can't cross the context bridge, so it is handed to the page
 * with window.postMessage (same window, own origin only).
 */
ipcRenderer.on("phaethon:port", (event) => {
  window.postMessage({ phaethon: "core-port" }, window.location.origin, event.ports);
});

contextBridge.exposeInMainWorld("phaethonDesktop", {
  connect: (): void => ipcRenderer.send("phaethon:connect"),
  platform: process.platform,
});
