import { RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type InstallEvent, type UpdateView } from "@/app/api";
import { ClampedText, FieldError, cleanMessage } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useDelayed } from "@/hooks/use-delayed";
import { Channel, invoke } from "@/lib/core";
import { relativeTime } from "@/lib/platform";
import { Card, Row, Status, useLoad } from "./ui";

/** Settings › About: the version, updates (check, then install with a progress bar), and licenses. */

const mb = (n: number) => (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1);

function Progress({ ev }: { ev: InstallEvent }) {
  const pct = ev.kind === "downloading" && ev.total ? Math.min(100, (ev.received / ev.total) * 100) : null;
  return (
    <div className="flex flex-col gap-1.5 px-3.5 pb-3">
      <div className="relative h-0.5 overflow-hidden rounded-full bg-muted">
        {pct !== null ? (
          <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
        ) : (
          <div className="absolute inset-y-0 w-2/5 animate-indeterminate rounded-full bg-primary" />
        )}
      </div>
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span>{ev.kind === "downloading" ? "Downloading" : ev.kind === "installing" ? "Installing" : "Restarting Phaethon"}</span>
        {ev.kind === "downloading" ? (
          <span className="tabular-nums">{ev.total ? `${mb(ev.received)} / ${mb(ev.total)} MB` : `${mb(ev.received)} MB`}</span>
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
      setView(await api.updateCheck());
    } catch (e) {
      setCheckError(cleanMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const startInstall = async () => {
    setInstallError(null);
    setInstall({ kind: "downloading", received: 0, total: null });
    channel.current?.close();
    const ch = new Channel<InstallEvent>((ev) => setInstall(ev));
    channel.current = ch;
    try {
      await invoke("update_install", { onEvent: ch });
    } catch (e) {
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
    return <Row label="Updates" description={<span className="[overflow-wrap:anywhere]">Not set up for this build. {s.reason}</span>} />;
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
          {view.canInstall ? (
            <Button size="xs" onClick={() => void startInstall()} disabled={install !== null} className="min-w-32">
              {install ? <Spinner /> : null}
              {install ? "Installing…" : installError ? "Try again" : "Install and restart"}
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">Download it from the releases page</span>
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
        description={<Status tone="error">{s.state === "error" && s.during === "launch" ? "The check after launch failed" : "Couldn’t check for updates"}</Status>}
        below={<FieldError>{message}</FieldError>}
      >
        <Button size="xs" variant="outline" onClick={() => void check()} disabled={busy} className="min-w-28">
          {busy ? <Spinner /> : <RotateCwIcon />}
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
    <Row label="Updates" description={busy ? "Looking for a newer version" : "Not checked since Phaethon started"}>
      {checkButton("Check for updates")}
    </Row>
  );
}

function VersionSkeleton() {
  const show = useDelayed(true);
  if (!show) return <span className="h-4" />;
  return <Skeleton className="h-3 w-24" />;
}

export function AboutSection() {
  const info = useLoad(() => api.coreInfo());
  const update = useLoad(() => api.updateState());
  return (
    <Card>
      <div className="flex items-center gap-3 px-3.5 py-4">
        <span className="inline-flex size-10 shrink-0 select-none items-center justify-center rounded-[10px] bg-primary font-semibold text-lg text-primary-foreground tracking-[-0.02em]">P</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold text-lg tracking-[-0.01em]">Phaethon</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {info.data ? (
              `Version ${info.data.version}`
            ) : info.error ? (
              <span className="inline-flex items-center gap-1.5">
                Couldn’t read the version.
                <button type="button" className="font-medium text-foreground hover:underline" onClick={() => void info.reload()}>
                  Retry
                </button>
              </span>
            ) : (
              <VersionSkeleton />
            )}
          </span>
        </div>
      </div>
      {update.data ? (
        <UpdateRow initial={update.data} />
      ) : update.error ? (
        <Row label="Updates" description={<Status tone="error">Couldn’t read the update status</Status>} below={<FieldError>{update.error}</FieldError>}>
          <Button size="xs" variant="outline" onClick={() => void update.reload()} disabled={update.loading} className="min-w-20">
            {update.loading ? <Spinner /> : <RotateCwIcon />}
            Retry
          </Button>
        </Row>
      ) : (
        <UpdateSkeleton />
      )}
      <Row label="Licenses" description="Phaethon is MIT licensed. Its interface components come from T3 Code (MIT); the other libraries it uses are listed in THIRD_PARTY_NOTICES.md." />
    </Card>
  );
}

function UpdateSkeleton() {
  const show = useDelayed(true);
  return (
    <div className="flex min-h-[4.25rem] items-center gap-4 px-3.5 py-3 motion-safe:animate-skeleton" aria-hidden>
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
