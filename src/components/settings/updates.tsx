import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";

import { SettingGroup, SettingRow } from "./controls";
import { useStatus } from "./status";

// ---- The core's update commands (src-tauri/src/updater.rs) ---------------------

export type UpdateStatus =
  | { state: "notSetUp"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate"; checkedAt: number }
  | { state: "available"; version: string; notes: string | null; date: string | null }
  | { state: "error"; message: string; during: "check" | "launch" };

export type UpdateView = {
  currentVersion: string;
  /** owner/repo on GitHub (or a host), when this build is set up for updates. */
  source: string | null;
  /** False in a development build: it checks but never installs over itself. */
  canInstall: boolean;
  status: UpdateStatus;
};

export type InstallEvent =
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "installing" }
  | { kind: "restarting" };

export const updateState = () => invoke<UpdateView>("update_state");
export const updateCheck = () => invoke<UpdateView>("update_check");
/** Download, verify, install and restart. The core picks the update; nothing is named here. */
export function updateInstall(onEvent: (e: InstallEvent) => void): Promise<void> {
  const channel = new Channel<InstallEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("update_install", { onEvent: channel });
}

// ---- Settings › About › Updates ----------------------------------------------

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;

const dayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

/** Ask again each second while a check is running (at most a minute); null if it never finished or `live` went false. */
async function untilChecked(live: () => boolean): Promise<UpdateView | null> {
  for (let i = 0; i < 60 && live(); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const v = await updateState().catch(() => null);
    if (v && v.status.state !== "checking") return v;
  }
  return null;
}

const timeOf =(ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Where an install stands, as the progress bar and its words show it. */
type Installing = { stage: "downloading"; received: number; total: number | null } | { stage: "installing" } | { stage: "restarting" };

function installWords(i: Installing): string {
  if (i.stage === "installing") return "Signature checked. Installing…";
  if (i.stage === "restarting") return "Installed. Phaethon is restarting…";
  return i.total ? `Downloading: ${megabytes(i.received)} of ${megabytes(i.total)}` : `Downloading: ${megabytes(i.received)}`;
}

/**
 * Updates, in Settings › About: where they come from, Check for updates, and an
 * update found (by this button or the quiet check when Phaethon started) with what's
 * new and Install and restart. Nothing here interrupts: results are said in the
 * settings status line, errors in words. Buttons stay in place while busy
 * (aria-disabled, not disabled), so focus is never dropped.
 */
export function UpdatesGroup() {
  const { say } = useStatus();
  const [view, setView] = useState<UpdateView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState<Installing | null>(null);
  const [installError, setInstallError] = useState("");
  const notesId = useId();
  const progressId = useId();
  const lastStage = useRef<string>("");

  useEffect(() => {
    let live = true;
    updateState().then(
      async (v) => {
        if (!live) return;
        setView(v);
        // The quiet check from launch may still be running: show its outcome when it has one.
        if (v.status.state === "checking") {
          const done = await untilChecked(() => live);
          if (live && done) setView(done);
        }
      },
      (e) => live && setLoadError(String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  async function check() {
    if (checking || installing) return;
    setChecking(true);
    setInstallError("");
    say("Checking for updates…");
    try {
      let v = await updateCheck();
      // The launch check was already running (the core runs one at a time): wait for its answer.
      if (v.status.state === "checking") v = (await untilChecked(() => true)) ?? v;
      setView(v);
      const s = v.status;
      say(
        s.state === "available"
          ? `Phaethon ${s.version} is available.`
          : s.state === "upToDate"
            ? `Phaethon is up to date. You have version ${v.currentVersion}.`
            : s.state === "error"
              ? `Couldn’t check for updates. ${s.message}`
              : "Checked for updates.",
      );
    } catch (e) {
      setView((v) => v && { ...v, status: { state: "error", message: String(e), during: "check" } });
      say(`Couldn’t check for updates. ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    if (installing || checking) return;
    setInstallError("");
    lastStage.current = "";
    setInstalling({ stage: "downloading", received: 0, total: null });
    say("Downloading the update…");
    try {
      await updateInstall((e) => {
        const next: Installing = e.kind === "downloading" ? { stage: "downloading", received: e.received, total: e.total } : { stage: e.kind };
        setInstalling(next);
        // Each stage is said once; the download's progress is the bar's to tell.
        if (next.stage !== "downloading" && lastStage.current !== next.stage) {
          lastStage.current = next.stage;
          say(installWords(next));
        }
      });
    } catch (e) {
      setInstalling(null);
      setInstallError(String(e));
    }
  }

  if (loadError) {
    return (
      <SettingGroup title="Updates">
        <SettingRow label="Updates" description={`Phaethon couldn’t tell whether this build gets updates. ${loadError}`}>
          <span />
        </SettingRow>
      </SettingGroup>
    );
  }
  if (!view) {
    return (
      <SettingGroup title="Updates">
        <SettingRow label="Updates">
          <span className="text-sm text-ink-secondary">Loading…</span>
        </SettingRow>
      </SettingGroup>
    );
  }

  const s = view.status;
  if (s.state === "notSetUp") {
    return (
      <SettingGroup title="Updates">
        <div data-updates="not-set-up" className="flex items-start gap-2.5 px-4 py-3.5 text-sm text-ink-secondary">
          <Icon name="info" className="mt-0.5 shrink-0" />
          <div className="flex max-w-(--ph-measure) flex-col gap-1">
            <p className="text-base font-medium text-ink">Updates aren’t set up for this build</p>
            <p>
              {s.reason} This copy never checks for or installs updates by itself. To get a newer version, download it and install it
              yourself.
            </p>
          </div>
        </div>
      </SettingGroup>
    );
  }

  const busy = checking || !!installing;
  const from = view.source?.includes("/") ? `the ${view.source} releases on GitHub` : (view.source ?? "this build’s release page");

  return (
    <SettingGroup title="Updates" description={`New versions come from ${from}. Each is checked against Phaethon’s signature before it’s installed.`}>
      <SettingRow
        label="Check for updates"
        description={
          s.state === "upToDate"
            ? `Phaethon ${view.currentVersion} is the newest version. Checked at ${timeOf(s.checkedAt)}.`
            : s.state === "checking" || checking
              ? "Checking…"
              : "Phaethon checks quietly when it starts, and only installs an update when you choose to."
        }
      >
        <Button
          type="button"
          variant="outline"
          data-update-check=""
          aria-disabled={busy || undefined}
          onClick={() => void check()}
          className="self-start aria-disabled:opacity-45"
        >
          <Icon name={checking ? "spinner" : "retry"} className={checking ? "motion-safe:animate-spin" : undefined} />
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      </SettingRow>

      {s.state === "error" && !installError && (
        <div
          data-update-error=""
          // A check the person asked for failed: an alert. One from the quiet check at launch is only shown.
          role={s.during === "launch" ? undefined : "alert"}
          className="flex items-start gap-2 px-4 py-3.5 text-sm text-danger-ink"
        >
          <Icon name="error" className="mt-0.5 shrink-0" />
          <p className="max-w-(--ph-measure) min-w-0 wrap-break-word">
            {s.during === "launch" ? "When Phaethon started, it couldn’t check for updates. " : "Couldn’t check for updates. "}
            {s.message}
          </p>
        </div>
      )}

      {s.state === "available" && (
        <div data-update-available="" className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex flex-col gap-0.5">
            <h5 className="text-base font-semibold text-ink">Phaethon {s.version} is available</h5>
            <p className="text-sm text-ink-secondary">
              You have {view.currentVersion}.{s.date ? ` Released ${dayOf(s.date)}.` : ""}
            </p>
          </div>
          {s.notes && (
            <div className="flex flex-col gap-1">
              <p id={notesId} className="text-sm font-medium text-ink">
                What’s new
              </p>
              {/* A tab stop, so long notes scroll by keyboard. Plain text: never rendered as markup. */}
              <div
                role="region"
                aria-labelledby={notesId}
                tabIndex={0}
                data-update-notes=""
                className="max-h-48 overflow-y-auto rounded-md bg-surface-sunken px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word text-ink"
              >
                {s.notes}
              </div>
            </div>
          )}

          {installing && (
            <div className="flex flex-col gap-1.5" data-update-progress="">
              <p id={progressId} className="text-sm text-ink" aria-live="off">
                {installWords(installing)}
              </p>
              <div
                role="progressbar"
                aria-labelledby={progressId}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  installing.stage === "downloading"
                    ? installing.total
                      ? Math.round((installing.received / installing.total) * 100)
                      : undefined
                    : 100
                }
                aria-valuetext={installWords(installing)}
                className="h-1.5 overflow-hidden rounded-full bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]"
              >
                <div
                  className="h-full rounded-full bg-accent-fill transition-[width] duration-(--ph-duration) forced-colors:bg-[Highlight]"
                  style={{
                    width: `${installing.stage === "downloading" ? (installing.total ? (installing.received / installing.total) * 100 : 0) : 100}%`,
                  }}
                />
              </div>
            </div>
          )}

          {installError && (
            <p role="alert" data-update-install-error="" className="flex items-start gap-2 text-sm text-danger-ink">
              <Icon name="error" className="mt-0.5 shrink-0" />
              <span className="max-w-(--ph-measure) min-w-0 wrap-break-word">{installError}</span>
            </p>
          )}

          {view.canInstall ? (
            <div className="flex flex-col items-start gap-1.5">
              <Button
                type="button"
                data-update-install=""
                aria-disabled={busy || undefined}
                aria-describedby={`${notesId}-restart`}
                onClick={() => void install()}
                className="aria-disabled:opacity-45"
              >
                {installing ? <Icon name="spinner" className="motion-safe:animate-spin" /> : <Icon name="download" />}
                {installing ? "Installing…" : installError ? "Try again" : "Install and restart"}
              </Button>
              <p id={`${notesId}-restart`} className="max-w-(--ph-measure) text-sm text-ink-secondary">
                Phaethon closes and opens again on the new version. A reply that is still being written stops.
              </p>
            </div>
          ) : (
            <p className="max-w-(--ph-measure) text-sm text-ink-secondary" data-update-dev="">
              This is a development build, so it doesn’t install updates over itself.
            </p>
          )}
        </div>
      )}
    </SettingGroup>
  );
}
