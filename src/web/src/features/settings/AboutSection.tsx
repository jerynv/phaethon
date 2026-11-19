import { useEffect, useRef, useState } from "react";
import { LiveFigures } from "@/components/live-figures";
import { api, type InstallEvent, type UpdateView } from "@/app/api";
import { ClampedText, FieldError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useDelayed } from "@/hooks/use-delayed";
import { Channel, invoke } from "@/lib/core";
import { relativeTime } from "@/lib/platform";
import { openUpdateDialog, rememberForWhatsNew, syncUpdateView } from "@/features/updates/UpdateDialogs";
import { UPDATE_COPY } from "@/features/updates/copy";
import { Row, SettingsGroup, Status, useLoad } from "./ui";

/** Settings › About: the version, updates (check, then install with a progress bar), and licenses. */

const mb = (n: number) => (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1);

function Progress({ ev }: { ev: InstallEvent }) {
  const pct = ev.kind === "downloading" && ev.total ? Math.min(100, (ev.received / ev.total) * 100) : null;
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2.5">
      <div
        role="progressbar"
        aria-label="Update progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct !== null ? Math.round(pct) : undefined}
        className="relative h-0.5 overflow-hidden rounded-full bg-muted"
      >
        {pct !== null ? (
          <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
        ) : (
          <div className="absolute inset-y-0 w-2/5 animate-indeterminate rounded-full bg-primary" />
        )}
      </div>
      <div className="flex items-center justify-between text-muted-foreground text-xs" role="status">
        <span>{ev.kind === "downloading" ? "Downloading update…" : ev.kind === "installing" ? "Installing update…" : "Restarting Phaethon…"}</span>
        {ev.kind === "downloading" ? (
          <span>
            <LiveFigures text={ev.total ? `${mb(ev.received)} / ${mb(ev.total)} MB` : `${mb(ev.received)} MB`} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function UpdateRow({ initial }: { initial: UpdateView }) {
  const [view, setView] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const channel = useRef<Channel<InstallEvent> | null>(null);
  useEffect(() => () => channel.current?.close(), []);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const next = await api.updateCheck();
      setView(next);
      syncUpdateView(next);
    } catch (e) {
      setCheckError(cleanMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const startInstall = async () => {
    setInstallError(null);
    setInstall({ kind: "downloading", received: 0, total: null });
    rememberForWhatsNew(view, true);
    channel.current?.close();
    const ch = new Channel<InstallEvent>((ev) => setInstall(ev));
    channel.current = ch;
    try {
      await invoke("update_install", { onEvent: ch });
    } catch (e) {
      rememberForWhatsNew(view, false);
      setInstall(null);
      setInstallError(cleanMessage(e));
    } finally {
      ch.close();
    }
  };

  const s = view.status;
  const busy = checking || s.state === "checking";
  const checkButton = (label: string) => (
    <Button size="xs" variant="outline" onClick={() => void check()} disabled={busy} className="min-w-28">
      {busy ? <Spinner /> : null}
      {busy ? "Checking…" : label}
    </Button>
  );

  if (s.state === "notSetUp") {
    return (
      <Row
        label="Updates"
        description={<span className="[overflow-wrap:anywhere]">Automatic updates aren’t available for this build.{s.reason ? ` ${s.reason}` : ""}</span>}
      />
    );
  }

  if (s.state === "available") {
    return (
      <div>
        <Row
          label={`Phaethon ${s.version} is available`}
          description={
            <div className="flex flex-col gap-1">
              {s.date ? <span className="tabular-nums">Released {new Date(s.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span> : null}
              {s.notes ? <ClampedText text={s.notes} className="text-foreground/80" /> : null}
            </div>
          }
          below={installError ? <FieldError>Couldn’t install the update: {installError}</FieldError> : undefined}
        >
          <Button size="xs" variant="ghost" onClick={() => openUpdateDialog(view)} disabled={install !== null}>
            {UPDATE_COPY.about.seeNotes}
          </Button>
          {view.canInstall ? (
            <Button size="xs" onClick={() => void startInstall()} disabled={install !== null} className="min-w-32">
              {install ? <Spinner /> : null}
              {install ? "Installing…" : installError ? "Try again" : "Install and restart"}
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">Download from the releases page</span>
          )}
        </Row>
        {install ? <Progress ev={install} /> : null}
      </div>
    );
  }

  if (s.state === "error" || checkError) {
    const message = checkError ?? (s.state === "error" ? s.message : "");
    return (
      <Row
        label="Updates"
        description={<Status tone="error">{s.state === "error" && s.during === "launch" ? "Automatic update check failed" : "Couldn’t check for updates"}</Status>}
        below={<FieldError>{message}</FieldError>}
      >
        <Button size="xs" variant="outline" onClick={() => void check()} disabled={busy} className="min-w-28">
          {busy ? <Spinner /> : <Icon icon={icons.retry} />}
          {busy ? "Checking…" : "Retry"}
        </Button>
      </Row>
    );
  }

  if (s.state === "upToDate") {
    return (
      <Row label="Updates" description={<Status tone="ready">Up to date · checked {relativeTime(s.checkedAt).toLowerCase()}</Status>}>
        {checkButton("Check again")}
      </Row>
    );
  }

  return (
    <Row label="Updates" description={busy ? "Checking for updates…" : "Not checked yet"}>
      {checkButton("Check for updates")}
    </Row>
  );
}

function VersionSkeleton() {
  const show = useDelayed(true);
  if (!show) return <span className="inline-block h-3 w-16" />;
  return <Skeleton className="inline-block h-3 w-16" />;
}

export function AboutSection() {
  const info = useLoad(() => api.coreInfo(), [], "about:core");
  const update = useLoad(() => api.updateState(), [], "about:update");
  return (
    <SettingsGroup>
      <Row label="Version">
        <span className="text-muted-foreground text-sm tabular-nums">
          {info.data ? (
            info.data.version
          ) : info.error ? (
            <span className="inline-flex items-center gap-1.5">
              Couldn’t read the version.
              <button type="button" className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void info.reload()}>
                Retry
              </button>
            </span>
          ) : (
            <VersionSkeleton />
          )}
        </span>
      </Row>
      {update.data ? (
        <UpdateRow initial={update.data} />
      ) : update.error ? (
        <Row label="Updates" description={<Status tone="error">Couldn’t read the update status</Status>} below={<FieldError>{update.error}</FieldError>}>
          <Button size="xs" variant="outline" onClick={() => void update.reload()} disabled={update.loading} className="min-w-20">
            {update.loading ? <Spinner /> : <Icon icon={icons.retry} />}
            Retry
          </Button>
        </Row>
      ) : (
        <UpdateSkeleton />
      )}
      <Row label="License">
        <a
          href="https://github.com/jerynv/phaethon/blob/main/LICENSE"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 rounded-sm text-primary text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          MIT
          <span className="sr-only"> license (opens in new tab)</span>
          <Icon icon={icons.external} className="size-3.5" />
        </a>
      </Row>
    </SettingsGroup>
  );
}

function UpdateSkeleton() {
  const show = useDelayed(true);
  return (
    <div className="flex min-h-10 items-center gap-4 px-3 py-2 motion-safe:animate-skeleton" aria-hidden>
      {show ? (
        <>
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-2.5 w-20 animate-none" />
            <Skeleton className="h-2 w-48 animate-none" />
          </div>
          <Skeleton className="h-6 w-28 animate-none rounded-md" />
        </>
      ) : null}
    </div>
  );
}
