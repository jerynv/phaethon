import path from "node:path";
import { commands, Refusal } from "../rpc/registry.ts";
import { host } from "../host.ts";
import { homeDir } from "../env.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { getSpace } from "../spaces/meta.ts";
import { addToSpace } from "./add.ts";
import { exportSpace, suggestedName } from "./export.ts";
import { openFile, revealFile, showSpace } from "./open.ts";
import { fileBytes, viewFile } from "./viewer.ts";

/** The last export's path, in memory only (as before): "Show export" names no path. */
let lastExport: string | undefined;

export function resetLastExport(): void {
  lastExport = undefined;
}

commands({
  file_open: async ({ space, path: p, reveal }: { space: string; path: string; reveal?: boolean }) => {
    const dir = spaceDir(space);
    await openFile(space, dir, String(p ?? ""), !!reveal);
    return null;
  },

  file_view: ({ space, path: p }: { space: string; path: string }) => viewFile(space, spaceDir(space), String(p ?? "")),

  file_bytes: ({ space, path: p }: { space: string; path: string }) => fileBytes(space, spaceDir(space), String(p ?? "")),

  space_show: async ({ id }: { id: string }) => {
    let dir: string;
    try {
      dir = spaceDir(id);
    } catch {
      throw new Refusal("That space isn’t in your Phaethon folder any more.");
    }
    await showSpace(dir);
    return null;
  },

  space_add: async ({ id, folder }: { id: string; folder: boolean }) => {
    const space = getSpace(id);
    const dir = spaceDir(id);
    const defaultPath = path.join(homeDir(), "Documents");
    let picked: string[];
    if (folder) {
      const one = await host().call<string | null>({ op: "pickFolder", title: `Add a folder to ${space.name}`, defaultPath });
      picked = one ? [one] : [];
    } else {
      picked = (await host().call<string[] | null>({ op: "pickFiles", title: `Add files to ${space.name}`, defaultPath, multiple: true })) ?? [];
    }
    if (!picked.length) return null;
    if (picked.some((p) => typeof p !== "string" || !path.isAbsolute(p))) throw new Refusal("Phaethon can only add files on this computer.");
    return addToSpace(dir, vaultRoot(), picked);
  },

  space_export: async ({ id }: { id: string }) => {
    const space = getSpace(id);
    const dir = spaceDir(id);
    const dest = await host().call<string | null>({
      op: "saveFile",
      title: `Export ${space.name}`,
      defaultPath: path.join(homeDir(), "Downloads", suggestedName(space.name, id)),
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!dest) return null;
    if (typeof dest !== "string" || !path.isAbsolute(dest)) throw new Refusal("Phaethon can’t save there. Choose a folder on this computer.");
    const done = await exportSpace(dir, id, dest);
    lastExport = done.file;
    return { fileName: path.basename(done.file), files: done.files };
  },

  export_show: async () => {
    if (!lastExport) throw new Refusal("There’s no export to show yet.");
    await revealFile(lastExport);
    return null;
  },
});
