import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { TELEMETRY_CATEGORIES, type TelemetryChoices } from "#shared/telemetry.ts";
import { api, type TelemetrySettings } from "@/app/api";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field, Loader, SettingsGroup, SwitchRow, useLoad } from "@/features/settings/ui";
import { isDevChannel } from "@/lib/platform";

/**
 * What people share with Phaethon's developers (docs/TELEMETRY.md). A first
 * choice starts with every category on; each can be turned off on its own, and
 * nothing is sent until the choices are saved.
 */

const ALL_ON: TelemetryChoices = { usage: true, diagnostics: true, reports: true, traces: true };

const choicesOf = (s: TelemetrySettings): TelemetryChoices =>
  Object.fromEntries(TELEMETRY_CATEGORIES.map((c) => [c, s[c]])) as TelemetryChoices;

function PrivacyChoices({
  choices,
  onChange,
  disabled,
}: {
  choices: TelemetryChoices;
  onChange: (choices: TelemetryChoices) => void;
  disabled?: boolean;
}) {
  const row = (category: keyof TelemetryChoices, label: string, description: string) => (
    <SwitchRow
      label={label}
      description={description}
      checked={choices[category]}
      disabled={disabled}
      onCheckedChange={(checked) => onChange({ ...choices, [category]: checked })}
    />
  );
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup label="Usage">
        {row("usage", "Anonymous usage", "App opens, views, and action counts. No chat text, names, or file paths.")}
      </SettingsGroup>
      <SettingsGroup
        label="Help improve Phaethon"
        note="Reports and chat text are redacted on this device for common secrets, email addresses, and home paths. Names and other details you write may remain."
      >
        {row("diagnostics", "Diagnostics", "Which assistant replied, how long it took, its step count, and whether it finished.")}
        {row("reports", "Testing reports", "Reports you write, review, and send from Privacy settings.")}
        {row("traces", "Chat traces", "Your new messages and the replies to them. Never tool calls or files.")}
      </SettingsGroup>
    </div>
  );
}

/** Choices that take effect only when the form is submitted. `actions` renders the submit button. */
function ChoicesForm({
  initial,
  onSaved,
  actions,
}: {
  initial: TelemetryChoices;
  onSaved: () => void;
  actions: (busy: boolean) => ReactNode;
}) {
  const [choices, setChoices] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api.saveTelemetry(choices).then(onSaved, (failure) => {
      setError(cleanMessage(failure));
      setBusy(false);
    });
  };
  return (
    <form onSubmit={submit}>
      <PrivacyChoices choices={choices} onChange={setChoices} disabled={busy} />
      {error ? <FieldError className="mt-3">{error}</FieldError> : null}
      {actions(busy)}
    </form>
  );
}

/** The onboarding step. Going back to it shows what was saved. */
export function OnboardingPrivacy({ onSaved, actions }: { onSaved: () => void; actions: (busy: boolean) => ReactNode }) {
  const state = useLoad(api.telemetry);
  return (
    <Loader state={state} errorTitle="Couldn’t read privacy settings">
      {(s) => <ChoicesForm initial={s.configured ? choicesOf(s) : ALL_ON} onSaved={onSaved} actions={actions} />}
    </Loader>
  );
}

/**
 * Installs that finished onboarding before telemetry existed make the same
 * first choice before the app opens.
 */
export function TelemetryGate({ children }: { children: ReactNode }) {
  const state = useLoad(api.telemetry);
  const [saved, setSaved] = useState(false);
  // Phaethon Dev has no collector: there's nothing to choose before it opens.
  if (saved || state.data?.configured || isDevChannel()) {
    return (
      <>
        <UsageObserver />
        {children}
      </>
    );
  }
  return (
    <main className="page-scroll flex h-full flex-col bg-background">
      <div aria-hidden className="app-drag h-(--titlebar-height) shrink-0" />
      <div className="mx-auto w-full max-w-xl px-6 py-12">
        <h1 className="type-display">Your privacy choices</h1>
        <p className="mt-2 mb-6 text-muted-foreground text-sm">
          Choose what to share with Phaethon’s developers. You can change each choice in Settings → Privacy.
        </p>
        {state.error ? (
          <SurfaceError title="Couldn’t read privacy settings" message={state.error} onRetry={() => void state.reload()} />
        ) : state.data ? (
          <ChoicesForm
            initial={ALL_ON}
            onSaved={() => setSaved(true)}
            actions={(busy) => (
              <Button type="submit" pending={busy} disabled={busy} className="mt-6 w-full">
                Save privacy choices
              </Button>
            )}
          />
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            Loading privacy settings…
          </p>
        )}
      </div>
    </main>
  );
}

/** Counts each view and file opened. The core drops these unless anonymous usage is on. */
function UsageObserver() {
  useEffect(() => {
    let lastView = "";
    let lastFile: unknown = null;
    const observe = () => {
      const nav = useNav.getState();
      const view = nav.settings ? "settings" : nav.view;
      if (view !== lastView) {
        lastView = view;
        void api.telemetryUsage("view_opened", { view }).catch(() => {});
      }
      if (nav.viewer && nav.viewer !== lastFile) {
        void api.telemetryUsage("action_completed", { action: "file_opened" }).catch(() => {});
      }
      lastFile = nav.viewer;
    };
    observe();
    return useNav.subscribe(observe);
  }, []);
  return null;
}

/** Settings → Privacy: each switch saves as soon as it changes. */
export function PrivacySection() {
  const state = useLoad(api.telemetry);
  const [pending, setPending] = useState<TelemetryChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = (choices: TelemetryChoices) => {
    setPending(choices);
    setError(null);
    api
      .saveTelemetry(choices)
      .then(state.setData, async (failure) => {
        setError(cleanMessage(failure));
        await state.reload();
      })
      .finally(() => setPending(null));
  };
  return (
    <Loader state={state} errorTitle="Couldn’t read privacy settings">
      {(s) => (
        <>
          <PrivacyChoices choices={pending ?? choicesOf(s)} onChange={save} disabled={pending !== null} />
          {error ? <FieldError>{error}</FieldError> : null}
          {s.collectorConfigured ? null : (
            <p className="text-muted-foreground text-xs">This build has no telemetry collector, so nothing is sent.</p>
          )}
          {s.reports ? <ReportForm canSend={s.collectorConfigured} /> : null}
        </>
      )}
    </Loader>
  );
}

/** Write, then review the redacted text (and edit it further) before it's sent. */
function ReportForm({ canSend }: { canSend: boolean }) {
  const [text, setText] = useState("");
  const [review, setReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const reviewing = review !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSent(false);
    const request = reviewing
      ? api.sendTelemetryReport(review).then(() => {
          setText("");
          setReview(null);
          setSent(true);
        })
      : api.previewTelemetryReport(text).then(setReview);
    request.catch((failure) => setError(cleanMessage(failure))).finally(() => setBusy(false));
  };

  return (
    <SettingsGroup label="Testing report">
      <form onSubmit={submit}>
        <Field
          label={reviewing ? "Review the text to send" : "What happened?"}
          htmlFor="testing-report"
          hint={reviewing ? "Remove anything else you don’t want to share before sending." : "Up to 4,000 characters."}
        >
          <Textarea
            id="testing-report"
            maxLength={4000}
            value={review ?? text}
            disabled={busy}
            onChange={(e) => {
              (reviewing ? setReview : setText)(e.target.value);
              setSent(false);
            }}
          />
        </Field>
        <div className="flex flex-col gap-2 px-3 pb-3">
          {error ? <FieldError>{error}</FieldError> : null}
          {sent ? (
            <p role="status" className="text-muted-foreground text-xs">
              Thanks. Your report is on its way.
            </p>
          ) : null}
          <div className="flex gap-2">
            {reviewing ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setReview(null)}>
                Back
              </Button>
            ) : null}
            <Button type="submit" size="sm" pending={busy} disabled={busy || !canSend || !(review ?? text).trim()}>
              {reviewing ? "Send report" : "Preview redacted report"}
            </Button>
          </div>
        </div>
      </form>
    </SettingsGroup>
  );
}
