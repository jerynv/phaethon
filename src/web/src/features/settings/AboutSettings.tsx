import { CheckIcon, CopyIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type CoreInfo, type InstallEvent, type SettingsView, type UpdateView } from "@/app/api";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection } from "@/components/ui/settings";
import { Skeleton } from "@/components/ui/skeleton";
import { announce } from "@/lib/announce";
import { Channel, errorText, invoke } from "@/lib/core";

const COPIED_MS = 2000;
const POLL_MS = 1000;
const POLL_LIMIT_MS = 60_000;

function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={copied ? `${what} copied` : `Copy ${what}`}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            announce(`${what} copied`);
          },
          () => announce("Couldn’t copy. Select the path and copy it instead."),
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function formatMB(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Updates, as the core reports them; hidden when this build has no updater. */
function Updates() {
  const [view, setView] = useState<UpdateView | null | "none">(null);
  const [busy, setBusy] = useState(false);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollUntil = useRef(0);

  useEffect(() => {
    api.updateState().then(setView, () => setView("none"));
  }, []);

  // While the core is checking (from launch or here), poll until it settles.
  useEffect(() => {
    if (view === null || view === "none" || view.status.state !== "checking") return;
    if (!pollUntil.current) pollUntil.current = Date.now() + POLL_LIMIT_MS;
    if (Date.now() > pollUntil.current) return;
    const t = setTimeout(() => api.updateState().then(setView, () => {}), POLL_MS);
    return () => clearTimeout(t);
  }, [view]);

  if (view === "none") return null;
  if (view === null) {
    return (
      <SettingsSection title="Updates">
        <SettingsGroup>
          <div className="px-4 py-4" aria-hidden="true">
            <Skeleton className="h-4 w-48" />
          </div>
        </SettingsGroup>
      </SettingsSection>
    );
  }

  const s = view.status;
  const check = async () => {
    setBusy(true);
    setError(null);
    pollUntil.current = 0;
    try {
      const next = await api.updateCheck();
      setView(next);
      if (next.status.state === "available") announce(`Phaethon ${next.status.version} is available`);
      if (next.status.state === "upToDate") announce("Phaethon is up to date");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const installNow = async () => {
    setError(null);
    const channel = new Channel<InstallEvent>((event) => setInstall(event));
    try {
      await invoke("update_install", { onEvent: channel });
    } catch (e) {
      setInstall(null);
      setError(errorText(e));
    }
  };

  let line: string;
  switch (s.state) {
    case "notSetUp":
      line = s.reason;
      break;
    case "idle":
      line = "Not checked yet.";
      break;
    case "checking":
      line = "Checking…";
      break;
    case "upToDate":
      line = `Up to date. Checked ${new Date(s.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;
      break;
    case "available":
      line = `Phaethon ${s.version} is available${s.date ? ` (released ${s.date})` : ""}.`;
      break;
    case "error":
      line = s.message;
      break;
  }

  const progress =
    install?.kind === "downloading"
      ? install.total
        ? `Downloading… ${formatMB(install.received)} of ${formatMB(install.total)}`
        : `Downloading… ${formatMB(install.received)}`
      : install?.kind === "installing"
        ? "Installing…"
        : install?.kind === "restarting"
          ? "Restarting Phaethon…"
          : null;
  const percent = install?.kind === "downloading" && install.total ? Math.round((install.received / install.total) * 100) : null;

  return (
    <SettingsSection title="Updates">
      <SettingsGroup>
        <SettingsRow
          title={s.state === "available" ? `Version ${s.version}` : "Phaethon updates"}
          description={<span aria-live="polite">{progress ?? line}</span>}
          control={
            s.state === "available" && view.canInstall ? (
              <Button size="sm" disabled={install !== null} onClick={() => void installNow()}>
                <DownloadIcon />
                Install and restart
              </Button>
            ) : s.state !== "notSetUp" ? (
              <Button size="sm" variant="outline" disabled={busy || s.state === "checking"} onClick={() => void check()}>
                <RefreshCwIcon />
                Check for updates
              </Button>
            ) : null
          }
        >
          {percent !== null ? (
            <div
              role="progressbar"
              aria-label="Download"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-input/60"
            >
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          {s.state === "available" && s.notes ? <p className="reading mt-3 text-muted-foreground whitespace-pre-line">{s.notes}</p> : null}
          {error ? (
            <p role="alert" className="mt-3 text-destructive-foreground text-sm">
              {error}
            </p>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

export function AboutSettings() {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.coreInfo().then(setInfo, (e) => setError(errorText(e)));
    api.settings().then(setSettings, () => {});
  }, []);

  const version = info?.version ?? settings?.version;
  const vault = settings?.vaultPath;

  return (
    <SettingsPage>
      <SettingsSection title="Phaethon">
        <SettingsGroup>
          <SettingsRow
            title="Version"
            control={
              version ? (
                <span className="font-mono text-sm tabular-nums">{version}</span>
              ) : error ? (
                <span className="text-muted-foreground text-sm">{error}</span>
              ) : (
                <Skeleton className="h-4 w-16" />
              )
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <Updates />

      <SettingsSection title="Your files" description="Everything Phaethon keeps for you is plain files in this folder.">
        <SettingsGroup>
          <SettingsRow
            title="Phaethon folder"
            description={vault ? <span className="font-mono text-foreground/85 text-xs wrap-anywhere">{vault}</span> : "Not available yet."}
            control={vault ? <CopyButton text={vault} what="Folder path" /> : null}
          />
          <SettingsRow
            title="Instructions for the assistant"
            description={<span className="font-mono text-xs">MANUAL.md</span>}
            control={vault ? <CopyButton text={`${vault}/MANUAL.md`} what="MANUAL.md path" /> : null}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Credits">
        <div className="reading flex flex-col gap-2 px-1 text-muted-foreground text-sm">
          <p>Phaethon is free software under the MIT License.</p>
          <p>
            Atkinson Hyperlegible by the Braille Institute. OpenDyslexic by Abbie Gonzalez. Lexend by Bonnie Shaver-Troup and Thomas Jockin.
            Interface parts adapted from T3 Code (MIT).
          </p>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
