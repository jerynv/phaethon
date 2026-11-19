import { useEffect, useState } from "react";
import { api, type TelemetryChoices, type TelemetrySettings } from "@/app/api";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field, Loader, SettingsGroup, SwitchRow, useLoad } from "@/features/settings/ui";

const INITIAL: TelemetryChoices = { usage: true, diagnostics: true, reports: true, traces: true };
const categories = ["usage", "diagnostics", "reports", "traces"] as const;
const choicesOf = (s: TelemetrySettings): TelemetryChoices => Object.fromEntries(categories.map((c) => [c, s[c]])) as TelemetryChoices;

export function PrivacyChoices({ choices, onChange, disabled }: { choices: TelemetryChoices; onChange: (choices: TelemetryChoices) => void; disabled?: boolean }) {
  const row = (category: keyof TelemetryChoices, label: string, description: string) => (
    <SwitchRow label={label} description={description} checked={choices[category]} disabled={disabled} onCheckedChange={(checked) => onChange({ ...choices, [category]: checked })} />
  );
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup label="Usage">
        {row("usage", "Anonymous usage", "App opens, views, and action counts. No chat text, names, or file paths.")}
      </SettingsGroup>
      <SettingsGroup label="Help improve Phaethon" note="Reports and chat text are redacted on this device for common secrets, email addresses, and home paths. Redaction cannot guarantee anonymity; names and other identifying details may remain.">
        {row("diagnostics", "Diagnostics", "Assistant type, reply duration, step count, and whether a turn completed.")}
        {row("reports", "Testing reports", "Reports you choose to write, review, and send from Privacy settings.")}
        {row("traces", "Chat traces", "Text from new prompts and completed replies, including coding agents. Excludes tool arguments, tool results, and system prompts.")}
      </SettingsGroup>
    </div>
  );
}

/** Draft switches have no effect until the explicit save succeeds. */
export function ConsentForm({ onSaved, initialChoices = INITIAL }: { onSaved: () => void; initialChoices?: TelemetryChoices }) {
  const [choices, setChoices] = useState<TelemetryChoices>(initialChoices);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      api.saveTelemetry(choices).then(onSaved, (error) => { setError(cleanMessage(error)); setBusy(false); });
    }}>
      <PrivacyChoices choices={choices} onChange={setChoices} disabled={busy} />
      {error ? <FieldError>{error}</FieldError> : null}
      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save privacy choices"}</Button>
    </form>
  );
}

/** Returning to this onboarding step shows the choices that were actually saved. */
export function OnboardingConsent({ onSaved }: { onSaved: () => void }) {
  const state = useLoad(api.telemetry);
  return <Loader state={state} errorTitle="Couldn’t read privacy settings">{(s) => <ConsentForm onSaved={onSaved} initialChoices={s.configured ? choicesOf(s) : INITIAL} />}</Loader>;
}

/** Existing installs must make a saved choice too; no close or automatic opt-in. */
export function TelemetryGate({ children }: { children: React.ReactNode }) {
  const state = useLoad(api.telemetry);
  const [saved, setSaved] = useState(false);
  if (!saved && state.data?.configured !== true) {
    return (
      <main className="page-scroll flex h-full flex-col bg-background">
        <div aria-hidden className="app-drag h-(--titlebar-height) shrink-0" />
        <div className="mx-auto w-full max-w-xl px-6 py-12">
          <h1 className="type-display">Your privacy choices</h1>
          <p className="mt-2 mb-6 text-muted-foreground text-sm">Choose what to share with Phaethon’s developers. You can change each choice in Settings → Privacy.</p>
          {state.error ? <SurfaceError title="Couldn’t read privacy settings" message={state.error} onRetry={() => void state.reload()} /> : state.data ? <ConsentForm onSaved={() => setSaved(true)} /> : <p role="status" className="text-muted-foreground text-sm">Loading privacy settings…</p>}
        </div>
      </main>
    );
  }
  return <><UsageObserver />{children}</>;
}

function UsageObserver() {
  useEffect(() => {
    let last = "";
    let lastFile: unknown = null;
    const observe = () => {
      const nav = useNav.getState();
      const view = nav.settings ? "settings" : nav.view;
      if (view !== last) { last = view; void api.telemetryUsage("view_opened", { view }).catch(() => {}); }
      if (nav.viewer && nav.viewer !== lastFile) void api.telemetryUsage("action_completed", { action: "file_opened" }).catch(() => {});
      lastFile = nav.viewer;
    };
    observe();
    return useNav.subscribe(observe);
  }, []);
  return null;
}

export function PrivacySection() {
  const state = useLoad(api.telemetry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (choices: TelemetryChoices) => {
    setBusy(true); setError(null);
    api.saveTelemetry(choices).then((s) => state.setData(s), (error) => { setError(cleanMessage(error)); void state.reload(); }).finally(() => setBusy(false));
  };
  return <Loader state={state} errorTitle="Couldn’t read privacy settings">{(s) => (
    <>
      <PrivacyChoices choices={choicesOf(s)} onChange={save} disabled={busy} />
      {error ? <FieldError>{error}</FieldError> : null}
      {!s.collectorConfigured ? <p className="text-muted-foreground text-xs">No telemetry collector is configured for this build. Nothing is sent.</p> : null}
      {s.reports ? <ReportForm collectorConfigured={s.collectorConfigured} /> : null}
    </>
  )}</Loader>;
}

function ReportForm({ collectorConfigured }: { collectorConfigured: boolean }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  return (
    <SettingsGroup label="Testing report">
      <form onSubmit={(e) => {
        e.preventDefault(); setBusy(true); setError(null); setQueued(false);
        const request = preview === null ? api.previewTelemetryReport(text).then(setPreview) : api.sendTelemetryReport(preview).then(() => { setText(""); setPreview(null); setQueued(true); });
        request.catch((error) => setError(cleanMessage(error))).finally(() => setBusy(false));
      }}>
        <Field label={preview === null ? "What happened?" : "Review the text to send"} htmlFor="testing-report" hint={preview === null ? "Up to 4,000 characters." : "Remove anything else you don’t want to share before sending."}>
          <Textarea id="testing-report" maxLength={4000} value={preview ?? text} disabled={busy} onChange={(e) => { preview === null ? setText(e.target.value) : setPreview(e.target.value); setQueued(false); }} />
        </Field>
        <div className="flex flex-col gap-2 px-3 pb-3">
          {error ? <FieldError>{error}</FieldError> : null}
          {queued ? <p role="status" className="text-muted-foreground text-xs">Report queued for sending.</p> : null}
          <div className="flex gap-2">
            {preview !== null ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPreview(null)}>Back</Button> : null}
            <Button type="submit" size="sm" disabled={busy || !collectorConfigured || !(preview ?? text).trim()}>{busy ? "Working…" : preview === null ? "Preview redacted report" : "Send report"}</Button>
          </div>
        </div>
      </form>
    </SettingsGroup>
  );
}
