import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNav, type ViewerFile } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { PageTab, PageTabList, pageTabStripClassName } from "@/components/ui/page-tabs";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes } from "@/features/courses/lib/sites";
import { cn } from "@/lib/utils";
import { useDelayed } from "@/hooks/use-delayed";
import { fileBytes, fileOpen, fileView } from "./api";
import { Body, PageSkeleton } from "./bodies";
import { FileIcon, kindOfName } from "./FileIcon";
import { type FileView, isByteKind, previewByteLimit } from "./kinds";

const WIDTH_KEY = "phaethon.viewerWidth";
const MIN = 320;
const MAX = 720;
const DEFAULT = 440;

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n >= MIN && n <= MAX ? n : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** `copy`: the text Phaethon read from a file it can't show in place (an import writes it beside the file as `<name>.md`). */
type State = { view?: FileView; bytes?: ArrayBuffer; copy?: FileView; error?: string; loading: boolean };

/** Why a file couldn't be opened, in words: a missing file says so instead of the system's message. */
function openError(e: unknown): string {
  const m = cleanMessage(e);
  if (/ENOENT|no such file|isn’t in this space|not found/i.test(m)) return "It isn’t there any more. It may have been moved, renamed or deleted.";
  if (/EACCES|EPERM|permission/i.test(m)) return "Phaethon isn’t allowed to read it. Check the file’s permissions, then try again.";
  return m;
}

/** What the viewer can show in place; everything else offers the file's own app. */
export function previewOf(v: FileView): "show" | "tooBig" | "unsupported" {
  if (v.tooBig || (isByteKind(v.kind) && v.size > previewByteLimit(v.kind))) return "tooBig";
  if (["spreadsheet", "slides", "other"].includes(v.kind)) return "unsupported";
  if (!isByteKind(v.kind) && v.text == null) return "unsupported";
  return "show";
}

const fileKey = (f: ViewerFile) => `${f.space}\n${f.path}`;
const nameOf = (path: string) => path.split("/").pop() ?? path;

/**
 * The file panel on the right. Every file opened stays open as a tab across
 * its top (like an editor's), the one on show highlighted; each keeps its
 * place while another is shown. A middle-click or the tab's × closes it, the
 * tab's right-click menu closes the others, and the panel's own × shuts them all.
 */
export function FileViewer() {
  const files = useNav((s) => s.files);
  const target = useNav((s) => s.viewer);
  const closeAll = useNav((s) => s.closeAllFiles);
  const [width, setWidth] = useState(readWidth);

  // Resize from the left edge; the width is remembered.
  const drag = useRef<{ x: number; w: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(Math.round(Math.min(MAX, Math.max(MIN, drag.current.w + drag.current.x - e.clientX))));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // The width lasts for this session only.
    }
  };

  if (!target) return null;
  return (
    <aside className="relative flex h-full shrink-0 flex-col border-l bg-background" style={{ width }} aria-label="Files">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={width}
        className="-left-1 absolute inset-y-0 z-20 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:transition-colors hover:after:bg-primary/50 active:after:bg-primary"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          setWidth(DEFAULT);
          try {
            localStorage.setItem(WIDTH_KEY, String(DEFAULT));
          } catch {
            // ignore
          }
        }}
      />
      <header className={cn("app-drag relative flex h-(--titlebar-height) shrink-0 items-end", pageTabStripClassName)}>
        <FileTabs files={files} active={target} />
        <div className="h-full min-w-2 flex-1" />
        <div className="app-no-drag flex h-10 shrink-0 items-center pr-2">
          <HeaderButton label={files.length > 1 ? "Close all files" : "Close"} onClick={closeAll}>
            <Icon icon={icons.close} />
          </HeaderButton>
        </div>
      </header>
      {files.map((f) => {
        const on = fileKey(f) === fileKey(target);
        return <FilePane key={fileKey(f)} file={f} active={on} />;
      })}
    </aside>
  );
}

/** The open files as a browser's tabs (components/ui/page-tabs.tsx): glyph, middle-cut name and ×. Arrows move between them. */
function FileTabs({ files, active }: { files: ViewerFile[]; active: ViewerFile }) {
  const show = useNav((s) => s.showFile);
  const close = useNav((s) => s.closeFile);
  const closeOthers = useNav((s) => s.closeOtherFiles);
  const closeAll = useNav((s) => s.closeAllFiles);
  const listRef = useRef<HTMLDivElement>(null);
  const activeKey = fileKey(active);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);
  const step = (dir: 1 | -1) => {
    const at = files.findIndex((f) => fileKey(f) === activeKey);
    const next = files[(at + dir + files.length) % files.length];
    if (!next) return;
    show(next);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <PageTabList
      ref={listRef}
      aria-label="Open files"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
        else return;
        e.preventDefault();
      }}
    >
      {files.map((f) => {
        const key = fileKey(f);
        const on = key === activeKey;
        const name = nameOf(f.path);
        return (
          <PageTab
            key={key}
            active={on}
            aria-label={name}
            title={f.path}
            data-file={key}
            className="animate-in fade-in duration-150"
            onClick={() => show(f)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                show(f);
              } else if (e.key === "Delete" || e.key === "Backspace") close(f);
            }}
            icon={<FileIcon kind={kindOfName(name)} name={name} />}
            label={<MiddleTruncate value={name} className="min-w-0 flex-1 [&>span]:whitespace-pre" />}
            closeLabel={`Close ${name}`}
            onClose={() => close(f)}
            menu={
              <>
                <ContextMenuItem onClick={() => close(f)}>
                  <Icon icon={icons.close} />
                  Close
                </ContextMenuItem>
                <ContextMenuItem className="ps-7" disabled={files.length < 2} onClick={() => closeOthers(f)}>
                  Close others
                </ContextMenuItem>
                <ContextMenuItem className="ps-7" onClick={closeAll}>
                  Close all
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() =>
                    navigator.clipboard.writeText(f.path).then(
                      () => toast.success("Copied"),
                      () => toast.error("Couldn’t copy the path", "The clipboard isn’t available right now. Try again."),
                    )
                  }
                >
                  <Icon icon={icons.copy} />
                  Copy path
                </ContextMenuItem>
              </>
            }
          />
        );
      })}
    </PageTabList>
  );
}

/** One open file: its toolbar (where it is, its size, open it elsewhere) and its body, shown by kind. Kept while another tab is on show. */
function FilePane({ file, active }: { file: ViewerFile; active: boolean }) {
  const [state, setState] = useState<State>({ loading: true });
  const [tick, setTick] = useState(0);
  const [meta, setMeta] = useState<string | null>(null);
  const showSkeleton = useDelayed(state.loading);

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    setMeta(null);
    (async () => {
      const view = await fileView(file.space, file.path);
      if (!live) return;
      if (isByteKind(view.kind) && previewOf(view) === "show") {
        setState({ view, loading: true });
        const bytes = await fileBytes(file.space, file.path);
        if (live) setState({ view, bytes, loading: false });
      } else if (previewOf(view) !== "show" && view.kind !== "markdown") {
        // Slides, spreadsheets, old Office files: show the text read from them, when there is one.
        setState({ view, loading: true });
        const copy = await fileView(file.space, `${file.path}.md`).catch(() => null);
        if (live) setState({ view, copy: copy?.kind === "markdown" && copy.text?.trim() ? copy : undefined, loading: false });
      } else {
        setState({ view, loading: false });
      }
    })().catch((e) => live && setState((s) => ({ view: s.view, error: openError(e), loading: false })));
    return () => {
      live = false;
    };
  }, [file, tick]);

  const open = useCallback(
    (reveal: boolean) => {
      fileOpen(file.space, file.path, reveal).catch((e) => toast.error(reveal ? "Couldn’t show the file" : "Couldn’t open the file", cleanMessage(e)));
    },
    [file],
  );

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  const copyPath = () => {
    navigator.clipboard.writeText(file.path).then(
      () => setCopied(true),
      // The browser's own reason ("Failed to execute 'writeText'…") means nothing to a person.
      () => toast.error("Couldn’t copy the path", "The clipboard isn’t available right now. Try again."),
    );
  };

  const name = state.view?.name ?? nameOf(file.path);
  const kind = state.view?.kind ?? kindOfName(name);
  const size = state.view ? (meta ?? formatBytes(state.view.size)) : null;
  const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";

  return (
    <section hidden={!active} aria-label={name} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <FileIcon kind={kind} name={name} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1 text-sm">
          {folder ? (
            <span dir="rtl" className="min-w-0 shrink truncate text-left text-subtle-foreground">
              <bdi>{folder.replaceAll("/", " / ")} /</bdi>
            </span>
          ) : null}
          <MiddleTruncate value={name} className="min-w-0 shrink-0 basis-auto font-medium [&>span]:whitespace-pre" />
        </span>
        {size ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{size}</span> : null}
        <div className="flex shrink-0 items-center">
          <HeaderButton label="Open in default app" onClick={() => open(false)}>
            <Icon icon={icons.external} />
          </HeaderButton>
          <HeaderButton label="Show in folder" onClick={() => open(true)}>
            <Icon icon={icons.folderOpen} />
          </HeaderButton>
          <HeaderButton label={copied ? "Copied" : "Copy path"} onClick={copyPath}>
            <Icon icon={copied ? icons.check : icons.copy} className={copied ? "text-success-foreground" : undefined} />
          </HeaderButton>
        </div>
      </div>
      <div className="page-scroll min-h-0 flex-1 overflow-x-hidden">
        {state.error ? (
          <div className="p-3">
            <SurfaceError title="Couldn’t open this file" message={state.error} onRetry={() => setTick((n) => n + 1)} />
          </div>
        ) : state.loading || !state.view ? (
          showSkeleton ? <PageSkeleton kind={kind} /> : null
        ) : (
          <Body key={`${file.space}\n${file.path}\n${tick}`} space={file.space} view={state.view} bytes={state.bytes} copy={state.copy} preview={previewOf(state.view)} onOpen={() => open(false)} onMeta={setMeta} />
        )}
      </div>
    </section>
  );
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
