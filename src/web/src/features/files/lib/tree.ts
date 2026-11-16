import type { FileEntry } from "../api";

/** What the view holds for one folder it has asked the core for. */
export type FolderState = {
  entries: FileEntry[];
  total: number;
  loading: boolean;
  error: string | null;
};

/** One line of the windowed tree. `level` starts at 1 for the folder on show. */
export type Row =
  | {
      kind: "entry";
      key: string;
      entry: FileEntry;
      level: number;
      parent: string;
      expanded: boolean;
      setSize: number;
      pos: number;
    }
  | { kind: "loading"; key: string; level: number; parent: string }
  | {
      kind: "error";
      key: string;
      level: number;
      parent: string;
      message: string;
    }
  | { kind: "more"; key: string; level: number; parent: string; left: number }
  | { kind: "empty"; key: string; level: number; parent: string };

/**
 * The tree as rows, depth first: the folder on show's entries, and under each
 * expanded folder its own (a loading, error or empty line while it has none,
 * a "Show more" line when the core has more than were loaded).
 */
export function flatten(folders: Record<string, FolderState | undefined>, root: string, expanded: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  const walk = (folder: string, level: number, depth: number) => {
    const f = folders[folder];
    if (!f || (f.loading && !f.entries.length)) {
      if (level > 1)
        out.push({
          kind: "loading",
          key: `${folder}\u0000loading`,
          level,
          parent: folder,
        });
      return;
    }
    if (f.error && !f.entries.length) {
      out.push({
        kind: "error",
        key: `${folder}\u0000error`,
        level,
        parent: folder,
        message: f.error,
      });
      return;
    }
    if (!f.entries.length) {
      if (level > 1)
        out.push({
          kind: "empty",
          key: `${folder}\u0000empty`,
          level,
          parent: folder,
        });
      return;
    }
    f.entries.forEach((entry, i) => {
      const open = entry.dir && expanded.has(entry.path);
      out.push({
        kind: "entry",
        key: entry.path,
        entry,
        level,
        parent: folder,
        expanded: open,
        setSize: f.total,
        pos: i + 1,
      });
      // A folder can't hold itself, but a depth cap keeps a bad answer from looping.
      if (open && depth < 64) walk(entry.path, level + 1, depth + 1);
    });
    if (f.total > f.entries.length)
      out.push({
        kind: "more",
        key: `${folder}\u0000more`,
        level,
        parent: folder,
        left: f.total - f.entries.length,
      });
  };
  walk(root, 1, 0);
  return out;
}

/** Flat lists (a search, Recent, Used in chats) as rows at one level. */
export function flatRows(entries: FileEntry[]): Row[] {
  return entries.map((entry, i) => ({
    kind: "entry",
    key: entry.path,
    entry,
    level: 1,
    parent: "",
    expanded: false,
    setSize: entries.length,
    pos: i + 1,
  }));
}

/** The index of the row a key names, or -1. */
export const indexOfKey = (rows: Row[], key: string | null) => (key === null ? -1 : rows.findIndex((r) => r.key === key));
