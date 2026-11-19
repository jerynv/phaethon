import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api, type InstallEvent, type UpdateView } from "@/app/api";
import { ArtCanvas } from "@/components/art";
import { BrandMark } from "@/components/brand-mark";
import { FieldError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { LiveFigures } from "@/components/live-figures";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Channel, invoke } from "@/lib/core";
import { UPDATE_COPY as C } from "./copy";
import { isNewer, parseNotes, type NoteBlock } from "./notes";

/**
 * The two update moments, each a dialog with a picture at the top:
 *
 * - "Update available": the core checks quietly a few seconds after launch
 *   (server/updater); when it finds a newer release this opens with the
 *   release notes and Install and restart / Later / Skip this version.
 *   Later hides it until the next launch; Skip hides that version for good.
 * - "What's new": once, on the first launch after Phaethon installed an
 *   update from here, with the notes saved when Install was pressed.
 *
 * Settings › About can open the first one again (`openUpdateDialog`).
 */

const SKIPPED = "phaethon.update.skipped";
const INSTALLING = "phaethon.update.installing";
const RELEASES_URL = "https://github.com/jerynv/phaethon/releases/latest";
/** How often, and for how long after launch, to look at the core's quiet check. */
const POLL_MS = 4000;
const POLL_FOR_MS = 3 * 60_000;

type Available = { version: string; notes: string | null; date: string | null };
type Saved = Available & { from: string };

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private mode or blocked storage: the dialogs still work for this launch.
    }
  },
};

type UpdatesState = {
  view: UpdateView | null;
  /** Which dialog shows. */
  open: "available" | "whatsNew" | null;
  whatsNew: Saved | null;
  /** Closed with Later during this launch. */
  dismissed: string | null;
  setView: (view: UpdateView) => void;
  show: (which: "available" | "whatsNew" | null) => void;
};

const useUpdates = create<UpdatesState>((set) => ({
  view: null,
  open: null,
  whatsNew: null,
  dismissed: null,
  setView: (view) => set({ view }),
  show: (open) => set({ open }),
}));

/** What the core last said about updates (the sidebar's pill and Settings › About read it). */
export const useUpdateView = () => useUpdates((s) => s.view);

/** Settings › About checked by hand: the pill and the dialog follow what it found. */
export const syncUpdateView = (view: UpdateView) => useUpdates.getState().setView(view);

/** Before installing: keep the release's notes for "what's new" on the next launch. Cleared again if the install fails. */
export function rememberForWhatsNew(view: UpdateView, on: boolean) {
  const found = available(view);
  store.set(INSTALLING, on && found ? JSON.stringify({ ...found, from: view.currentVersion } satisfies Saved) : null);
}

/** Opens "update available" again (Settings › About), when there is one. */
export function openUpdateDialog(view?: UpdateView) {
  const s = useUpdates.getState();
  if (view) s.setView(view);
  if ((view ?? s.view)?.status.state === "available") s.show("available");
}

const available = (view: UpdateView | null): Available | null => (view?.status.state === "available" ? { version: view.status.version, notes: view.status.notes, date: view.status.date } : null);

function formatDate(date: string | null): string | null {
  if (!date) return null;
  // "2026-11-19" is a calendar day: read it in local time, not as UTC midnight (which shows the day before in the Americas).
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

/** Watches for an update after launch and shows "what's new" after one. Mounted once, beside the shell. */
export function UpdateDialogs() {
  const view = useUpdates((s) => s.view);
  const open = useUpdates((s) => s.open);
  const whatsNew = useUpdates((s) => s.whatsNew);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const look = async () => {
      let v: UpdateView;
      try {
        v = await api.updateState();
      } catch {
        return;
      }
      if (stopped) return;
      const st = useUpdates.getState();
      st.setView(v);

      // First launch after an update installed from here: what's new, once.
      const raw = store.get(INSTALLING);
      if (raw) {
        try {
          const saved = JSON.parse(raw) as Saved;
          if (saved.version === v.currentVersion) {
            store.set(INSTALLING, null);
            useUpdates.setState({ whatsNew: saved, open: st.open ?? "whatsNew" });
          } else if (!isNewer(saved.version, v.currentVersion)) store.set(INSTALLING, null);
        } catch {
          store.set(INSTALLING, null);
        }
      }

      const found = available(v);
      if (found) {
        const cur = useUpdates.getState();
        if (store.get(SKIPPED) !== found.version && cur.dismissed !== found.version && cur.open === null) cur.show("available");
        return;
      }
      const waiting = v.status.state === "idle" || v.status.state === "checking";
      if (waiting && Date.now() - started < POLL_FOR_MS) timer = setTimeout(() => void look(), POLL_MS);
    };
    void look();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const found = available(view);
  return (
    <>
      {found && view ? (
        <AvailableDialog
          open={open === "available"}
          view={view}
          update={found}
          onLater={() => useUpdates.setState({ open: null, dismissed: found.version })}
          onSkip={() => {
            store.set(SKIPPED, found.version);
            useUpdates.setState({ open: null, dismissed: found.version });
          }}
        />
      ) : null}
      {whatsNew ? <WhatsNewDialog open={open === "whatsNew"} saved={whatsNew} onClose={() => useUpdates.setState({ open: null })} /> : null}
    </>
  );
}

/** The picture across the top: the mark on a soft mesh, and the versions it moves between. */
function Hero({ seed, from, to, closable = true, done = false }: { seed: string; from: string | null; to: string; closable?: boolean; done?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <ArtCanvas palette="sky" seed={seed} animate weave className="h-40 shrink-0 rounded-t-[calc(var(--radius-2xl)-1px)] border-b">
      {closable ? (
        // On the picture the dialog's own close button loses contrast, so this one sits on glass.
        <DialogClose aria-label="Close" className="absolute top-2.5 right-2.5" render={<Button size="icon-xs" variant="glass" />}>
          <Icon icon={icons.close} />
        </DialogClose>
      ) : null}
      <div className="flex size-full flex-col items-center justify-center gap-3">
        <motion.div
          initial={reduce ? false : { scale: 0.6, opacity: 0, y: 6 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.08 }}
          className="relative flex size-16 items-center justify-center rounded-[1.25rem] bg-card shadow-popup ring-1 ring-black/5"
        >
          <BrandMark className="size-8" />
          <motion.span
            aria-hidden
            initial={reduce ? false : { scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.35 }}
            className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm ring-2 ring-card"
          >
            <Icon icon={done ? icons.check : icons.arrowUp} className="size-3.5" />
          </motion.span>
        </motion.div>
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.25 }}
          className="flex items-center gap-1.5 rounded-full bg-card/80 px-2.5 py-1 font-medium text-xs tabular-nums shadow-sm ring-1 ring-black/5 backdrop-blur"
        >
          {from ? (
            <>
              <span className="text-muted-foreground">{from}</span>
              <Icon icon={icons.arrowRight} className="size-3 text-muted-foreground" />
            </>
          ) : null}
          <span className="text-foreground">{to}</span>
        </motion.div>
      </div>
    </ArtCanvas>
  );
}

function Notes({ blocks, fallback }: { blocks: NoteBlock[]; fallback: string }) {
  if (!blocks.length) return <p className="text-muted-foreground text-sm">{fallback}</p>;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {blocks.map((b, i) =>
        b.kind === "text" ? (
          <p key={i} className="text-muted-foreground leading-relaxed">
            {b.text}
          </p>
        ) : (
          <ul key={i} className="flex flex-col gap-2.5">
            {b.items.map((item, j) => (
              <li key={j} className="flex gap-2.5 leading-relaxed">
                <span aria-hidden className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-primary/70" />
                <span className="min-w-0">
                  {item.lead ? <span className="font-medium text-foreground">{item.lead} </span> : null}
                  <span className="text-muted-foreground">{item.text}</span>
                </span>
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

const mb = (n: number) => (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1);

function InstallProgress({ ev }: { ev: InstallEvent }) {
  const pct = ev.kind === "downloading" && ev.total ? Math.min(100, (ev.received / ev.total) * 100) : null;
  const label = ev.kind === "downloading" ? C.available.progress.downloading : ev.kind === "installing" ? C.available.progress.installing : C.available.progress.restarting;
  return (
    <div className="flex w-full flex-col gap-1.5 py-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct !== null ? Math.round(pct) : undefined}
        className="relative h-1 overflow-hidden rounded-full bg-muted"
      >
        {pct !== null ? (
          <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
        ) : (
          <div className="absolute inset-y-0 w-2/5 animate-indeterminate rounded-full bg-primary" />
        )}
      </div>
      <div role="status" className="flex items-center justify-between text-muted-foreground text-xs">
        <span>{label}</span>
        {ev.kind === "downloading" ? (
          <span className="tabular-nums">
            <LiveFigures text={ev.total ? `${mb(ev.received)} / ${mb(ev.total)} MB` : `${mb(ev.received)} MB`} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AvailableDialog({ open, view, update, onLater, onSkip }: { open: boolean; view: UpdateView; update: Available; onLater: () => void; onSkip: () => void }) {
  const [progress, setProgress] = useState<InstallEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channel = useRef<Channel<InstallEvent> | null>(null);
  useEffect(() => () => channel.current?.close(), []);
  const blocks = parseNotes(update.notes);
  const date = formatDate(update.date);

  const install = async () => {
    setError(null);
    setProgress({ kind: "downloading", received: 0, total: null });
    // Kept for "what's new" on the next launch, when the new version is running.
    rememberForWhatsNew(view, true);
    channel.current?.close();
    const ch = new Channel<InstallEvent>((ev) => setProgress(ev));
    channel.current = ch;
    try {
      await invoke("update_install", { onEvent: ch });
    } catch (e) {
      rememberForWhatsNew(view, false);
      setProgress(null);
      setError(cleanMessage(e));
    } finally {
      ch.close();
    }
  };

  const installing = progress !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !installing && onLater()} disablePointerDismissal={installing}>
      <DialogPopup className="max-w-md overflow-hidden" showCloseButton={false} data-testid="update-available">
        <Hero seed={`update-${update.version}`} from={view.currentVersion} to={update.version} closable={!installing} />
        <div className="flex flex-col gap-1 px-5 pt-4 pb-3">
          <p className="font-medium text-primary text-xs">{C.available.eyebrow}</p>
          <DialogTitle>{C.available.title(update.version)}</DialogTitle>
          <DialogDescription>
            {C.available.subtitle(view.currentVersion)}
            {date ? <span className="text-subtle-foreground"> · {C.available.released(date)}</span> : null}
          </DialogDescription>
        </div>
        <ScrollArea scrollFade className="max-h-64 min-h-0">
          <section aria-label={C.available.notesHeading} className="px-5 pb-4">
            <h3 className="mb-2 text-subtle-foreground text-xs">{C.available.notesHeading}</h3>
            <Notes blocks={blocks} fallback={C.available.noNotes} />
          </section>
        </ScrollArea>
        {!view.canInstall ? <p className="px-5 pb-3 text-muted-foreground text-xs">{C.available.devBuild}</p> : null}
        {error ? (
          <div className="px-5 pb-3">
            <FieldError>
              {C.available.failed}: {error}
            </FieldError>
          </div>
        ) : null}
        <DialogFooter className="items-center sm:justify-between">
          {installing && progress ? (
            <InstallProgress ev={progress} />
          ) : (
            <>
              <Button size="sm" variant="ghost-muted" onClick={onSkip}>
                {C.available.skip}
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button size="sm" variant="outline" onClick={onLater}>
                  {C.available.later}
                </Button>
                {view.canInstall ? (
                  <Button size="sm" onClick={() => void install()} autoFocus>
                    {error ? <Icon icon={icons.retry} /> : <Icon icon={icons.download} />}
                    {C.available.install}
                  </Button>
                ) : (
                  <Button size="sm" render={<a href={RELEASES_URL} target="_blank" rel="noreferrer noopener" />}>
                    {C.available.openReleases}
                    <Icon icon={icons.external} />
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WhatsNewDialog({ open, saved, onClose }: { open: boolean; saved: Saved; onClose: () => void }) {
  const blocks = parseNotes(saved.notes);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup className="max-w-md overflow-hidden" showCloseButton={false} data-testid="update-whats-new">
        <Hero seed={`whats-new-${saved.version}`} from={saved.from || null} to={saved.version} done />
        <div className="flex flex-col gap-1 px-5 pt-4 pb-3">
          <p className="font-medium text-primary text-xs">{C.whatsNew.eyebrow}</p>
          <DialogTitle>{C.whatsNew.title(saved.version)}</DialogTitle>
          <DialogDescription>{C.whatsNew.subtitle}</DialogDescription>
        </div>
        <ScrollArea scrollFade className="max-h-72 min-h-0">
          <div className="px-5 pb-4">
            <Notes blocks={blocks} fallback={C.available.noNotes} />
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button size="sm" onClick={onClose} autoFocus>
            {C.whatsNew.done}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
