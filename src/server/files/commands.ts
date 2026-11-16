import path from "node:path";
import { commands, Refusal } from "../rpc/registry.ts";
import { host } from "../host.ts";
import { homeDir } from "../env.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { getSpace } from "../spaces/meta.ts";
import { addToSpace } from "./add.ts";
import { exportSpace, suggestedName } from "./export.ts";
import { openFile, revealFile, showSpace } from "./open.ts";
import { listFiles } from "./list.ts";
import { fileBytes, viewFile } from "./viewer.ts";
import { listFolder, PAGE_DEFAULT, walkSpace } from "./browse.ts";
import { canTrash, createFolder, deleteItem, moveItem, renameItem } from "./manage.ts";
import { relevantFiles } from "./relevant.ts";
import { FILE_SORTS, readFilesSettings, updateFilesSettings, type FileSort, type FilesPatch } from "./settings.ts";
import { uploadToFolder, type Dropped } from "./upload.ts";

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

  /** The space's own files, newest first (the composer's `@` mentions). */
  space_files: ({ space }: { space: string }) => listFiles(spaceDir(space)),

  /** One folder of the Files view, folders first, sorted and paged here. */
  files_list: (a: { space: string; path?: string; sort?: string; desc?: boolean; offset?: number; limit?: number }) => {
    const settings = readFilesSettings(a.space);
    const sort: FileSort = typeof a.sort === "string" && (FILE_SORTS as readonly string[]).includes(a.sort) ? (a.sort as FileSort) : settings.sort;
    return listFolder(spaceDir(a.space), String(a.path ?? ""), {
      sort,
      desc: a.desc === true,
      offset: Number(a.offset ?? 0),
      limit: Number(a.limit ?? PAGE_DEFAULT),
      showHidden: settings.showHidden,
      excluded: settings.excluded,
    });
  },

  /** Files and folders anywhere in the space whose name contains `query`. */
  files_find: ({ space, query }: { space: string; query: string }) => {
    const s = readFilesSettings(space);
    const q = String(query ?? "").trim();
    if (!q) return { entries: [], truncated: false };
    return walkSpace(spaceDir(space), { query: q, showHidden: s.showHidden, limit: 300, excluded: s.excluded });
  },

  /** The space's most recently changed files. */
  files_recent: ({ space }: { space: string }) => {
    const s = readFilesSettings(space);
    return walkSpace(spaceDir(space), { showHidden: s.showHidden, limit: 100, excluded: s.excluded });
  },

  /** Files agents recently read or wrote, and files attached to messages. */
  files_relevant: ({ space }: { space: string }) => relevantFiles(spaceDir(space)),

  files_settings: ({ space }: { space: string }) => ({ ...readFilesSettings(space), canTrash: canTrash() }),

  files_settings_set: (a: { space: string } & FilesPatch) => {
    spaceDir(a.space);
    return { ...updateFilesSettings(a.space, { showHidden: a.showHidden, sort: a.sort, excluded: a.excluded }), canTrash: canTrash() };
  },

  file_rename: ({ space, path: p, name }: { space: string; path: string; name: string }) => ({ path: renameItem(spaceDir(space), String(p ?? ""), name) }),

  file_move: ({ space, path: p, to }: { space: string; path: string; to: string }) => ({ path: moveItem(spaceDir(space), String(p ?? ""), String(to ?? "")) }),

  folder_create: ({ space, parent, name }: { space: string; parent?: string; name: string }) => ({ path: createFolder(spaceDir(space), String(parent ?? ""), name) }),

  file_delete: ({ space, path: p }: { space: string; path: string }) => deleteItem(spaceDir(space), String(p ?? "")),

  /** Files dropped on the Files view, written into `folder` (the space's files/ folder when empty). */
  files_upload: ({ space, folder, files }: { space: string; folder?: string; files: Dropped[] }) => uploadToFolder(spaceDir(space), String(folder ?? ""), files),

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
