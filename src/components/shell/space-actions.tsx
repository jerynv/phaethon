import { invoke } from "@tauri-apps/api/core";
import { useId, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { platform } from "@/lib/platform";
import { findSpace } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** What the platform calls its file manager: Finder, File Explorer, Files. */
export function fileManagerName(): string {
  const p = platform();
  return p === "mac" ? "Finder" : p === "windows" ? "File Explorer" : "Files";
}

/** "Show in Finder" (macOS), "Show in File Explorer" (Windows), "Show in Files" (Linux). */
export const showInLabel = () => `Show in ${fileManagerName()}`;

/** Mirrors `ExportDone` in src-tauri/src/lib.rs. Only the file's name: its full path stays in the core. */
type ExportDone = { fileName: string; files: number };

/**
 * The result of a space action, shown in a notice at the foot of the window
 * until it is dismissed (it never times out). Focus moves to its first button,
 * whose description is the message, so it is heard once; Escape or Dismiss puts
 * focus back where it was.
 */
type Notice =
  | { kind: "exported"; key: number; space: string; fileName: string }
  | { kind: "added"; key: number; id: string; message: string }
  | { kind: "error"; key: number; message: string; retry?: () => void };

let notice: Notice | null = null;
let busy = false;
let nextKey = 1;
const listeners = new Set<() => void>();
function setNotice(n: Notice | null) {
  notice = n;
  listeners.forEach((l) => l());
}
const useNotice = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => notice,
  );

const nameOf = (id: string) => findSpace(id)?.name ?? "This space";

/** Open the space's folder in the file manager. The core finds the folder from the id. */
export async function showSpaceFolder(id: string): Promise<void> {
  if (!inTauri()) {
    setNotice({ kind: "error", key: nextKey++, message: "Folders can be shown only in the Phaethon app." });
    return;
  }
  try {
    await invoke("space_show", { id });
  } catch (e) {
    setNotice({ kind: "error", key: nextKey++, message: `${nameOf(id)}’s folder couldn’t be shown. ${String(e)}` });
  }
}

/**
 * Export the whole space as one .zip: the core asks where to save it in the
 * system's save dialog. Cancelling it does nothing. Done or failed, a notice
 * says so (and offers to show the file, or to try again).
 */
export async function exportSpace(id: string): Promise<void> {
  if (busy) return;
  const name = nameOf(id);
  if (!inTauri()) {
    setNotice({ kind: "error", key: nextKey++, message: "Spaces can be exported only in the Phaethon app." });
    return;
  }
  busy = true;
  try {
    const done = await invoke<ExportDone | null>("space_export", { id });
    if (done) setNotice({ kind: "exported", key: nextKey++, space: name, fileName: done.fileName });
  } catch (e) {
    setNotice({ kind: "error", key: nextKey++, message: `${name} couldn’t be exported. ${String(e)}`, retry: () => void exportSpace(id) });
  } finally {
    busy = false;
  }
}

/** Mirrors `Added` in src-tauri/src/space_add.rs: where each picked thing now is in the space, and how many files. */
export type Added = { paths: string[]; files: number; skipped: number };

/** "Added Scool to Life: 34 files, in files/Scool." Hidden files and links left out are said too. */
export function addedWords(space: string, a: Added): string {
  const names = a.paths.map((p) => p.replace(/^files\//, ""));
  const what = names.length === 1 ? names[0] : `${names.length} items`;
  const count = a.files === 1 ? "1 file" : `${a.files} files`;
  const where = names.length === 1 ? `files/${names[0]}` : "its files folder";
  const left = a.skipped ? ` ${a.skipped === 1 ? "1 hidden file or link was" : `${a.skipped} hidden files or links were`} left out.` : "";
  return `Added ${what} to ${space}: ${count}, in ${where}.${left}`;
}

let adding = false;

/**
 * Add files, or one folder, from elsewhere on the computer to the space's
 * files/ folder: the core asks which in the system's picker and copies them
 * (space_add.rs). Cancelling does nothing (null). With `notice` (from a
 * menu) the result is shown at the foot of the window; a button under a
 * reply shows it itself, and gets the error thrown.
 */
export async function addToSpace(id: string, folder: boolean, notice = true): Promise<Added | null> {
  if (adding) return null;
  const name = nameOf(id);
  if (!inTauri()) {
    const message = "Files can be added only in the Phaethon app.";
    if (!notice) throw new Error(message);
    setNotice({ kind: "error", key: nextKey++, message });
    return null;
  }
  adding = true;
  try {
    const done = await invoke<Added | null>("space_add", { id, folder });
    if (done && notice) setNotice({ kind: "added", key: nextKey++, id, message: addedWords(name, done) });
    return done;
  } catch (e) {
    if (!notice) throw e;
    setNotice({ kind: "error", key: nextKey++, message: `Nothing was added to ${name}. ${String(e)}`, retry: () => void addToSpace(id, folder) });
    return null;
  } finally {
    adding = false;
  }
}

async function showExport() {
  try {
    await invoke("export_show");
  } catch (e) {
    setNotice({ kind: "error", key: nextKey++, message: `The export couldn’t be shown. ${String(e)}` });
  }
}

/** Somewhere focus can go back to: still in the page, shown and not inert. */
const canFocus = (el: HTMLElement | null): el is HTMLElement =>
  !!el?.isConnected && !el.closest("[hidden],[inert]") && el.getClientRects().length > 0;

/**
 * The notice for the last space action. Rendered once (by the sidebar, which
 * is always mounted) into the page's body, at the foot of the window.
 */
export function SpaceActionNotice() {
  const n = useNotice();
  const msgId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // A new notice takes focus; where focus was is remembered from the first notice on.
  useLayoutEffect(() => {
    if (!n) return;
    const at = document.activeElement as HTMLElement | null;
    if (!at?.closest("[data-space-action-notice]")) returnTo.current = at;
    firstRef.current?.focus();
  }, [n]);

  // Escape anywhere while focus is in the notice closes it.
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  }

  function dismiss() {
    const back = returnTo.current;
    const hadFocus = !!document.activeElement?.closest("[data-space-action-notice]");
    returnTo.current = null;
    setNotice(null);
    if (hadFocus) (canFocus(back) ? back : document.getElementById("main"))?.focus();
  }

  if (!n) return null;
  const message =
    n.kind === "exported" ? (
      <>
        Exported {n.space} as <span className="font-medium wrap-anywhere">{n.fileName}</span>.
      </>
    ) : (
      n.message
    );
  const ok = n.kind !== "error";
  return createPortal(
    <section
      key={n.key}
      aria-label={n.kind === "exported" ? "Export finished" : n.kind === "added" ? "Files added" : "Something went wrong"}
      data-space-action-notice={n.kind}
      onKeyDown={onKeyDown}
      className={cn(
        "fixed start-(--ph-pane-inset) bottom-(--ph-pane-inset) z-40 flex w-88 max-w-[calc(100%-var(--ph-pane-inset)*2)] items-start gap-2.5",
        "rounded-lg border border-line bg-raised px-3.5 py-3 text-base text-ink shadow-lg forced-colors:border-[CanvasText]",
      )}
    >
      <Icon
        name={ok ? "success" : "error"}
        className={cn("mt-0.5 shrink-0", ok ? "text-success-ink" : "text-danger-ink")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p id={msgId} className="wrap-break-word">
          {message}
        </p>
        <div className="flex flex-wrap gap-2">
          {n.kind === "exported" && (
            <Button ref={firstRef} type="button" variant="outline" size="sm" aria-describedby={msgId} data-notice-show="" onClick={() => void showExport()}>
              <Icon name="folder" />
              {showInLabel()}
            </Button>
          )}
          {n.kind === "added" && (
            <Button ref={firstRef} type="button" variant="outline" size="sm" aria-describedby={msgId} data-notice-show="" onClick={() => void showSpaceFolder(n.id)}>
              <Icon name="folder" />
              {showInLabel()}
            </Button>
          )}
          {n.kind === "error" && n.retry && (
            <Button
              ref={firstRef}
              type="button"
              variant="outline"
              size="sm"
              aria-describedby={msgId}
              data-notice-retry=""
              onClick={() => {
                const retry = n.retry;
                dismiss();
                retry?.();
              }}
            >
              <Icon name="retry" />
              Try again
            </Button>
          )}
          <Button
            ref={n.kind === "error" && !n.retry ? firstRef : undefined}
            type="button"
            variant="ghost"
            size="sm"
            aria-describedby={n.kind === "error" && !n.retry ? msgId : undefined}
            data-notice-dismiss=""
            onClick={dismiss}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </section>,
    document.body,
  );
}
