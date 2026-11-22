import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { ActionLabel, Header, useViewActive } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, EmptyState, SurfaceError } from "@/components/errors";
import { copyText } from "@/components/file-chip";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { SearchField, SearchFieldAction } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { toBase64 } from "@/features/chat/lib/attachments";
import { FileIcon } from "@/features/viewer/FileIcon";
import { fileOpen } from "@/features/viewer/api";
import { useDelayed } from "@/hooks/use-delayed";
import { fileManagerName, relativeTime } from "@/lib/platform";
import {
  baseName,
  type FileEntry,
  type FileSort,
  type FilesSettings,
  type Found,
  filesFind,
  filesList,
  filesRecent,
  filesRelevant,
  filesSettings,
  filesUpload,
  itemCount,
  PAGE,
  parentOf,
  SORTS,
  type Touched,
} from "./api";
import { Crumbs } from "./components/Crumbs";
import { FileDialogs, type FileDialog } from "./components/dialogs";
import { COL_MODIFIED, COL_MORE, COL_SIZE, FileTree, type ItemActions } from "./components/FileTree";
import { flatRows, flatten, type FolderState } from "./lib/tree";

type Mode = "all" | "recent" | "chats";
const HOW: Record<Touched["how"], string> = {
  read: "Read",
  wrote: "Written",
  attached: "Attached",
};
const DROP_MAX = 20;

/**
 * A space's files (Files, in every space): the folder on show as a tree with
 * folders first, search by name across the space, Recent, and the files
 * conversations used (read, written or attached). Files open in the viewer;
 * each item has a menu (Open, Show in Finder, Rename, Move, Delete) on its …
 * and on right-click. Everything goes through the core, which keeps to the
 * space's walls; folders kept from Phaethon's agent carry a lock.
 */
export function FilesView({ space }: { space: SpaceView }) {
  return <FilesPage key={space.id} space={space} />;
}

function FilesPage({ space }: { space: SpaceView }) {
  const visible = useViewActive();
  const [settings, setSettings] = useState<FilesSettings | null>(null);
  const [sortPick, setSortPick] = useState<FileSort | null>(null);
  const [desc, setDesc] = useState(false);
  const sort: FileSort = sortPick ?? settings?.sort ?? "name";
  const [cwd, setCwd] = useState("");
  const [folders, setFolders] = useState<Record<string, FolderState | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<Mode>("all");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{
    query: string;
    data: Found | null;
    error: string | null;
  } | null>(null);
  const [searchTick, setSearchTick] = useState(0);
  const [recent, setRecent] = useState<{
    data: Found | null;
    error: string | null;
  }>({ data: null, error: null });
  const [relevant, setRelevant] = useState<Touched[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [dialog, setDialog] = useState<FileDialog>(null);
  const [dropping, setDropping] = useState(false);
  const [adding, setAdding] = useState<"files" | "folder" | "drop" | null>(null);
  const seq = useRef<Record<string, number>>({});
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  // ---- Loading -------------------------------------------------------------------

  const loadFolder = useCallback(
    async (path: string, opts: { more?: boolean; keep?: boolean } = {}) => {
      const n = (seq.current[path] = (seq.current[path] ?? 0) + 1);
      const had = foldersRef.current[path];
      const offset = opts.more && had ? had.entries.length : 0;
      const limit = opts.keep && had ? Math.max(PAGE, had.entries.length) : PAGE;
      setFolders((f) => ({
        ...f,
        [path]: {
          entries: had?.entries ?? [],
          total: had?.total ?? 0,
          loading: true,
          error: null,
        },
      }));
      try {
        const page = await filesList(space.id, path, sort, desc, offset, limit);
        if (seq.current[path] !== n) return;
        setFolders((f) => ({
          ...f,
          [path]: {
            entries: opts.more ? [...(f[path]?.entries ?? []), ...page.entries] : page.entries,
            total: page.total,
            loading: false,
            error: null,
          },
        }));
      } catch (e) {
        if (seq.current[path] !== n) return;
        setFolders((f) => ({
          ...f,
          [path]: {
            entries: opts.more ? (f[path]?.entries ?? []) : [],
            total: f[path]?.total ?? 0,
            loading: false,
            error: cleanMessage(e),
          },
        }));
      }
    },
    [space.id, sort, desc],
  );

  /** Every folder on screen again (after a change, or coming back to the page). */
  const reloadShown = useCallback(() => {
    const shown = new Set([cwd, ...[...expanded].filter((p) => p === cwd || p.startsWith(cwd ? `${cwd}/` : ""))]);
    setFolders((f) => Object.fromEntries(Object.entries(f).filter(([p]) => shown.has(p))));
    for (const p of shown) void loadFolder(p, { keep: true });
  }, [cwd, expanded, loadFolder]);

  const loadSide = useCallback(() => {
    filesSettings(space.id).then(setSettings, () =>
      setSettings(
        (s) =>
          s ?? {
            showHidden: false,
            sort: "name",
            excluded: [],
            canTrash: false,
          },
      ),
    );
    filesRelevant(space.id).then(setRelevant, () => setRelevant([]));
    if (mode === "recent")
      filesRecent(space.id).then(
        (data) => setRecent({ data, error: null }),
        (e) => setRecent({ data: null, error: cleanMessage(e) }),
      );
  }, [space.id, mode]);

  // The folder on show (and the open ones under it) load when shown, and again when the sort changes.
  // Waits for the space's settings (its default sort and hidden files) so the first listing is the right one.
  const ready = settings !== null;
  useEffect(() => {
    if (ready) reloadShown();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reloads on what is listed, not on every expansion
  }, [ready, cwd, sort, desc, settings?.showHidden]);

  // Coming back to the page (it stays mounted behind others) refreshes it quietly.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      reloadShown();
      loadSide();
    }
    wasVisible.current = visible;
  }, [visible, reloadShown, loadSide]);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per space and mode
  useEffect(() => loadSide(), [space.id, mode]);

  // A search across the space, a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound(null);
    let live = true;
    const t = setTimeout(() => {
      filesFind(space.id, q).then(
        (data) => live && setFound({ query: q, data, error: null }),
        (e) => live && setFound({ query: q, data: null, error: cleanMessage(e) }),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, space.id, searchTick]);

  // ---- What's on screen ------------------------------------------------------------

  const searching = query.trim().length > 0;
  const rows = useMemo(() => {
    if (searching) return flatRows(found?.data?.entries ?? []);
    if (mode === "recent") return flatRows(recent.data?.entries ?? []);
    if (mode === "chats") return flatRows((relevant ?? []).map(touchedEntry));
    return flatten(folders, cwd, expanded);
  }, [searching, found, mode, recent, relevant, folders, cwd, expanded]);
  const listKey = searching ? `q:${found?.query}` : mode === "all" ? `all:${cwd}:${sort}:${desc}` : mode;
  const [shownKey, setShownKey] = useState(listKey);
  const instant = shownKey !== listKey;
  if (instant) setShownKey(listKey);

  const root = folders[cwd];
  const rootWaiting = useDelayed(mode === "all" && !searching && (!root || (root.loading && !root.entries.length && !root.error)));
  const searchWaiting = searching && found?.query !== query.trim();
  const touchedByPath = useMemo(() => new Map((relevant ?? []).map((t) => [t.path, t])), [relevant]);

  const count = searching
    ? found?.data
      ? `${found.data.entries.length}${found.data.truncated ? "+" : ""} ${found.data.entries.length === 1 ? "match" : "matches"}`
      : ""
    : mode === "recent"
      ? recent.data
        ? itemCount(recent.data.entries.length)
        : ""
      : mode === "chats"
        ? relevant
          ? itemCount(relevant.length)
          : ""
        : root && (root.entries.length || !root.loading)
          ? itemCount(root.total)
          : "";

  // ---- Actions -----------------------------------------------------------------------

  const nav = useNav.getState;
  const go = (folder: string) => {
    setCwd(folder);
    setActive(null);
    setMode("all");
    setQuery("");
  };
  const toggle = (e: FileEntry, open?: boolean) => {
    const next = open ?? !expanded.has(e.path);
    setExpanded((s) => {
      const n = new Set(s);
      if (next) n.add(e.path);
      else for (const p of s) if (p === e.path || p.startsWith(`${e.path}/`)) n.delete(p);
      return n;
    });
    if (next) void loadFolder(e.path, { keep: true });
  };
  /** Viewer tabs for a path (or anything under a folder) that moved or went. */
  const closeTabs = (path: string, to: string | null) => {
    const { files, viewer } = nav();
    for (const f of files) {
      if (f.space !== space.id || (f.path !== path && !f.path.startsWith(`${path}/`))) continue;
      const wasShown = viewer?.space === f.space && viewer.path === f.path;
      nav().closeFile(f);
      if (to && wasShown) nav().openFile(space.id, to + f.path.slice(path.length));
    }
  };
  const actions: ItemActions = {
    open: (e) => (e.dir ? go(e.path) : nav().openFile(space.id, e.path)),
    openExternal: (e) => void fileOpen(space.id, e.path).catch((err) => toast.error("Couldn’t open the file", cleanMessage(err))),
    reveal: (e) => void fileOpen(space.id, e.path, true).catch((err) => toast.error(`Couldn’t show it in ${fileManagerName()}`, cleanMessage(err))),
    rename: (e) => setDialog({ kind: "rename", entry: e }),
    move: (e) => setDialog({ kind: "move", entry: e }),
    remove: (e) => setDialog({ kind: "delete", entry: e }),
    copyPath: (e) => void copyText(e.path, "Path copied"),
  };
  const refreshAll = () => {
    reloadShown();
    if (query.trim()) setSearchTick((n) => n + 1);
    loadSide();
  };

  const add = async (folder: boolean) => {
    setAdding(folder ? "folder" : "files");
    try {
      const r = await api.addToSpace(space.id, folder);
      if (!r) return;
      toast.success(`Added ${r.files} ${r.files === 1 ? "file" : "files"} to files/`, r.skipped ? `${r.skipped} skipped` : undefined);
      setExpanded((s) => new Set(s).add("files"));
      go("");
      void loadFolder("files");
      reloadShown();
    } catch (e) {
      toast.error("Couldn’t add files", cleanMessage(e));
    } finally {
      setAdding(null);
    }
  };

  const onDrop = async (ev: DragEvent) => {
    ev.preventDefault();
    setDropping(false);
    const items = [...ev.dataTransfer.items];
    const folderDropped = items.some((i) => i.webkitGetAsEntry?.()?.isDirectory);
    const files = [...ev.dataTransfer.files].filter((_, i) => !items[i]?.webkitGetAsEntry?.()?.isDirectory);
    if (folderDropped && !files.length) return void toast.info("Folders can’t be dropped here", "Use Add › Add a folder… instead.");
    if (!files.length) return;
    if (files.length > DROP_MAX) return void toast.error(`That’s more than ${DROP_MAX} files`, "Use Add › Add files… instead.");
    setAdding("drop");
    try {
      const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, data: await toBase64(f) })));
      const r = await filesUpload(space.id, cwd, uploads);
      const where = cwd || "files";
      toast.success(`Added ${r.paths.length} ${r.paths.length === 1 ? "file" : "files"} to ${where}/`, folderDropped ? "Folders were left out." : undefined);
      if (!cwd) setExpanded((s) => new Set(s).add("files"));
      if (r.paths[0]) setActive(r.paths[0]);
      reloadShown();
      if (!cwd) void loadFolder("files", { keep: true });
    } catch (e) {
      toast.error("Couldn’t add the files", cleanMessage(e));
    } finally {
      setAdding(null);
    }
  };

  const onDone = (c: { kind: "rename" | "move" | "delete" | "folder"; from?: string; path: string | null; trashed?: boolean }) => {
    if (c.from) {
      closeTabs(c.from, c.path);
      setExpanded((s) => {
        const n = new Set<string>();
        for (const p of s) {
          if (p === c.from || p.startsWith(`${c.from}/`)) {
            if (c.path) n.add(c.path + p.slice(c.from!.length));
          } else n.add(p);
        }
        return n;
      });
      if (cwd === c.from || cwd.startsWith(`${c.from}/`)) setCwd(c.path ? c.path + cwd.slice(c.from.length) : parentOf(c.from));
    }
    if (c.kind === "delete") toast.success(c.trashed ? `Moved ${baseName(c.from ?? "")} to the Trash` : `Deleted ${baseName(c.from ?? "")}`);
    if (c.kind === "move" && c.path) toast.success(`Moved to ${parentOf(c.path) || space.name}`);
    if (c.kind === "folder" && c.path) {
      const parent = parentOf(c.path);
      if (parent !== cwd) setExpanded((s) => new Set(s).add(parent));
    }
    setActive(c.path);
    refreshAll();
  };

  // ---- Drawing -----------------------------------------------------------------------

  const empty = mode === "all" && !searching && root && !root.loading && !root.error && root.total === 0 && cwd === "";
  const listLabel = searching
    ? `Files matching ${query.trim()}`
    : mode === "recent"
      ? "Recent files"
      : mode === "chats"
        ? "Files used in chats"
        : `Files in ${cwd || space.name}`;
  const strip = mode === "all" && !searching && cwd === "" && (relevant?.length ?? 0) > 0 ? relevant!.slice(0, 6) : [];

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <Header
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "folder", parent: cwd })}>
              <Icon icon={icons.folderAdd} />
              <ActionLabel>New folder</ActionLabel>
            </Button>
            <Menu>
              <MenuTrigger render={<Button size="sm" variant="outline" pending={adding === "files" || adding === "folder"} />}>
                <Icon icon={icons.add} />
                <ActionLabel>Add</ActionLabel>
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => void add(false)}>
                  <Icon icon={icons.file} />
                  Add files…
                </MenuItem>
                <MenuItem onClick={() => void add(true)}>
                  <Icon icon={icons.folder} />
                  Add a folder…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        }
      />
      <div className="@container/page relative mx-auto flex min-h-0 w-full max-w-(--page-wide-max-width) flex-1 flex-col gap-3 px-8 pt-10 pb-6 @max-3xl/page:px-6 @max-md/page:px-4">
        <div className="flex min-h-8 min-w-0 items-center gap-2">
          {searching ? (
            <p className="type-title min-w-0 flex-1 truncate">Results for “{query.trim()}”</p>
          ) : mode === "all" ? (
            <Crumbs spaceName={space.name} path={cwd} onGo={go} className="-ml-1.5 min-w-0 flex-1" />
          ) : (
            <p className="type-title min-w-0 flex-1 truncate">{mode === "recent" ? "Recently changed" : "Used in chats"}</p>
          )}
          <span className="type-meta type-live shrink-0" aria-live="polite">
            {count}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`Show in ${fileManagerName()}`}
                  onClick={() =>
                    void (cwd ? fileOpen(space.id, cwd, true) : api.showSpace(space.id)).catch((e) =>
                      toast.error(`Couldn’t show it in ${fileManagerName()}`, cleanMessage(e)),
                    )
                  }
                />
              }
            >
              <Icon icon={icons.folderOpen} />
            </TooltipTrigger>
            <TooltipPopup>Show in {fileManagerName()}</TooltipPopup>
          </Tooltip>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SearchField
            aria-label="Search files by name"
            placeholder="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                document.querySelector<HTMLElement>(`[data-files-tree="${space.id}"] [role="tree"]`)?.focus();
              }
            }}
            trailing={
              searchWaiting ? (
                <Spinner size="xs" tone="muted" />
              ) : query ? (
                <SearchFieldAction aria-label="Clear search" onClick={() => setQuery("")}>
                  <Icon icon={icons.close} />
                </SearchFieldAction>
              ) : null
            }
            className="min-w-40 flex-1 basis-48 @2xl/page:max-w-72"
          />
          <Tabs
            value={mode}
            onValueChange={(v: Mode) => {
              setMode(v);
              setQuery("");
              setActive(null);
            }}
          >
            <TabsList size="sm" aria-label="Show">
              <TabsTab value="all">All</TabsTab>
              <TabsTab value="recent">Recent</TabsTab>
              <TabsTab value="chats">Used in chats</TabsTab>
            </TabsList>
          </Tabs>
          {mode === "all" && !searching ? (
            <Menu>
              <MenuTrigger
                render={<Button size="sm" variant="ghost-muted" className="ml-auto" aria-label={`Sort by ${SORTS.find((s) => s.value === sort)?.label}`} />}
              >
                <Icon icon={desc ? icons.arrowUp : icons.arrowDown} />
                <span>{SORTS.find((s) => s.value === sort)?.label}</span>
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Sort by</MenuGroupLabel>
                  <MenuRadioGroup value={sort} onValueChange={(v) => setSortPick(v as FileSort)}>
                    {SORTS.map((s) => (
                      <MenuRadioItem key={s.value} value={s.value}>
                        <span className="flex items-center gap-2">
                          <span className="flex-1">{s.label}</span>
                          {s.value === sort ? <Icon icon={icons.check} className="size-4 shrink-0" /> : null}
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuItem onClick={() => setDesc((d) => !d)}>
                  <Icon icon={desc ? icons.arrowDown : icons.arrowUp} />
                  {desc ? "Usual order" : "Reverse order"}
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>

        {strip.length ? (
          <section aria-label="Used in chats lately" className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <h2 className="type-label">Used in chats lately</h2>
              <Button size="xs" variant="ghost-muted" onClick={() => setMode("chats")}>
                See all
              </Button>
            </div>
            <ul className="flex min-w-0 flex-wrap gap-1.5">
              {strip.map((t) => (
                <li key={t.path} className="min-w-0 max-w-full">
                  <button
                    type="button"
                    onClick={() => nav().openFile(space.id, t.path)}
                    title={`${HOW[t.how]} ${relativeTime(t.at)} · ${t.path}`}
                    className="flex h-7 min-w-0 max-w-64 items-center gap-1.5 rounded-lg border bg-card px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FileIcon name={t.path} className="size-3.5 shrink-0" />
                    <MiddleTruncate value={baseName(t.path)} showTitle={false} className="min-w-0" />
                    <span className="sr-only">
                      {HOW[t.how]} {relativeTime(t.at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {mode === "all" && !searching && root?.error && !root.entries.length ? (
          <SurfaceError title="Couldn’t read this folder" message={root.error} onRetry={() => void loadFolder(cwd)} />
        ) : empty ? (
          <div className="flex flex-1 items-start justify-center pt-6">
            <EmptyState
              palette="sky"
              seed={`files-${space.id}`}
              title={`No files in ${space.name} yet`}
              description="Add files or a folder, or drop files here. They’re copied into this space."
              action={
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" pending={adding === "files"} onClick={() => void add(false)}>
                    <Icon icon={icons.add} />
                    Add files…
                  </Button>
                  <Button size="sm" variant="outline" pending={adding === "folder"} onClick={() => void add(true)}>
                    <Icon icon={icons.folder} />
                    Add a folder…
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <div data-files-tree={space.id} className="@container/files flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border bg-card">
            <div aria-hidden className="flex h-8 shrink-0 items-center gap-2 border-b pr-2 pl-9 text-subtle-foreground text-xs">
              <span className="min-w-0 flex-1">Name</span>
              <span className={COL_MODIFIED}>{mode === "chats" ? "Used" : "Modified"}</span>
              <span className={COL_SIZE}>Size</span>
              <span className={COL_MORE} />
            </div>
            {rootWaiting || (searching && !found?.data && !found?.error) || (mode === "recent" && !recent.data && !recent.error) ? (
              <div className="flex flex-col gap-2 p-3" aria-busy>
                {[60, 45, 70, 50].map((w) => (
                  <Skeleton key={w} className="h-5" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : (
              <FileTree
                rows={rows}
                label={listLabel}
                active={active}
                onActive={setActive}
                onToggle={toggle}
                onMore={(f) => void loadFolder(f, { more: true })}
                onRetry={(f) => void loadFolder(f)}
                actions={actions}
                flat={searching || mode !== "all"}
                instant={instant}
                lockedRoots={settings?.excluded}
                metaFor={
                  mode === "chats" && !searching
                    ? (e) => `${HOW[touchedByPath.get(e.path)?.how ?? "read"]} ${relativeTime(touchedByPath.get(e.path)?.at ?? e.modified)}`
                    : undefined
                }
                empty={
                  <p className="flex h-10 items-center px-3 text-muted-foreground text-sm">
                    {searching
                      ? found?.error
                        ? found.error
                        : `No file or folder is called “${query.trim()}”.`
                      : mode === "recent"
                        ? (recent.error ?? "No files here yet.")
                        : mode === "chats"
                          ? "No conversation has used a file here yet."
                          : "This folder is empty."}
                  </p>
                }
              />
            )}
          </div>
        )}
      </div>

      {dropping ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-panel border-2 border-primary/50 border-dashed bg-background/80">
          <p className="type-heading flex items-center gap-2">
            <Icon icon={icons.upload} className="size-5 text-primary" />
            Drop to add to {cwd || "files"}/
          </p>
        </div>
      ) : adding === "drop" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
          <p className="flex items-center gap-2 rounded-full border bg-popover px-3 py-1.5 text-sm shadow-popup">
            <Spinner size="sm" tone="muted" />
            Adding files…
          </p>
        </div>
      ) : null}

      <FileDialogs
        space={space.id}
        spaceName={space.name}
        canTrash={settings?.canTrash ?? false}
        dialog={dialog}
        onClose={() => setDialog(null)}
        onDone={onDone}
      />
    </div>
  );
}

/** A file a conversation used, as a row. */
function touchedEntry(t: Touched): FileEntry {
  return {
    name: baseName(t.path),
    path: t.path,
    dir: false,
    size: t.size,
    modified: t.modified,
  };
}
