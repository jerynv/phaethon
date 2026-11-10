import "./viewer.css";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { CircleAlertIcon, ExternalLinkIcon, FolderOpenIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/core";
import { CodeBlock } from "../chat/components/CodeBlock";
import { Markdown } from "../chat/components/Markdown";
import { LinkBaseContext, SpaceContext } from "../chat/context";
import { formatBytes, typeLabel } from "../chat/lib/attachments";
import { fileBytes, fileOpen, fileView } from "./api";
import { imageType, isByteKind, languageOf, previewByteLimit, type FileView } from "./kinds";

const PdfView = lazy(() => import("./PdfView"));
const DocxView = lazy(() => import("./DocxView"));

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "file"; view: FileView; bytes: ArrayBuffer | null };

function useLoaded(space: string, path: string, attempt: number): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setLoaded({ state: "loading" });
    void (async () => {
      try {
        const view = await fileView(space, path);
        if (isByteKind(view.kind) && view.size > previewByteLimit(view.kind)) view.tooBig = true;
        const bytes = isByteKind(view.kind) && !view.tooBig ? await fileBytes(space, path) : null;
        if (live) setLoaded({ state: "file", view, bytes });
      } catch (e) {
        if (live) setLoaded({ state: "error", message: errorText(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [space, path, attempt]);
  return loaded;
}

class Boundary extends Component<{ children: ReactNode; onRetry: () => void }, { message: string }> {
  state = { message: "" };
  static getDerivedStateFromError(e: unknown) {
    return { message: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.message ? <Problem title="This preview couldn’t load" message={this.state.message} onRetry={this.props.onRetry} /> : this.props.children;
  }
}

function Problem({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-auto flex max-w-md flex-col items-center gap-2 p-8 text-center">
      <CircleAlertIcon aria-hidden className="size-6 text-destructive" />
      <p className="font-semibold">{title}</p>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RotateCcwIcon aria-hidden />
          Try again
        </Button>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-1 flex-col gap-3 p-6" aria-busy="true" aria-label="Opening the file">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="mt-4 h-48 w-full" />
    </div>
  );
}

function ImageView({ bytes, view }: { bytes: ArrayBuffer; view: FileView }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], { type: imageType(view.name, view.mediaType) })), [bytes, view]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/60 p-4">
      <img src={url} alt={view.name} className="max-h-full max-w-full rounded-md object-contain shadow-sm" />
    </div>
  );
}

function MediaView({ bytes, view }: { bytes: ArrayBuffer; view: FileView }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], { type: view.mediaType || undefined })), [bytes, view]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/60 p-6">
      {view.kind === "audio" ? <audio controls src={url} className="w-full max-w-lg" /> : <video controls src={url} className="max-h-full max-w-full rounded-md" />}
    </div>
  );
}

function Body({ loaded, space, path, onRetry }: { loaded: Loaded; space: string; path: string; onRetry: () => void }) {
  if (loaded.state === "loading") return <Loading />;
  if (loaded.state === "error") return <Problem title="This file couldn’t be opened" message={loaded.message} onRetry={onRetry} />;
  const { view, bytes } = loaded;
  if (view.tooBig) {
    return <Problem title="Too large to show here" message={`This file is ${formatBytes(view.size)}. Open it in its own app instead.`} />;
  }
  const base = path.split("/").slice(0, -1).join("/");
  switch (view.kind) {
    case "pdf":
      return bytes ? <PdfView data={bytes} label={view.name} /> : null;
    case "image":
      return bytes ? <ImageView bytes={bytes} view={view} /> : null;
    case "docx":
      return bytes ? <DocxView data={bytes} label={view.name} /> : null;
    case "audio":
    case "video":
      return bytes ? <MediaView bytes={bytes} view={view} /> : null;
    case "markdown":
      return (
        <div tabIndex={0} role="document" aria-label={view.name} className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <SpaceContext value={space}>
            <LinkBaseContext value={base}>
              <div className="mx-auto max-w-[44rem] px-6 py-6">
                <Markdown text={view.text ?? ""} headingShift={1} />
              </div>
            </LinkBaseContext>
          </SpaceContext>
        </div>
      );
    case "text":
    case "tex":
      return (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <CodeBlock code={view.text ?? ""} lang={view.language ?? languageOf(view.name)} streaming={false} />
        </div>
      );
    default:
      return <Problem title="This kind of file opens in its own app" message="Use Open to see it in the app your computer uses for it." />;
  }
}

/**
 * A file from a reply, a course or a plan, shown in place: PDFs, Word
 * documents, pictures, Markdown, text and code. Its own app and its folder
 * are one click away.
 */
export function FileViewer({ spaceId, path, onClose }: { spaceId: string; path: string; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const loaded = useLoaded(spaceId, path, attempt);
  const [problem, setProblem] = useState<string | null>(null);
  const name = loaded.state === "file" ? loaded.view.name : (path.split("/").pop() ?? path);
  const open = (reveal: boolean) => {
    setProblem(null);
    fileOpen(spaceId, path, reveal).catch((e: unknown) => setProblem(`${name} couldn’t be ${reveal ? "shown" : "opened"}: ${errorText(e)}`));
  };
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-stretch justify-center p-0 sm:p-6">
          <DialogPrimitive.Popup
            className="flex h-full w-full max-w-5xl flex-col overflow-hidden bg-popover text-popover-foreground shadow-2xl outline-none sm:rounded-2xl sm:border"
            data-file-viewer={loaded.state === "file" ? loaded.view.kind : loaded.state}
          >
            <div className="flex items-center gap-2 border-b px-3 py-2 sm:px-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <DialogPrimitive.Title className="truncate text-base font-semibold">{name}</DialogPrimitive.Title>
                <DialogPrimitive.Description className="truncate text-xs text-muted-foreground">
                  {loaded.state === "file" ? `${typeLabel(loaded.view.name, loaded.view.mediaType)} · ${formatBytes(loaded.view.size)} · ${path}` : path}
                </DialogPrimitive.Description>
              </div>
              <Button variant="outline" size="sm" onClick={() => open(false)}>
                <ExternalLinkIcon aria-hidden />
                <span className="max-sm:sr-only">Open</span>
              </Button>
              <Button variant="ghost-muted" size="sm" onClick={() => open(true)}>
                <FolderOpenIcon aria-hidden />
                <span className="max-sm:sr-only">Show in folder</span>
              </Button>
              <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
                <XIcon aria-hidden />
              </DialogPrimitive.Close>
            </div>
            {problem && (
              <p role="alert" className="flex items-center gap-2 border-b bg-destructive/6 px-4 py-2 text-sm">
                <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
                {problem}
              </p>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              <Boundary key={attempt} onRetry={() => setAttempt((a) => a + 1)}>
                <Suspense fallback={<Loading />}>
                  <Body loaded={loaded} space={spaceId} path={path} onRetry={() => setAttempt((a) => a + 1)} />
                </Suspense>
              </Boundary>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
