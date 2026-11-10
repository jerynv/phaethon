/**
 * Connecting a course site and choosing what to import: the site (Canvas,
 * Brightspace, Moodle, Blackboard), the school (search for Canvas, else the
 * address), signing in (the window opens natively; this waits for it), the
 * courses, the spaces that may see them, then a look before importing. The
 * import itself runs outside the dialog and shows on the Courses page.
 */
import { CheckIcon, ExternalLinkIcon, LoaderIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { lmsConnect, lmsCourses, lmsSchools } from "./api";
import { useImportRun } from "./import-store";
import { checkAddress, connectionName, hostOf, isCancelled, isSignedOut, KINDS, kindLabel, plural } from "./lib/sites";
import type { LmsConnection, LmsCourse, LmsKind, LmsSchool, SpaceSummary } from "./lib/types";
import { announce } from "./shared/announce";
import { LiveText } from "./shared/kit";
import { sitesChanged } from "./shared/signals";

export type ConnectRequest = { key: number; connection?: LmsConnection; at?: "signin" | "choose" };
type Step = "kind" | "school" | "signin" | "choose" | "spaces" | "review";

const selectionKey = (id: string) => `phaethon.lms-selection.${id}`;
function savedSelection(id: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(selectionKey(id)) ?? "null") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

export function ConnectDialog({
  space,
  spaces,
  connections,
  request,
  onClose,
}: {
  space: string;
  spaces: SpaceSummary[];
  connections: LmsConnection[];
  request: ConnectRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      {request && <ConnectFlow key={request.key} space={space} spaces={spaces} connections={connections} request={request} onClose={onClose} />}
    </Dialog>
  );
}

function ConnectFlow({ space, spaces, connections, request, onClose }: { space: string; spaces: SpaceSummary[]; connections: LmsConnection[]; request: ConnectRequest; onClose: () => void }) {
  const id = useId();
  const startImport = useImportRun((s) => s.start);
  const [step, setStep] = useState<Step>(request.connection ? (request.at === "signin" || !request.connection.signedIn ? "signin" : "choose") : "kind");
  const [kind, setKind] = useState<LmsKind | null>(request.connection?.kind ?? null);
  const [school, setSchool] = useState<LmsSchool | null>(request.connection ? { name: connectionName(request.connection), address: request.connection.address } : null);
  const [conn, setConn] = useState<LmsConnection | null>(request.connection ?? null);
  const [courses, setCourses] = useState<LmsCourse[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [viewers, setViewers] = useState<string[]>([space]);
  const [problem, setProblem] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headingRef.current?.focus(), [step]);

  // The courses, once per flow.
  useEffect(() => {
    if (step !== "choose" || !conn || courses) return;
    setProblem(null);
    lmsCourses(conn.id).then(
      (list) => {
        setCourses(list);
        const saved = savedSelection(conn.id);
        const ids = new Set(list.map((c) => c.id));
        // A saved choice holds, plus any course that became current since.
        setChosen(saved ? [...new Set([...saved.filter((x) => ids.has(x)), ...list.filter((c) => c.current && !c.imported && !saved.includes(c.id) && !c.partial).map((c) => c.id)])] : list.filter((c) => c.imported || c.partial || c.current).map((c) => c.id));
      },
      (e) => {
        if (isSignedOut(e)) setStep("signin");
        else setProblem(errorText(e));
      },
    );
  }, [step, conn, courses]);

  const title: Record<Step, string> = {
    kind: "Connect a course site",
    school: kind ? `Find your ${kindLabel(kind)} site` : "Find your site",
    signin: `Sign in to ${school?.name ?? "your course site"}${conn && !conn.signedIn ? " again" : ""}`,
    choose: "Choose courses to import",
    spaces: "Who can see them",
    review: "Ready to import",
  };

  const next = () => {
    setProblem(null);
    if (step === "kind") {
      if (!kind) return setProblem("Choose a course site.");
      setStep("school");
    } else if (step === "choose") {
      if (!chosen.length) return setProblem("Choose at least one course to import.");
      try {
        if (conn) localStorage.setItem(selectionKey(conn.id), JSON.stringify(chosen));
      } catch {
        // Not remembered: fine.
      }
      setStep("spaces");
    } else if (step === "spaces") {
      if (!viewers.length) return setProblem("Choose at least one space.");
      setStep("review");
    } else if (step === "review" && conn && courses) {
      const picked = courses.filter((c) => chosen.includes(c.id));
      if (!startImport(space, viewers, conn.id, connectionName(conn), picked)) return setProblem("Another import is still running. It shows on the Courses page.");
      announce(`Importing ${plural(picked.length, "course")}.`);
      onClose();
    }
  };
  const back = () => {
    setProblem(null);
    setStep(step === "school" ? "kind" : step === "signin" ? (request.connection ? "signin" : "school") : step === "choose" ? (request.connection ? "choose" : "kind") : step === "spaces" ? "choose" : "spaces");
  };

  const onSchool = (s: LmsSchool) => {
    setSchool(s);
    const known = connections.find((c) => c.kind === kind && hostOf(c.address) === hostOf(s.address));
    if (known) {
      setConn(known);
      setStep(known.signedIn ? "choose" : "signin");
    } else setStep("signin");
  };

  return (
    <DialogPopup className="max-w-lg" aria-labelledby={`${id}-t`}>
      <DialogHeader>
        <DialogTitle id={`${id}-t`} ref={headingRef} tabIndex={-1} className="outline-none">
          {title[step]}
        </DialogTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {step === "kind" && (
          <>
            {connections.length > 0 && (
              <section className="flex flex-col gap-2" aria-labelledby={`${id}-have`}>
                <h3 id={`${id}-have`} className="text-sm font-medium">
                  Already connected
                </h3>
                <ul className="divide-y rounded-xl border">
                  {connections.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium">{connectionName(c)}</span>
                        <span className="text-sm text-muted-foreground">
                          {kindLabel(c.kind)} · {c.signedIn ? "Signed in" : "Signed out"}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setConn(c);
                          setKind(c.kind);
                          setSchool({ name: connectionName(c), address: c.address });
                          setStep(c.signedIn ? "choose" : "signin");
                        }}
                      >
                        {c.signedIn ? "Choose courses" : "Sign in again"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{connections.length ? "Connect another site" : "Your school’s course site"}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {KINDS.map((k) => (
                  <label key={k.kind} className={cn("flex cursor-pointer flex-col gap-0.5 rounded-xl border p-3 has-focus-visible:ring-2 has-focus-visible:ring-ring", kind === k.kind ? "border-primary bg-primary/6" : "hover:bg-accent")}>
                    <input type="radio" name={`${id}-kind`} className="sr-only" checked={kind === k.kind} onChange={() => setKind(k.kind)} />
                    <span className="flex items-center justify-between text-sm font-medium">
                      {k.label}
                      {kind === k.kind && <CheckIcon aria-hidden className="size-4 text-primary" />}
                    </span>
                    <span className="text-sm break-words text-muted-foreground">{k.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}

        {step === "school" && kind && <SchoolStep kind={kind} onPick={onSchool} />}

        {step === "signin" && kind && school && <SignInStep kind={kind} school={school} again={!!conn && !conn.signedIn} onSignedIn={(c) => (setConn(c), setCourses(null), setStep("choose"))} />}

        {step === "choose" && (
          <ChooseStep courses={courses} chosen={chosen} setChosen={setChosen} />
        )}

        {step === "spaces" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm text-muted-foreground">Spaces that see a course can read its files and ask about it. Courses imported before keep who can see them.</legend>
            <ul className="divide-y rounded-xl border">
              {spaces.map((s) => (
                <li key={s.id} className="px-3 py-2.5">
                  <Label className="flex items-center gap-2.5 text-sm font-normal">
                    <Checkbox checked={viewers.includes(s.id)} onCheckedChange={(on) => setViewers((v) => (on ? [...v, s.id] : v.filter((x) => x !== s.id)))} />
                    <span className="font-medium">{s.name}</span>
                    {s.id === space && <span className="text-muted-foreground">this space</span>}
                  </Label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        {step === "review" && conn && courses && (
          <dl className="flex flex-col divide-y rounded-xl border text-sm">
            <Review label="From" onChange={() => setStep("kind")}>
              {connectionName(conn)}
            </Review>
            <Review label="Courses" onChange={() => setStep("choose")}>
              {courses
                .filter((c) => chosen.includes(c.id))
                .map((c) => c.name)
                .join(", ")}
            </Review>
            <Review label="Seen by" onChange={() => setStep("spaces")}>
              {spaces
                .filter((s) => viewers.includes(s.id))
                .map((s) => s.name)
                .join(", ")}
            </Review>
          </dl>
        )}

        <LiveText>{problem ?? ""}</LiveText>
        {problem && (
          <p className="text-sm text-destructive-foreground" data-connect-problem="">
            {problem}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        {step !== "kind" && !(request.connection && (step === "signin" || step === "choose")) && (
          <Button variant="ghost" onClick={back} className="sm:me-auto">
            Back
          </Button>
        )}
        {(step === "kind" || step === "choose" || step === "spaces" || step === "review") && (
          <Button onClick={next} disabled={step === "choose" && !courses}>
            {step === "review" ? `Import ${plural(chosen.length, "course")}` : "Next"}
          </Button>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}

function Review({ label, children, onChange }: { label: string; children: ReactNode; onChange: () => void }) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
      <Button size="xs" variant="ghost" onClick={onChange} aria-label={`Change ${label.toLowerCase()}`}>
        Change
      </Button>
    </div>
  );
}

/** Canvas: search for the school by name (a combobox). Other sites, or by choice: type the address. */
function SchoolStep({ kind, onPick }: { kind: LmsKind; onPick: (s: LmsSchool) => void }) {
  const id = useId();
  const info = KINDS.find((k) => k.kind === kind)!;
  const [mode, setMode] = useState<"search" | "address">(kind === "canvas" ? "search" : "address");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LmsSchool[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (mode !== "search") return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      lmsSchools(kind, q).then(
        (r) => {
          if (n !== seq.current) return;
          setResults(r);
          setSearchError(null);
          setActive(r.length ? 0 : -1);
          setOpen(true);
        },
        (e) => n === seq.current && setSearchError(errorText(e)),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [query, kind, mode]);

  const status = searchError ?? (results == null ? "" : results.length ? `${plural(results.length, "school")} found.` : `No school matches “${query.trim()}”. Try its full name, or type the address.`);

  if (mode === "address")
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const r = checkAddress(address, info.example);
          if (!r.ok) return setProblem(r.problem);
          onPick({ name: hostOf(r.address), address: r.address });
        }}
      >
        <Label htmlFor={`${id}-a`}>Address of your course site</Label>
        <Input id={`${id}-a`} autoFocus inputMode="url" placeholder={info.example} value={address} onChange={(e) => setAddress(e.target.value)} aria-invalid={!!problem || undefined} aria-describedby={`${id}-ah`} />
        <p id={`${id}-ah`} className="text-sm text-muted-foreground">
          Usually {info.hint}. Copy it from your browser.
        </p>
        {problem && <p className="text-sm text-destructive-foreground">{problem}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {kind === "canvas" ? (
            <Button type="button" variant="link" className="px-0" onClick={() => setMode("search")}>
              Search for your school instead
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit">Next</Button>
        </div>
      </form>
    );

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-q`}>Your school</Label>
      <div className="flex flex-col gap-1">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
          id={`${id}-q`}
          autoFocus
          role="combobox"
          aria-expanded={open && !!results?.length}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-o${active}` : undefined}
          placeholder="Indiana University"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            const n = results?.length ?? 0;
            if (e.key === "ArrowDown" && n) {
              e.preventDefault();
              setOpen(true);
              setActive((a) => (a + 1) % n);
            } else if (e.key === "ArrowUp" && n) {
              e.preventDefault();
              setActive((a) => (a - 1 + n) % n);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (open && results?.[active]) onPick(results[active]!);
              else setProblem("Choose your school from the list.");
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          />
        </InputGroup>
        {open && !!results?.length && (
          <ul id={`${id}-list`} role="listbox" aria-label="Schools" className="max-h-64 overflow-y-auto rounded-xl border bg-popover p-1">
            {results.map((s, i) => (
              <li
                key={`${s.name}${s.address}`}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(s)}
                onMouseEnter={() => setActive(i)}
                className={cn("flex cursor-pointer flex-col rounded-lg px-3 py-2 text-sm", i === active && "bg-accent")}
              >
                <span className="font-medium text-foreground">{s.name}</span>
                <span className="text-muted-foreground">{hostOf(s.address)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {status}
      </p>
      {problem && <p className="text-sm text-destructive-foreground">{problem}</p>}
      <Button type="button" variant="link" className="self-start px-0" onClick={() => setMode("address")}>
        Type the address instead
      </Button>
    </div>
  );
}

function SignInStep({ kind, school, again, onSignedIn }: { kind: LmsKind; school: LmsSchool; again: boolean; onSignedIn: (c: LmsConnection) => void }) {
  const [state, setState] = useState<{ at: "idle" } | { at: "waiting" } | { at: "cancelled" } | { at: "error"; message: string } | { at: "done"; name: string }>({ at: "idle" });
  const attempt = useRef(0);
  const open = async () => {
    const n = ++attempt.current;
    setState({ at: "waiting" });
    try {
      const c = await lmsConnect(kind, school.address, school.name !== hostOf(school.address) ? school.name : undefined);
      if (n !== attempt.current) return;
      sitesChanged();
      setState({ at: "done", name: connectionName(c) });
      announce(`Signed in to ${connectionName(c)}.`);
      setTimeout(() => onSignedIn(c), 500);
    } catch (e) {
      if (n !== attempt.current) return;
      setState(isCancelled(e) ? { at: "cancelled" } : { at: "error", message: errorText(e) });
    }
  };
  return (
    <div className="flex flex-col gap-4" data-signin={state.at}>
      <p className="text-sm text-muted-foreground">
        {again ? "Your session ended. " : ""}A window opens at {hostOf(school.address)} for you to sign in as you always do. Phaethon keeps the session in your computer’s keychain, never your password.
      </p>
      {state.at === "waiting" ? (
        <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-4" role="status">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LoaderIcon aria-hidden className="size-4 motion-safe:animate-spin" />
            Finish signing in in the {school.name} window.
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={() => (attempt.current++, setState({ at: "idle" }))}>
              Stop waiting
            </Button>
          </div>
        </div>
      ) : state.at === "done" ? (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-success/32 bg-success/6 p-4 text-sm font-medium text-success-foreground">
          <CheckIcon aria-hidden className="size-4" />
          Signed in to {state.name}.
        </p>
      ) : (
        <>
          {state.at === "cancelled" && (
            <p role="alert" className="flex items-center gap-2 text-sm text-warning-foreground">
              <TriangleAlertIcon aria-hidden className="size-4" />
              Sign-in was closed. Open it to try again.
            </p>
          )}
          {state.at === "error" && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive-foreground">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              Signing in didn’t work. {state.message}
            </p>
          )}
          <div>
            <Button onClick={() => void open()} data-open-signin="">
              <ExternalLinkIcon aria-hidden />
              Open sign-in window
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ChooseStep({ courses, chosen, setChosen }: { courses: LmsCourse[] | null; chosen: string[]; setChosen: (f: (c: string[]) => string[]) => void }) {
  const id = useId();
  const [filter, setFilter] = useState("");
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => (courses ?? []).filter((c) => words.every((w) => `${c.name} ${c.code ?? ""} ${c.term ?? ""}`.toLowerCase().includes(w))), [courses, words.join(" ")]);
  if (!courses) return <p role="status" className="text-sm text-muted-foreground">Loading your courses…</p>;
  const current = shown.filter((c) => c.current);
  const past = shown.filter((c) => !c.current);
  const group = (list: LmsCourse[], label: string) => (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{label}</h3>
        {list.length > 1 && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const all = list.every((c) => chosen.includes(c.id));
              setChosen((x) => (all ? x.filter((y) => !list.some((c) => c.id === y)) : [...new Set([...x, ...list.map((c) => c.id)])]));
            }}
          >
            {list.every((c) => chosen.includes(c.id)) ? "Select none" : "Select all"}
          </Button>
        )}
      </div>
      <ul className="divide-y rounded-xl border">
        {list.map((c) => (
          <li key={c.id} className="px-3 py-2.5">
            <Label className="flex items-start gap-2.5 text-sm font-normal">
              <Checkbox className="mt-0.5" checked={chosen.includes(c.id)} onCheckedChange={(on) => setChosen((x) => (on ? [...x, c.id] : x.filter((y) => y !== c.id)))} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-foreground">{c.name}</span>
                <span className="text-muted-foreground">{[c.code, c.term].filter(Boolean).join(" · ")}</span>
              </span>
              {(c.imported || c.partial) && <span className="text-sm text-muted-foreground">{c.partial ? "Resume import" : "Imported"}</span>}
            </Label>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {courses.length > 6 && (
        <Input aria-label="Filter courses" placeholder="Filter by name, code or term" value={filter} onChange={(e) => setFilter(e.target.value)} id={`${id}-f`} />
      )}
      {current.length > 0 && group(current, "This term")}
      {past.length > 0 && (
        <details open={past.some((c) => chosen.includes(c.id))} className="group/past">
          <summary className="cursor-pointer rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Past courses ({past.length})</summary>
          <div className="mt-2">{group(past, "Past terms")}</div>
        </details>
      )}
      {shown.length === 0 && <p className="text-sm text-muted-foreground">No course matches “{filter.trim()}”.</p>}
    </div>
  );
}
