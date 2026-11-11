import { ExternalLinkIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes } from "@/features/courses/lib/sites";
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

type State = { view?: FileView; bytes?: ArrayBuffer; error?: string; loading: boolean };

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

/** The file panel on the right: one file of a space, shown by kind. */
export function FileViewer() {
  const target = useNav((s) => s.viewer);
  const close = useNav((s) => s.closeFile);
  const [width, setWidth] = useState(readWidth);
  const [state, setState] = useState<State>({ loading: true });
  const [tick, setTick] = useState(0);
  const [meta, setMeta] = useState<string | null>(null);
  const showSkeleton = useDelayed(state.loading);

  useEffect(() => {
    if (!target) return;
    let live = true;
    setState({ loading: true });
    setMeta(null);
    (async () => {
      const view = await fileView(target.space, target.path);
      if (!live) return;
      if (isByteKind(view.kind) && previewOf(view) === "show") {
        setState({ view, loading: true });
        const bytes = await fileBytes(target.space, target.path);
        if (live) setState({ view, bytes, loading: false });
      } else {
        setState({ view, loading: false });
      }
    })().catch((e) => live && setState((s) => ({ view: s.view, error: openError(e), loading: false })));
    return () => {
      live = false;
    };
  }, [target, tick]);

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

  const open = useCallback(
    (reveal: boolean) => {
      if (!target) return;
      fileOpen(target.space, target.path, reveal).catch((e) => toast.error(reveal ? "Couldn’t show the file" : "Couldn’t open the file", cleanMessage(e)));
    },
    [target],
  );

  if (!target) return null;
  const name = state.view?.name ?? target.path.split("/").pop() ?? target.path;
  const kind = state.view?.kind ?? kindOfName(name);
  const size = state.view ? (meta ?? formatBytes(state.view.size)) : null;

  return (
    <aside className="relative flex h-full shrink-0 flex-col border-l bg-background" style={{ width }} aria-label={name}>
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
      <header className="app-drag flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <FileIcon kind={kind} name={name} />
        <MiddleTruncate value={name} className="min-w-0 flex-1 font-medium text-sm [&>span]:whitespace-pre" />
        {size ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{size}</span> : null}
        <div className="app-no-drag flex shrink-0 items-center">
          <HeaderButton label="Open in default app" onClick={() => open(false)}>
            <ExternalLinkIcon strokeWidth={1.75} />
          </HeaderButton>
          <HeaderButton label="Show in folder" onClick={() => open(true)}>
            <FolderOpenIcon strokeWidth={1.75} />
          </HeaderButton>
          <HeaderButton label="Close" onClick={close}>
            <XIcon strokeWidth={1.75} />
          </HeaderButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {state.error ? (
          <div className="p-3">
            <SurfaceError title="Couldn’t open this file" message={state.error} onRetry={() => setTick((n) => n + 1)} />
          </div>
        ) : state.loading || !state.view ? (
          showSkeleton ? <PageSkeleton kind={kind} /> : null
        ) : (
          <Body key={`${target.space}\n${target.path}\n${tick}`} space={target.space} view={state.view} bytes={state.bytes} preview={previewOf(state.view)} onOpen={() => open(false)} onMeta={setMeta} />
        )}
      </div>
    </aside>
  );
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
