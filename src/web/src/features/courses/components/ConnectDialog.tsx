import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cleanMessage, FieldError, RowError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { lmsConnect, lmsSchools } from "../api";
import { checkAddress, connectionName, hostOf, isCancelled, KINDS, kindLabel } from "../lib/sites";
import type { LmsConnection, LmsKind, LmsSchool } from "../lib/types";
import { useCourses } from "../store";

type Step = "kind" | "address" | "waiting";

/**
 * Connect a course site: pick the kind, find the school or paste its address,
 * then sign in inside the core's own window. `again` signs in to an existing
 * connection straight away.
 */
export function ConnectDialog({
  open,
  onOpenChange,
  again,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  again?: LmsConnection | null;
  onConnected?: (c: LmsConnection) => void;
}) {
  const [step, setStep] = useState<Step>("kind");
  const [kind, setKind] = useState<LmsKind>("canvas");
  const [query, setQuery] = useState("");
  const [school, setSchool] = useState<LmsSchool | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const attempt = useRef(0);
  const loadConnections = useCourses((s) => s.loadConnections);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNote(null);
    if (again) {
      setKind(again.kind);
      setAddress(again.address);
      setSchool(again.schoolName ? { name: again.schoolName, address: again.address } : null);
      void signIn(again.kind, again.address, again.schoolName);
    } else {
      setStep("kind");
      setQuery("");
      setSchool(null);
      setAddress("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, again]);

  const info = KINDS.find((k) => k.kind === kind)!;
  const target = school?.address ?? address;

  async function signIn(k: LmsKind, addr: string, schoolName?: string) {
    const mine = ++attempt.current;
    setStep("waiting");
    setError(null);
    setNote(null);
    try {
      const c = await lmsConnect(k, addr, schoolName);
      void loadConnections();
      if (mine !== attempt.current) return;
      toast.success(`Connected to ${connectionName(c)}`);
      onOpenChange(false);
      onConnected?.(c);
    } catch (e) {
      if (mine !== attempt.current) return;
      if (again) {
        if (!isCancelled(e)) toast.error("Couldn’t sign in", cleanMessage(e));
        onOpenChange(false);
        return;
      }
      setStep("address");
      if (isCancelled(e)) setNote("The sign-in window was closed before you finished.");
      else setError(cleanMessage(e));
    }
  }

  function submit() {
    if (school) return void signIn(kind, school.address, school.name);
    const checked = checkAddress(address, info.example);
    if (!checked.ok) return setError(checked.problem);
    void signIn(kind, checked.address);
  }

  function cancelWaiting() {
    attempt.current++;
    if (again) onOpenChange(false);
    else setStep("address");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (step === "waiting" && !o ? cancelWaiting() : onOpenChange(o))}>
      <DialogPopup className="max-w-md" showCloseButton={step !== "waiting"}>
        {step === "kind" ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect a course site</DialogTitle>
              <DialogDescription>Which one does your school use?</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="grid grid-cols-2 gap-2">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    onClick={() => {
                      setKind(k.kind);
                      setSchool(null);
                      setAddress("");
                      setQuery("");
                      setError(null);
                      setNote(null);
                      setStep("address");
                    }}
                    className="group flex h-14 items-center justify-between gap-2 rounded-lg border bg-card px-3 text-left transition-colors hover:bg-accent/60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-sm">{k.label}</span>
                      <span className="block truncate text-2xs text-muted-foreground">{k.example}</span>
                    </span>
                    <ChevronRightIcon className="size-3.5 shrink-0 text-subtle-foreground group-hover:text-muted-foreground" strokeWidth={2} />
                  </button>
                ))}
              </div>
            </DialogPanel>
          </>
        ) : null}

        {step === "address" ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect {kindLabel(kind)}</DialogTitle>
              <DialogDescription>You’ll sign in on your school’s own page. Phaethon never sees your password.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              {kind === "canvas" ? <SchoolSearch query={query} onQuery={setQuery} picked={school} onPick={(s) => (setSchool(s), setError(null))} /> : null}
              <div className="space-y-1.5">
                <Label htmlFor="lms-address">{kind === "canvas" ? "Or paste the address" : "Address"}</Label>
                <Input
                  id="lms-address"
                  autoFocus={kind !== "canvas"}
                  value={address}
                  placeholder={info.example}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={error && !school ? true : undefined}
                  onChange={(e) => {
                    setAddress(e.target.value);
                    setSchool(null);
                    setError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                />
                {error ? <FieldError>{error}</FieldError> : <p className="text-2xs text-muted-foreground">Usually {info.hint}</p>}
                {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              {again ? null : (
                <Button variant="ghost" size="sm" onClick={() => setStep("kind")}>
                  Back
                </Button>
              )}
              <Button size="sm" onClick={submit} disabled={!target.trim()}>
                Sign in
                <ExternalLinkIcon />
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "waiting" ? (
          <>
            <DialogHeader className="items-center pr-5 pt-8 text-center">
              <Spinner size="lg" tone="muted" className="mb-3" />
              <DialogTitle>Finish signing in</DialogTitle>
              <DialogDescription className="max-w-xs">
                Use the window that opened for {school?.name ?? (hostOf(target) || "your school")}. This closes by itself when you’re in.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter variant="bare" className="justify-center sm:justify-center">
              <Button variant="outline" size="sm" onClick={cancelWaiting}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** Canvas schools by name, from Instructure's directory. */
function SchoolSearch({ query, onQuery, picked, onPick }: { query: string; onQuery: (q: string) => void; picked: LmsSchool | null; onPick: (s: LmsSchool) => void }) {
  const [results, setResults] = useState<LmsSchool[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      lmsSchools("canvas", q).then(
        (r) => {
          if (!live) return;
          setResults(r);
          setError(null);
          setLoading(false);
        },
        (e) => {
          if (!live) return;
          setError(cleanMessage(e));
          setLoading(false);
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, tick]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor="lms-school">School</Label>
      <div className="relative">
        <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" strokeWidth={2} />
        <Input id="lms-school" autoFocus value={query} placeholder="Search by name" className="*:data-[slot=input]:ps-8" autoComplete="off" onChange={(e) => onQuery(e.target.value)} />
        {loading ? <Spinner size="sm" tone="muted" className="-translate-y-1/2 absolute top-1/2 right-2.5" /> : null}
      </div>
      {error ? (
        <RowError className="h-7 px-1" message="Couldn’t search schools." onRetry={() => setTick((n) => n + 1)} />
      ) : results && results.length === 0 && !loading ? (
        <p className="px-1 py-1.5 text-muted-foreground text-xs">No school by that name. Paste its address below.</p>
      ) : results && results.length ? (
        <div className="max-h-44 overflow-y-auto rounded-lg border p-1">
          {results.map((s) => {
            const on = picked?.name === s.name && picked.address === s.address;
            return (
              <button
                key={`${s.name}\n${s.address}`}
                type="button"
                onClick={() => onPick(s)}
                className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent", on && "bg-row-selected")}
              >
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="max-w-[45%] shrink-0 truncate text-muted-foreground text-xs">{hostOf(s.address)}</span>
                {on ? <CheckIcon className="size-3.5 shrink-0 text-primary" strokeWidth={2.25} /> : <span className="size-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
