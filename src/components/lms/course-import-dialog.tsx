import { RadioGroup } from "radix-ui";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { radioArrowKeys } from "@/components/settings/controls";
import { announce } from "@/components/shell/announcer";
import { showInLabel } from "@/components/shell/space-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fieldClasses, Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import { lmsConnect, lmsConnections, lmsCourses, lmsSchools, type LmsConnection, type LmsCourse, type LmsKind, type LmsSchool } from "@/lib/lms";
import type { Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import { openSpaceFile } from "@/runtime/records";

import { clearRun, openCourseImport, sitesChanged, startImport, useImportRequest, useRun, type CourseRun, type ImportRequest, type Run } from "./import-store";
import { checkAddress, connectionName, hostOf, isCancelled, isSignedOut, KINDS, kindLabel, plural } from "./sites";

/** Typing pauses this long before the school search runs. */
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN = 2;

type Step = "kind" | "school" | "signin" | "choose" | "progress" | "loading";
/** The four steps that lead to an import, numbered when the flow starts at the first. */
const NUMBERED: Step[] = ["kind", "school", "signin", "choose"];

/** The course site being set up: chosen in the first steps, or an existing connection. */
type Site = { kind: LmsKind; address: string; schoolName?: string };

const nameOfSite = (s: Site) => s.schoolName || hostOf(s.address);

/** Somewhere focus can go back to: still in the page, shown and not inert. */
const canFocus = (el: HTMLElement | null): el is HTMLElement =>
  !!el?.isConnected && !el.closest("[hidden],[inert]") && el.getClientRects().length > 0;

/** One course's summary, as spoken and shown: "12 files, 3 readings downloaded, 5 links listed". */
function resultText(r: NonNullable<CourseRun["result"]>): string {
  const parts = [plural(r.files, "file", "files")];
  parts.push(r.readings ? `${plural(r.readings, "reading", "readings")} downloaded` : "no readings to download");
  if (r.links) parts.push(`${plural(r.links, "link", "links")} to web pages listed`);
  return parts.join(", ");
}

const importedCount = (r: Run) => r.courses.filter((c) => c.result).length;

function endText(r: Run): string {
  const n = importedCount(r);
  if (r.status === "failed" && n === 0) return `The import stopped. ${r.error ?? ""}`.trim();
  if (n === r.courses.length) return `${plural(n, "course", "courses")} imported.`;
  return `${n} of ${r.courses.length} courses imported.`;
}

/** The space that shows a run's courses (Show in Finder, Ask): the one that asked, if it may see them. */
const viewerOf = (r: Run): string | null => (r.spaces.includes(r.space) ? r.space : (r.spaces[0] ?? null));

/**
 * "Import courses": connect a school's course site (Canvas, Brightspace,
 * Moodle, Blackboard) and bring chosen courses in as plain files, for the
 * spaces the person chooses (course sites belong to the whole vault).
 * Opened with openCourseImport() from the palette, a space's menu, the empty
 * conversation and Settings › Course sites.
 *
 * A stepped modal dialog: which site, which school, sign in (in the school's
 * own window), which courses, then the import. Each step's heading is the
 * dialog's title and takes focus when the step shows, so a screen reader
 * hears where it is; Back goes one step back. An import keeps going when the
 * dialog closes: a notice at the foot of the window says how far it is, and
 * says once when it is done.
 */
export function CourseImport({ spaces, onAsk }: { spaces: readonly Space[]; onAsk: (space: string, text: string) => void }) {
  const req = useImportRequest();
  const run = useRun();
  const [open, setOpen] = useState(false);
  // A finished run whose end was seen in the dialog needs no notice.
  const [seen, setSeen] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (req) setOpen(true);
  }, [req]);
  const close = useCallback(() => {
    setOpen(false);
    // A site may have been connected or signed in again.
    sitesChanged();
  }, []);

  // Finished while the dialog was closed: said once, politely; the notice stays until dismissed.
  const said = useRef<number | null>(null);
  useEffect(() => {
    if (!run || run.status === "running" || open || seen === run.key || said.current === run.key) return;
    said.current = run.key;
    announce(endText(run));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, open, seen]);

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        {req && (
          <Flow
            key={req.key}
            req={req}
            spaces={spaces}
            onClose={close}
            onSeen={setSeen}
            onAsk={(space, text) => {
              close();
              onAsk(space, text);
            }}
          />
        )}
      </Dialog>
      {!open && run && (run.status === "running" || seen !== run.key) && (
        <ImportNotice run={run} onShow={() => openCourseImport({ space: run.space, at: "run" })} onDismiss={() => setSeen(run.key)} />
      )}
    </>
  );
}

/** One opening of the dialog: a fresh flow each time (its key is the request's). */
function Flow({
  req,
  spaces,
  onClose,
  onSeen,
  onAsk,
}: {
  req: ImportRequest;
  spaces: readonly Space[];
  onClose: () => void;
  onSeen: (key: number) => void;
  onAsk: (space: string, text: string) => void;
}) {
  const run = useRun();
  // Opened while an import runs (or to see one that finished in the background): straight to it.
  const showRun = !!run && (run.status === "running" || req.at === "run");
  const [step, setStep] = useState<Step>(showRun ? "progress" : req.connection ? (req.at === "signin" ? "signin" : req.at === "sync" ? "loading" : "choose") : "kind");
  const numbered = useRef(step === "kind");
  const [space] = useState(req.space);
  const [connections, setConnections] = useState<LmsConnection[] | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [connection, setConnection] = useState<LmsConnection | null>(null);
  /** Why the sign-in step shows: the session expired. */
  const [signinReason, setSigninReason] = useState<"signedOut" | null>(req.at === "signin" ? "signedOut" : null);
  const [syncError, setSyncError] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const asked = useRef(false);
  const [said, setSaid] = useState("");
  const say = useCallback((m: string) => {
    setSaid("");
    requestAnimationFrame(() => setSaid(m));
  }, []);

  useLayoutEffect(() => {
    if (!showRun) clearRun();
    const at = document.activeElement;
    returnTo.current = at instanceof HTMLElement && at !== document.body ? at : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The vault's course sites: offered first, and the one asked for by id.
  useEffect(() => {
    let live = true;
    lmsConnections().then(
      (cs) => {
        if (!live) return;
        setConnections(cs);
        const c = req.connection ? cs.find((x) => x.id === req.connection) : undefined;
        if (c) {
          setConnection(c);
          setSite({ kind: c.kind, address: c.address, schoolName: c.schoolName });
          if (req.at === "sync" && !showRun) void sync(c);
        } else if (req.connection && !showRun) {
          setStep("kind");
        }
      },
      () => live && setConnections([]),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Import again: the courses imported before, as they are on the site now. */
  async function sync(c: LmsConnection) {
    try {
      const all = await lmsCourses(c.id);
      const chosen = all.filter((x) => c.courses.includes(x.id));
      if (!chosen.length) {
        setStep("choose");
        return;
      }
      // Courses imported before keep who can see them.
      begin(c, chosen, [space]);
    } catch (e) {
      if (isSignedOut(e)) {
        setSigninReason("signedOut");
        go("signin");
      } else {
        setSyncError(String(e));
        go("choose");
      }
    }
  }

  // Each step's heading takes focus as the step shows.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [step]);

  function go(next: Step) {
    setStep(next);
  }

  function back() {
    if (step === "school") go("kind");
    else if (step === "signin") go(connection || !site ? "kind" : "school");
    else if (step === "choose") go("kind");
  }

  function begin(c: LmsConnection, courses: Pick<LmsCourse, "id" | "name">[], viewers: string[]) {
    const ok = startImport(space, viewers, c.id, connectionName(c), courses);
    if (!ok) {
      say("Another import is still running. It shows here.");
    }
    go("progress");
  }

  function onSignedIn(c: LmsConnection) {
    sitesChanged();
    setConnection(c);
    setSite({ kind: c.kind, address: c.address, schoolName: c.schoolName });
    setSigninReason(null);
    say(`Signed in to ${connectionName(c)}.`);
    go("choose");
  }

  const n = NUMBERED.indexOf(step);
  const stepLabel = numbered.current && n >= 0 ? `Step ${n + 1} of ${NUMBERED.length}` : null;

  const frame = { titleRef, stepLabel };
  let body: ReactNode;
  if (step === "kind") {
    body = (
      <KindStep
        {...frame}
        connections={connections}
        initial={site?.kind ?? null}
        onExisting={(c) => {
          setConnection(c);
          setSite({ kind: c.kind, address: c.address, schoolName: c.schoolName });
          if (c.signedIn) go("choose");
          else {
            setSigninReason("signedOut");
            go("signin");
          }
        }}
        onNext={(kind) => {
          if (site?.kind !== kind) setSite({ kind, address: "" });
          setConnection(null);
          go("school");
        }}
      />
    );
  } else if (step === "school" && site) {
    body = (
      <SchoolStep
        {...frame}
        site={site}
        onBack={back}
        onNext={(s) => {
          setSite(s);
          const known = connections?.find((c) => c.kind === s.kind && hostOf(c.address) === hostOf(s.address));
          setConnection(known ?? null);
          if (known?.signedIn) go("choose");
          else {
            setSigninReason(known ? "signedOut" : null);
            go("signin");
          }
        }}
      />
    );
  } else if (step === "signin" && site) {
    body = (
      <SignInStep
        {...frame}
        site={site}
        reason={signinReason}
        onBack={back}
        onSignedIn={onSignedIn}
      />
    );
  } else if (step === "choose" && connection) {
    body = (
      <ChooseStep
        {...frame}
        space={space}
        spaces={spaces}
        connection={connection}
        error={syncError}
        onBack={back}
        onSignedOut={() => {
          setSigninReason("signedOut");
          go("signin");
        }}
        onImport={(viewers, courses) => begin(connection, courses, viewers)}
      />
    );
  } else if (step === "progress") {
    body = <ProgressStep {...frame} spaces={spaces} onSeen={onSeen} onClose={onClose} onAsk={(s, t) => ((asked.current = true), onAsk(s, t))} />;
  } else {
    body = (
      <>
        <DialogTitle ref={titleRef} tabIndex={-1}>
          Import courses
        </DialogTitle>
        <p role="status" className="flex items-center gap-2 text-base text-ink-secondary">
          <Icon name="spinner" className="animate-spin" />
          Loading your course sites…
        </p>
      </>
    );
  }

  return (
    <DialogContent
      data-course-import=""
      data-step={step}
      aria-describedby={undefined}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        titleRef.current?.focus();
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        if (asked.current) return; // the composer takes focus
        const back = returnTo.current;
        const composer = document.querySelector<HTMLElement>("[data-space-pane][data-shown] [data-composer-input]");
        (canFocus(back) ? back : (composer ?? document.getElementById("main")))?.focus();
      }}
      // Escape in the school search closes its list first; a second Escape closes the dialog.
      onEscapeKeyDown={(e) => {
        if (document.activeElement?.matches('[data-school-input][aria-expanded="true"]')) e.preventDefault();
      }}
      // Only Escape and Close close it: a slip outside never loses a half-done step.
      onPointerDownOutside={(e) => e.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
      className="flex flex-col gap-4"
    >
      {body}
      <p role="status" className="sr-only" data-import-said="">
        {said}
      </p>
    </DialogContent>
  );
}

type FrameProps = { titleRef: React.RefObject<HTMLHeadingElement | null>; stepLabel: string | null };

/** A step's heading (the dialog's title, focused when the step shows) and its lead text. */
function StepHead({ titleRef, stepLabel, title, children }: FrameProps & { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 pe-[calc(var(--ph-control-height)+var(--ph-space)*2)]">
      {stepLabel && (
        <p className="text-sm text-ink-secondary" data-step-label="">
          {stepLabel}
        </p>
      )}
      <DialogTitle ref={titleRef} tabIndex={-1} data-step-title="" className="self-start rounded-xs">
        {title}
      </DialogTitle>
      {children && <div className="flex flex-col gap-1.5 text-base text-ink-secondary">{children}</div>}
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{children}</div>;
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button type="button" variant="ghost" onClick={onBack} data-step-back="" className="me-auto">
      <Icon name="chevron-left" />
      Back
    </Button>
  );
}

/** A problem with what was typed or chosen, tied to its field by id. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-sm text-danger-ink" data-field-error="">
      <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Alert({ children, tone = "danger" }: { children: ReactNode; tone?: "danger" | "warning" }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md px-3 py-2.5 text-sm",
        tone === "danger" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink",
        "forced-colors:border forced-colors:border-[CanvasText]",
      )}
    >
      <Icon name={tone === "danger" ? "error" : "warning"} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 wrap-break-word">{children}</div>
    </div>
  );
}

// ---- Step 1: which course site ----

function KindStep({
  connections,
  initial,
  onExisting,
  onNext,
  ...frame
}: FrameProps & {
  connections: LmsConnection[] | null;
  initial: LmsKind | null;
  onExisting: (c: LmsConnection) => void;
  onNext: (kind: LmsKind) => void;
}) {
  const [kind, setKind] = useState<LmsKind | null>(initial);
  const [error, setError] = useState("");
  const groupLabel = useId();
  const errId = useId();
  const groupRef = useRef<HTMLDivElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!kind) {
      setError("Choose the course site your school uses. If you aren’t sure, open it in your browser: its name is usually on the sign-in page.");
      groupRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
      return;
    }
    onNext(kind);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <StepHead {...frame} title="Which course site does your school use?">
        <p>Phaethon reads your courses from it and keeps them as files you can open, for the spaces you choose.</p>
      </StepHead>
      {connections && connections.length > 0 && (
        <div className="flex flex-col gap-2" data-existing-sites="">
          <h3 className="text-md font-semibold text-ink">Already connected</h3>
          <ul className="flex flex-col gap-2">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface px-3.5 py-2.5">
                <span className="flex min-w-0 flex-[1_1_12em] flex-col">
                  <span className="font-medium text-ink wrap-break-word">{connectionName(c)}</span>
                  <span className="text-sm text-ink-secondary">
                    {kindLabel(c.kind)} · {c.signedIn ? "Signed in" : "Signed out"}
                  </span>
                </span>
                <Button type="button" variant="outline" size="sm" data-existing-site={c.id} onClick={() => onExisting(c)}>
                  {c.signedIn ? "Choose courses" : "Sign in again"}
                  <span className="sr-only">{`: ${connectionName(c)}`}</span>
                </Button>
              </li>
            ))}
          </ul>
          <h3 id={groupLabel} className="pt-2 text-md font-semibold text-ink">
            Or connect another course site
          </h3>
        </div>
      )}
      <RadioGroup.Root
        ref={groupRef}
        aria-labelledby={connections?.length ? groupLabel : undefined}
        aria-label={connections?.length ? undefined : "Course site"}
        aria-describedby={error ? errId : undefined}
        aria-required="true"
        value={kind ?? ""}
        onValueChange={(v) => {
          setKind(v as LmsKind);
          setError("");
        }}
        onKeyDownCapture={radioArrowKeys((v) => {
          setKind(v as LmsKind);
          setError("");
        })}
        loop
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,calc(15rem*var(--ph-ui-scale))),1fr))] gap-2"
      >
        {KINDS.map((k) => (
          <RadioGroup.Item
            key={k.kind}
            value={k.kind}
            data-kind={k.kind}
            aria-labelledby={`${groupLabel}-${k.kind}`}
            aria-describedby={`${groupLabel}-${k.kind}-hint`}
            className={cn(
              "group flex min-h-(--ph-control-height-lg) w-full min-w-0 items-start gap-3 rounded-lg border border-line-strong bg-raised px-3.5 py-3 text-start shadow-sm transition-colors duration-(--ph-duration-fast) hover:bg-hover",
              "data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-soft",
            )}
          >
            <span className="mt-0.5 grid size-(--ph-icon-size) shrink-0 place-items-center rounded-full border-2 border-ink-tertiary group-data-[state=checked]:border-accent-fill">
              <RadioGroup.Indicator className="size-[50%] rounded-full bg-accent-fill forced-colors:bg-[CanvasText]" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span id={`${groupLabel}-${k.kind}`} className="text-md font-semibold text-ink">
                {k.label}
              </span>
              <span id={`${groupLabel}-${k.kind}-hint`} className="text-sm wrap-anywhere text-ink-secondary group-data-[state=checked]:text-accent-soft-ink">
                {k.hint}
              </span>
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {error && <FieldError id={errId}>{error}</FieldError>}
      <Footer>
        <Button type="submit" data-step-next="">
          Continue
        </Button>
      </Footer>
    </form>
  );
}

// ---- Step 2: which school ----

function SchoolStep({ site, onBack, onNext, ...frame }: FrameProps & { site: Site; onBack: () => void; onNext: (s: Site) => void }) {
  const canSearch = site.kind === "canvas";
  const [typing, setTyping] = useState(!canSearch || (!!site.address && !site.schoolName));
  const k = KINDS.find((x) => x.kind === site.kind)!;
  const firstRender = useRef(true);
  // Switching between search and the address puts focus in the new field.
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    fieldRef.current?.focus();
  }, [typing]);

  return (
    <div className="flex flex-col gap-4">
      <StepHead {...frame} title="Find your school">
        <p>
          {typing
            ? `Type the address of your school’s ${k.label} site: the address you see when you open it in your browser.`
            : `Search for your school by name. Phaethon looks it up in ${k.label}’s list of schools.`}
        </p>
      </StepHead>
      {typing ? (
        <AddressForm fieldRef={fieldRef} site={site} example={k.example} onBack={onBack} onNext={onNext}>
          {canSearch && (
            <Button type="button" variant="link" data-school-mode="search" onClick={() => setTyping(false)} className="self-start">
              Search for your school by name instead
            </Button>
          )}
        </AddressForm>
      ) : (
        <SchoolSearch fieldRef={fieldRef} site={site} onBack={onBack} onNext={onNext}>
          <Button type="button" variant="link" data-school-mode="address" onClick={() => setTyping(true)} className="self-start">
            Type the address instead
          </Button>
        </SchoolSearch>
      )}
    </div>
  );
}

function AddressForm({
  fieldRef,
  site,
  example,
  onBack,
  onNext,
  children,
}: {
  fieldRef: React.RefObject<HTMLInputElement | null>;
  site: Site;
  example: string;
  onBack: () => void;
  onNext: (s: Site) => void;
  children?: ReactNode;
}) {
  const [value, setValue] = useState(site.address && !site.schoolName ? hostOf(site.address) : "");
  const [error, setError] = useState("");
  const id = useId();
  const hintId = useId();
  const errId = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = checkAddress(value, example);
    if (!r.ok) {
      setError(r.problem);
      fieldRef.current?.focus();
      return;
    }
    onNext({ kind: site.kind, address: r.address });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-base font-medium text-ink">
          Course site address
        </label>
        <Input
          ref={fieldRef}
          id={id}
          value={value}
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={example}
          data-address-input=""
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errId} ${hintId}` : hintId}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError("");
          }}
        />
        <p id={hintId} className="text-sm text-ink-secondary">
          The address you see when you open it in your browser, for example {example}. Only the part before the first / matters.
        </p>
        {error && <FieldError id={errId}>{error}</FieldError>}
      </div>
      {children}
      <Footer>
        <BackButton onBack={onBack} />
        <Button type="submit" data-step-next="">
          Continue
        </Button>
      </Footer>
    </form>
  );
}

/**
 * Canvas's list of schools, searched by name: an editable combobox with a
 * listbox under it. ArrowUp/ArrowDown move the highlighted school
 * (aria-activedescendant), Enter or a click picks it, and the number found is
 * said politely once a search (debounced while typing) is back.
 */
function SchoolSearch({
  fieldRef,
  site,
  onBack,
  onNext,
  children,
}: {
  fieldRef: React.RefObject<HTMLInputElement | null>;
  site: Site;
  onBack: () => void;
  onNext: (s: Site) => void;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState(site.schoolName ?? "");
  const [picked, setPicked] = useState<LmsSchool | null>(site.schoolName ? { name: site.schoolName, address: site.address } : null);
  const [state, setState] = useState<{ status: "idle" | "searching" } | { status: "ready"; results: LmsSchool[]; query: string } | { status: "error"; message: string }>({ status: "idle" });
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const id = useId();
  const listId = useId();
  const hintId = useId();
  const statusId = useId();
  const errId = useId();
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (picked || q.length < SEARCH_MIN) {
      seq.current++;
      setState({ status: "idle" });
      return;
    }
    const mine = ++seq.current;
    setState((s) => (s.status === "ready" ? s : { status: "searching" }));
    const t = setTimeout(() => {
      lmsSchools(site.kind, q).then(
        (results) => {
          if (seq.current !== mine) return;
          setState({ status: "ready", results, query: q });
          setActive(0);
        },
        (e: unknown) => seq.current === mine && setState({ status: "error", message: String(e) }),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, picked, site.kind]);

  const results = state.status === "ready" ? state.results : [];
  const listed = !picked && results.length > 0;
  const current = Math.min(active, results.length - 1);
  const optionId = (i: number) => `${listId}-o${i}`;

  useEffect(() => {
    if (listed && current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, listed]);

  function pick(s: LmsSchool | undefined) {
    if (!s) return;
    setPicked(s);
    setQuery(s.name);
    setError("");
    fieldRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = listed ? results.length : 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((a) => (e.key === "ArrowDown" ? (Math.min(a, n - 1) + 1) % n : (Math.min(a, n - 1) - 1 + n) % n));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && n) {
      e.preventDefault();
      pick(results[current]);
    } else if (e.key === "Escape" && n) {
      // The list closes first; a second Escape closes the dialog.
      // The dialog leaves it alone (onEscapeKeyDown below).
      setState({ status: "idle" });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!picked) {
      setError(query.trim() ? "Choose your school from the list, or type the address instead." : "Type your school’s name, then choose it from the list.");
      fieldRef.current?.focus();
      return;
    }
    onNext({ kind: site.kind, address: picked.address, schoolName: picked.name });
  }

  const status =
    state.status === "ready"
      ? state.results.length
        ? `${plural(state.results.length, "school", "schools")} found.`
        : `No school matches “${state.query}”. Try another part of its name, or type the address instead.`
      : state.status === "error"
        ? `The school search didn’t work. ${state.message} You can type the address instead.`
        : state.status === "searching"
          ? "Searching…"
          : "";

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-base font-medium text-ink">
          School
        </label>
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
          <input
            ref={fieldRef}
            id={id}
            role="combobox"
            aria-expanded={listed}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={listed && current >= 0 ? optionId(current) : undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={[error && errId, picked ? `${id}-picked` : hintId, statusId].filter(Boolean).join(" ")}
            autoComplete="off"
            spellCheck={false}
            data-school-input=""
            value={query}
            placeholder="For example, Indiana University"
            onChange={(e) => {
              setQuery(e.target.value);
              setPicked(null);
              setActive(0);
              if (error) setError("");
            }}
            onKeyDown={onKeyDown}
            className={cn(fieldClasses, "min-h-(--ph-control-height-lg) ps-[calc(var(--ph-icon-size)+var(--ph-space)*4)] pe-2.5")}
          />
        </div>
        {/* Always in the page, so the listbox the field controls exists; empty while nothing is listed. */}
        <ul
          id={listId}
          role="listbox"
          aria-label="Schools"
          hidden={!listed}
          className="flex max-h-[calc(var(--ph-control-height-lg)*5)] flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-md border border-line bg-raised p-1 shadow-sm"
        >
          {listed &&
            results.map((s, i) => (
              <li
                key={`${s.address}-${s.name}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                data-school-option=""
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== current && setActive(i)}
                onClick={() => pick(s)}
                className={cn(
                  "flex min-h-(--ph-control-height-lg) shrink-0 cursor-default flex-col justify-center rounded-sm px-2.5 py-1.5 text-base text-ink",
                  "aria-selected:bg-selected forced-colors:aria-selected:outline-2 forced-colors:aria-selected:outline-[Highlight]",
                )}
              >
                <span className="wrap-break-word">{s.name}</span>
                <span className="text-sm wrap-anywhere text-ink-secondary">{hostOf(s.address)}</span>
              </li>
            ))}
        </ul>
        {picked ? (
          <p id={`${id}-picked`} className="flex items-start gap-1.5 text-sm text-ink-secondary" data-school-picked="">
            <Icon name="check" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0 text-success-ink" />
            <span className="min-w-0 wrap-anywhere">
              {picked.name}, at {hostOf(picked.address)}
            </span>
          </p>
        ) : (
          <p id={hintId} className="text-sm text-ink-secondary">
            Type at least {SEARCH_MIN} letters of its name, then pick it with the arrow keys and Enter.
          </p>
        )}
        <p id={statusId} role="status" className="text-sm text-ink-secondary empty:hidden" data-school-status="">
          {status}
        </p>
        {error && <FieldError id={errId}>{error}</FieldError>}
      </div>
      {children}
      <Footer>
        <BackButton onBack={onBack} />
        <Button type="submit" data-step-next="">
          Continue
        </Button>
      </Footer>
    </form>
  );
}

// ---- Step 3: sign in ----

function SignInStep({
  site,
  reason,
  onBack,
  onSignedIn,
  ...frame
}: FrameProps & {
  site: Site;
  reason: "signedOut" | null;
  onBack: () => void;
  onSignedIn: (c: LmsConnection) => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<{ tone: "danger" | "warning"; text: string } | null>(null);
  const attempt = useRef(0);
  const openRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const problemId = useId();
  const school = nameOfSite(site);
  useEffect(() => () => void attempt.current++, []);

  async function signIn() {
    const mine = ++attempt.current;
    setProblem(null);
    setWaiting(true);
    requestAnimationFrame(() => cancelRef.current?.focus());
    try {
      const c = await lmsConnect(site.kind, site.address, site.schoolName);
      if (attempt.current !== mine) return;
      setWaiting(false);
      onSignedIn(c);
    } catch (e) {
      if (attempt.current !== mine) return;
      setWaiting(false);
      setProblem(
        isCancelled(e)
          ? { tone: "warning", text: "The sign-in window was closed before you finished signing in. Open it again when you’re ready." }
          : { tone: "danger", text: `Signing in didn’t work. ${String(e)}` },
      );
      requestAnimationFrame(() => openRef.current?.focus());
    }
  }

  function cancel() {
    attempt.current++;
    setWaiting(false);
    setProblem({ tone: "warning", text: "Stopped waiting. If the sign-in window is still open, you can close it." });
    requestAnimationFrame(() => openRef.current?.focus());
  }

  return (
    <div className="flex flex-col gap-4">
      <StepHead {...frame} title={reason === "signedOut" ? `Sign in to ${school} again` : `Sign in to ${school}`}>
        {reason === "signedOut" ? (
          <p>You’ve been signed out of {school}, so Phaethon can’t see your courses. Sign in again to carry on.</p>
        ) : null}
        <p>
          Phaethon opens your school’s own sign-in page ({hostOf(site.address)}) in a separate window. Sign in there as you always do, including any
          extra check your school asks for.
        </p>
      </StepHead>
      {waiting ? (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3 text-base text-ink" data-signin-waiting="">
          <Icon name="spinner" className="mt-0.5 shrink-0 text-ink-secondary motion-safe:animate-spin" />
          <p>
            Finish signing in in the window that opened. Phaethon only keeps the session your sign-in creates, in your keychain on this computer, and only
            uses it to read your courses.
          </p>
        </div>
      ) : (
        <p className="flex items-start gap-2 text-sm text-ink-secondary">
          <Icon name="lock" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0 text-ink-tertiary" />
          <span>Your password goes only to your school. Phaethon keeps the session it leaves, in your keychain on this computer, and only reads from {school}: it never changes anything there.</span>
        </p>
      )}
      {problem && (
        <div id={problemId} data-signin-problem={problem.tone}>
          <Alert tone={problem.tone}>{problem.text}</Alert>
        </div>
      )}
      <Footer>
        {!waiting && <BackButton onBack={onBack} />}
        {waiting ? (
          <Button ref={cancelRef} type="button" variant="outline" data-signin-cancel="" onClick={cancel}>
            Cancel
          </Button>
        ) : (
          <Button ref={openRef} type="button" data-signin-open="" aria-describedby={problem ? problemId : undefined} onClick={() => void signIn()}>
            <Icon name="lock" />
            {problem ? "Open sign-in window again" : "Open sign-in window"}
          </Button>
        )}
      </Footer>
    </div>
  );
}

// ---- Step 4: choose courses ----

function ChooseStep({
  space,
  spaces,
  connection,
  error: syncError,
  onBack,
  onSignedOut,
  onImport,
  ...frame
}: FrameProps & {
  space: string;
  spaces: readonly Space[];
  connection: LmsConnection;
  error: string;
  onBack: () => void;
  onSignedOut: () => void;
  onImport: (viewers: string[], courses: LmsCourse[]) => void | Promise<void>;
}) {
  const [courses, setCourses] = useState<LmsCourse[] | null>(null);
  const [loadError, setLoadError] = useState(syncError);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // Who can see the courses: the space asking, unless the person chooses otherwise.
  const [viewers, setViewers] = useState<Set<string>>(() => new Set([space]));
  const [viewerError, setViewerError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errId = useId();
  const spaceId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const school = connectionName(connection);

  const load = useCallback(() => {
    setLoadError("");
    setCourses(null);
    lmsCourses(connection.id).then(
      (cs) => {
        setCourses(cs);
        // Current courses not imported yet start checked; past ones and ones already here don't.
        setChosen(new Set(cs.filter((c) => c.current && !c.imported).map((c) => c.id)));
      },
      (e: unknown) => {
        if (isSignedOut(e)) onSignedOut();
        else setLoadError(String(e));
      },
    );
  }, [connection.id, onSignedOut]);
  useEffect(() => {
    if (!syncError) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = courses?.filter((c) => c.current) ?? [];
  const past = courses?.filter((c) => !c.current) ?? [];

  function toggle(id: string, on: boolean) {
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    setError("");
  }
  function setAll(list: LmsCourse[], on: boolean) {
    setChosen((s) => {
      const next = new Set(s);
      for (const c of list) {
        if (on) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });
    setError("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!courses || busy) return;
    const picked = courses.filter((c) => chosen.has(c.id));
    if (!picked.length) {
      setError("Choose at least one course to import.");
      listRef.current?.querySelector<HTMLElement>('input[type="checkbox"]')?.focus();
      return;
    }
    if (!viewers.size) {
      setViewerError("Choose at least one space that can see these courses.");
      document.querySelector<HTMLElement>("[data-import-viewer] input")?.focus();
      return;
    }
    setBusy(true);
    try {
      await onImport(
        spaces.filter((s) => viewers.has(s.id)).map((s) => s.id),
        picked,
      );
    } finally {
      setBusy(false);
    }
  }

  const count = chosen.size;
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <StepHead {...frame} title="Choose courses to import">
        <p>
          From {school}. Courses you imported before are updated: only new or changed files are downloaded.
        </p>
      </StepHead>
      {loadError ? (
        <Alert>
          <p>Your courses couldn’t be listed. {loadError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={load}>
            <Icon name="retry" />
            Try again
          </Button>
        </Alert>
      ) : !courses ? (
        <p role="status" className="flex items-center gap-2 text-base text-ink-secondary" data-courses-loading="">
          <Icon name="spinner" className="motion-safe:animate-spin" />
          Getting your courses from {school}…
        </p>
      ) : (
        <div ref={listRef} className="flex flex-col gap-3" data-course-list="">
          <CourseGroup
            title="Current courses"
            courses={current}
            chosen={chosen}
            onToggle={toggle}
            onAll={(on) => setAll(current, on)}
            empty="No current courses. Your past courses are below."
            describedBy={error ? errId : undefined}
          />
          {past.length > 0 && (
            <details className="group/past flex flex-col" data-past-courses="">
              <summary className="inline-flex min-h-(--ph-target-min) cursor-default items-center gap-1.5 self-start rounded-sm pe-1 text-base font-medium text-ink select-none [&::-webkit-details-marker]:hidden">
                <Icon name="chevron-right" className="size-(--ph-icon-size-sm) transition-transform duration-(--ph-duration-fast) group-open/past:rotate-90" />
                Past courses ({past.length})
              </summary>
              <div className="pt-2">
                <CourseGroup title="Past courses" courses={past} chosen={chosen} onToggle={toggle} onAll={(on) => setAll(past, on)} empty="" hideTitle />
              </div>
            </details>
          )}
          {error && <FieldError id={errId}>{error}</FieldError>}
        </div>
      )}
      <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={`${spaceId}-what${viewerError ? ` ${spaceId}-err` : ""}`} data-import-viewers="">
        <legend className="float-start text-base font-medium text-ink">Who can see these courses</legend>
        <p id={`${spaceId}-what`} className="clear-both text-sm text-ink-secondary" data-import-what="">
          Each course gets a folder with its syllabus, assignments, files and the readings it links to. The spaces you check can see all of each new course;
          choose part by part later in Settings › Course sites. Courses imported before keep who can see them.
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {spaces.map((s) => (
            <li key={s.id}>
              <label className="flex min-h-(--ph-target-min) cursor-default items-center gap-2 text-base text-ink" data-import-viewer={s.id}>
                <input
                  type="checkbox"
                  checked={viewers.has(s.id)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setViewers((v) => {
                      const next = new Set(v);
                      if (on) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    });
                    setViewerError("");
                  }}
                  className="size-(--ph-icon-size) shrink-0 accent-accent-fill"
                />
                {s.name}
                {s.id === space && <span className="text-sm text-ink-secondary">(this space)</span>}
              </label>
            </li>
          ))}
        </ul>
        {viewerError && <FieldError id={`${spaceId}-err`}>{viewerError}</FieldError>}
      </fieldset>
      <Footer>
        <BackButton onBack={onBack} />
        <Button type="submit" disabled={!courses || busy} data-step-next="" data-import-start="">
          <Icon name="download" />
          {count ? `Import ${plural(count, "course", "courses")}` : "Import"}
        </Button>
      </Footer>
    </form>
  );
}

function CourseGroup({
  title,
  courses,
  chosen,
  onToggle,
  onAll,
  empty,
  hideTitle,
  describedBy,
}: {
  title: string;
  courses: LmsCourse[];
  chosen: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onAll: (on: boolean) => void;
  empty: string;
  hideTitle?: boolean;
  describedBy?: string;
}) {
  const legendId = useId();
  const lower = title.toLowerCase();
  return (
    <fieldset aria-describedby={describedBy} className="flex min-w-0 flex-col gap-1.5" data-course-group={lower}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <legend id={legendId} className={cn("float-start text-base font-medium text-ink", hideTitle && "sr-only")}>
          {title}
        </legend>
        {courses.length > 1 && (
          <span className="flex gap-1">
            <Button type="button" variant="ghost" size="xs" aria-label={`Select all ${lower}`} onClick={() => onAll(true)} data-select="all">
              Select all
            </Button>
            <Button type="button" variant="ghost" size="xs" aria-label={`Select none of the ${lower}`} onClick={() => onAll(false)} data-select="none">
              Select none
            </Button>
          </span>
        )}
      </div>
      {courses.length === 0 ? (
        empty && <p className="text-sm text-ink-secondary">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised">
          {courses.map((c) => (
            <li key={c.id}>
              <label className="flex min-h-(--ph-control-height-lg) cursor-default items-start gap-3 px-3.5 py-2.5 hover:bg-hover" data-course={c.id}>
                <input
                  type="checkbox"
                  checked={chosen.has(c.id)}
                  onChange={(e) => onToggle(c.id, e.target.checked)}
                  className="mt-[calc((1lh-var(--ph-icon-size))/2)] size-(--ph-icon-size) shrink-0 accent-accent-fill"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium wrap-break-word text-ink">{c.name}</span>
                  <span className="text-sm text-ink-secondary">
                    {[c.code, c.term].filter(Boolean).join(" · ")}
                    {c.imported && (
                      <span data-course-imported="">
                        {c.code || c.term ? " · " : ""}Imported before
                      </span>
                    )}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

// ---- The import ----

function ProgressStep({
  spaces,
  onSeen,
  onClose,
  onAsk,
  ...frame
}: FrameProps & { spaces: readonly Space[]; onSeen: (key: number) => void; onClose: () => void; onAsk: (space: string, text: string) => void }) {
  const run = useRun();
  const [said, setSaid] = useState("");
  const [showError, setShowError] = useState("");
  const before = useRef<Run | null>(run);

  // Said politely, once per course as it finishes and once at the end: never each step.
  useEffect(() => {
    const prev = before.current;
    before.current = run;
    if (!run || !prev || prev.key !== run.key) return;
    const lines: string[] = [];
    for (const c of run.courses) {
      const was = prev.courses.find((x) => x.id === c.id);
      if (c.result && !was?.result) lines.push(`Imported ${c.name}.`);
      else if (c.failed && !was?.failed && run.status === "running") lines.push(`${c.name} couldn’t be imported.`);
    }
    if (prev.status === "running" && run.status !== "running") {
      lines.push(endText(run));
      onSeen(run.key);
    }
    if (lines.length) {
      setSaid("");
      requestAnimationFrame(() => setSaid(lines.join(" ")));
    }
  }, [run, spaces, onSeen]);

  // Seen here once finished, so no notice follows.
  useEffect(() => {
    if (run && run.status !== "running") onSeen(run.key);
  }, [run, onSeen]);

  if (!run) {
    return (
      <StepHead {...frame} title="Nothing is being imported">
        <p>Start an import from a space’s menu or the command palette.</p>
      </StepHead>
    );
  }
  const running = run.status === "running";
  const viewer = viewerOf(run);
  const seenBy = run.spaces.map((id) => spaces.find((s) => s.id === id)?.name ?? id);
  const done = importedCount(run);

  async function show(c: CourseRun) {
    if (!c.result) return;
    setShowError("");
    try {
      if (!viewer) return;
      await openSpaceFile(viewer, `${c.result.folder}/README.md`, true);
    } catch (e) {
      setShowError(`${c.name}’s folder couldn’t be shown. ${String(e)}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <StepHead {...frame} stepLabel={null} title={running ? "Importing courses" : run.status === "failed" && !done ? "The import stopped" : "Import finished"}>
        <p>
          {running
            ? "You can close this window: the import keeps going, and Phaethon says when it’s done."
            : `From ${run.school}. ${endText(run)}`}
        </p>
        <p data-import-seen-by="">
          {seenBy.length ? `New courses can be seen in ${seenBy.join(", ")}.` : "No space can see the new courses yet: choose in Settings › Course sites."}
        </p>
      </StepHead>
      {run.status === "failed" && run.error && <Alert>{run.error}</Alert>}
      {run.notes?.map((n) => (
        <p key={n} data-import-note="">
          {n}
        </p>
      ))}
      {showError && <Alert>{showError}</Alert>}
      <ul className="flex flex-col gap-2" aria-label="Courses" data-import-list="">
        {run.courses.map((c) => (
          <CourseProgress key={c.id} course={c} running={running} onShow={viewer ? () => void show(c) : undefined} onAsk={viewer ? () => onAsk(viewer, askText(c)) : undefined} />
        ))}
      </ul>
      <p role="status" className="sr-only" data-import-status="">
        {said}
      </p>
      <Footer>
        <Button type="button" variant={running ? "outline" : "default"} onClick={onClose} data-import-close="">
          {running ? "Close" : "Done"}
        </Button>
      </Footer>
    </div>
  );
}

/** What the core is doing for a course, in words ("Downloading files: 3 of 12"). */
const STEP_WORDS: Record<string, string> = {
  reading: "Reading the course",
  files: "Downloading files",
  readings: "Downloading readings",
  writing: "Writing the course folder",
};
function stepText(c: CourseRun): string {
  const words = STEP_WORDS[c.step ?? ""] ?? c.step ?? "";
  return c.total > 1 ? `${words}: ${Math.min(c.done, c.total)} of ${c.total}` : words;
}

const askText = (c: CourseRun) => `What’s coming up in ${c.name}, and what should I read first?`;

function CourseProgress({ course: c, running, onShow, onAsk }: { course: CourseRun; running: boolean; onShow?: () => void; onAsk?: () => void }) {
  const nameId = useId();
  const state = c.result ? "done" : c.failed ? "failed" : c.step ? "working" : "waiting";
  const total = Math.max(c.total, 1);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-raised px-3.5 py-3" data-import-course={c.id} data-state={state}>
      <div className="flex items-start gap-2">
        <Icon
          name={state === "done" ? "success" : state === "failed" ? "error" : state === "working" ? "spinner" : "file-text"}
          className={cn(
            "mt-0.5 shrink-0",
            state === "done" ? "text-success-ink" : state === "failed" ? "text-danger-ink" : "text-ink-secondary",
            state === "working" && "motion-safe:animate-spin",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id={nameId} className="text-base font-semibold wrap-break-word text-ink">
            {c.name}
          </h3>
          <p className="text-sm text-ink-secondary" data-course-status="">
            {state === "done"
              ? `${resultText(c.result!)}.`
              : state === "failed"
                ? `Not imported. ${c.failed}`
                : state === "working"
                  ? stepText(c)
                  : running
                    ? "Waiting"
                    : "Not imported."}
          </p>
        </div>
      </div>
      {(state === "working" || state === "waiting") && running && (
        <div
          role="progressbar"
          aria-labelledby={nameId}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={Math.min(c.done, total)}
          aria-valuetext={state === "waiting" ? "Waiting" : stepText(c)}
          className="h-1.5 overflow-hidden rounded-full bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]"
        >
          <div
            className="h-full rounded-full bg-accent-fill transition-[width] duration-(--ph-duration) forced-colors:bg-[Highlight]"
            style={{ width: `${(Math.min(c.done, total) / total) * 100}%` }}
          />
        </div>
      )}
      {state === "done" && c.result!.skipped.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-ink forced-colors:border forced-colors:border-[CanvasText]" data-course-skipped="">
          <p className="font-medium">Some parts couldn’t be imported:</p>
          <ul className="flex list-disc flex-col ps-4">
            {c.result!.skipped.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {state === "done" && onShow && onAsk && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onShow} data-course-show="">
            <Icon name="folder" />
            {showInLabel()}
            <span className="sr-only">{`: ${c.name}`}</span>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onAsk} data-course-ask="">
            <Icon name="agent" />
            Ask about this course
            <span className="sr-only">{`: ${c.name}`}</span>
          </Button>
        </div>
      )}
    </li>
  );
}

// ---- While the dialog is closed ----

/**
 * At the foot of the window while the dialog is closed: how far an import is,
 * then how it ended (said once, politely, when it ends). Never takes focus;
 * Show opens the dialog on it.
 */
function ImportNotice({ run, onShow, onDismiss }: { run: Run; onShow: () => void; onDismiss: () => void }) {
  const msgId = useId();
  const running = run.status === "running";
  const finished = run.courses.filter((c) => c.result || c.failed).length;
  return createPortal(
    <section
      aria-label={running ? "Importing courses" : "Import finished"}
      data-import-notice={running ? "running" : "done"}
      className={cn(
        "fixed start-(--ph-pane-inset) bottom-(--ph-pane-inset) z-40 flex w-[calc(var(--ph-sidebar-width)-var(--ph-pane-inset))] max-w-[calc(100%-var(--ph-pane-inset)*2)] items-start gap-2.5",
        "rounded-lg border border-line bg-raised px-3.5 py-3 text-base text-ink shadow-lg forced-colors:border-[CanvasText]",
      )}
    >
      <Icon
        name={running ? "spinner" : importedCount(run) === run.courses.length ? "success" : "warning"}
        className={cn("mt-0.5 shrink-0", running ? "text-ink-secondary motion-safe:animate-spin" : importedCount(run) === run.courses.length ? "text-success-ink" : "text-warning-ink")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p id={msgId} className="wrap-break-word">
          {running ? `Importing courses: ${finished} of ${run.courses.length} done.` : endText(run)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" aria-describedby={msgId} onClick={onShow} data-import-notice-show="">
            {running ? "Show progress" : "Show summary"}
          </Button>
          {!running && (
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss} data-import-notice-dismiss="">
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </section>,
    document.body,
  );
}
