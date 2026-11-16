import { invoke } from "@/lib/core";

/** The Files view's calls to the core (`src/server/files/commands.ts`). */

export type FileSort = "name" | "modified" | "size" | "type";
export const SORTS: { value: FileSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Last modified" },
  { value: "size", label: "Size" },
  { value: "type", label: "Type" },
];

export type FileEntry = {
  name: string;
  /** Relative to the space, "/" separated. */
  path: string;
  dir: boolean;
  size: number;
  modified: number;
  /** A folder's visible entries. */
  count?: number;
  /** In a folder Phaethon's agent may not read. */
  excluded?: boolean;
};

export type FolderPage = {
  path: string;
  entries: FileEntry[];
  total: number;
  offset: number;
};
export type Found = { entries: FileEntry[]; truncated: boolean };
export type Touched = {
  path: string;
  how: "read" | "wrote" | "attached";
  at: number;
  size: number;
  modified: number;
};
export type FilesSettings = {
  showHidden: boolean;
  sort: FileSort;
  excluded: string[];
  canTrash: boolean;
};

export const PAGE = 500;

export const filesList = (space: string, path: string, sort: FileSort, desc: boolean, offset = 0, limit = PAGE) =>
  invoke<FolderPage>("files_list", { space, path, sort, desc, offset, limit });
export const filesFind = (space: string, query: string) => invoke<Found>("files_find", { space, query });
export const filesRecent = (space: string) => invoke<Found>("files_recent", { space });
export const filesRelevant = (space: string) => invoke<Touched[]>("files_relevant", { space });
export const filesSettings = (space: string) => invoke<FilesSettings>("files_settings", { space });
export const setFilesSettings = (space: string, patch: { showHidden?: boolean; sort?: FileSort; excluded?: string[] }) =>
  invoke<FilesSettings>("files_settings_set", { space, ...patch });
export const fileRename = (space: string, path: string, name: string) => invoke<{ path: string }>("file_rename", { space, path, name });
export const fileMove = (space: string, path: string, to: string) => invoke<{ path: string }>("file_move", { space, path, to });
export const folderCreate = (space: string, parent: string, name: string) => invoke<{ path: string }>("folder_create", { space, parent, name });
export const fileDelete = (space: string, path: string) => invoke<{ trashed: boolean }>("file_delete", { space, path });
export const filesUpload = (space: string, folder: string, files: { name: string; data: string }[]) =>
  invoke<{ paths: string[] }>("files_upload", { space, folder, files });

/** The folder a path is in ("" for the space itself). */
export const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** "12 items", "1 item". */
export const itemCount = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;
