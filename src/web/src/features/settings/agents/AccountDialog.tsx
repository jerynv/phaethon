/**
 * Adding or editing a named account (an instance with its own home), and the
 * usage-limits view. Ports the fields of Phaethon's old agent-instances form,
 * laid out after T3 Code's AddProviderInstanceDialog.
 */
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/core";

import { FieldMessage } from "../providers/ui";
import { CLI_INFO, instanceUsage, saveInstance, type CliId, type InstanceView, type Usage } from "./api";
import { useAgents } from "./store";

export type AccountTarget = { mode: "add"; cli: CliId } | { mode: "edit"; instance: InstanceView };

export function AccountDialog({ target, onClose, onSaid }: { target: AccountTarget | null; onClose: () => void; onSaid: (t: string) => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">{target ? <AccountForm key={target.mode === "add" ? target.cli : target.instance.config.id} target={target} onClose={onClose} onSaid={onSaid} /> : null}</DialogPopup>
    </Dialog>
  );
}

function AccountForm({ target, onClose, onSaid }: { target: AccountTarget; onClose: () => void; onSaid: (t: string) => void }) {
  const load = useAgents((s) => s.load);
  const editing = target.mode === "edit" ? target.instance.config : null;
  const cli = editing?.cli ?? (target.mode === "add" ? target.cli : "claude");
  const info = CLI_INFO[cli];
  const [name, setName] = useState(editing?.name ?? "");
  const [binary, setBinary] = useState(editing?.binary ?? "");
  const [args, setArgs] = useState(editing?.args.join("\n") ?? "");
  const [error, setError] = useState<{ field: "name" | "binary" | "args" | "form"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(!!(editing?.binary || editing?.args.length));
  const nameId = useId();
  const binaryId = useId();
  const argsId = useId();
  const errorId = useId();
  const argsHintId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!name.trim()) {
      setError({ field: "name", text: "Give the account a name." });
      document.getElementById(nameId)?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveInstance({
        id: editing?.id ?? `${cli}-${crypto.randomUUID()}`,
        cli,
        name: name.trim(),
        binary: binary.trim(),
        args: args.split(/\r?\n/).filter((a) => a.length > 0),
      });
      await load();
      onSaid(editing ? `${saved.name} saved.` : `${saved.name} added. Sign in to use it.`);
      onClose();
    } catch (err) {
      const text = errorText(err);
      // Send the core's sentence to the field it's about.
      const field = /name/i.test(text) ? "name" : /executable/i.test(text) ? "binary" : /argument/i.test(text) ? "args" : "form";
      setError({ field, text });
      const focusId = field === "name" ? nameId : field === "binary" ? binaryId : field === "args" ? argsId : null;
      if (focusId) document.getElementById(focusId)?.focus();
    } finally {
      setSaving(false);
    }
  }

  const err = (field: "name" | "binary" | "args") => (error?.field === field ? error.text : "");
  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="contents">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${editing.name}` : `Add a ${info.name} account`}</DialogTitle>
        <DialogDescription>{editing ? info.name : "It gets its own sign-in, separate from your other accounts."}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-[0.9375rem] font-medium">
            Name
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={80}
            placeholder="Work"
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              if (error?.field === "name") setError(null);
            }}
            aria-invalid={err("name") ? true : undefined}
            aria-describedby={err("name") ? errorId : undefined}
          />
          {err("name") ? (
            <FieldMessage id={errorId} tone="error">
              {err("name")}
            </FieldMessage>
          ) : null}
        </div>
        <Collapsible open={launchOpen || error?.field === "binary" || error?.field === "args"} onOpenChange={setLaunchOpen}>
          <CollapsibleTrigger className="group flex min-h-8 items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDownIcon aria-hidden className="size-4 -rotate-90 transition-transform group-data-[panel-open]:rotate-0 motion-reduce:transition-none" />
            Launch options
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="flex flex-col gap-4 pt-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={binaryId} className="text-[0.9375rem] font-medium">
                  Executable
                </label>
                <Input
                  id={binaryId}
                  value={binary}
                  placeholder={`/opt/homebrew/bin/${cli}`}
                  className="font-mono"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setBinary(e.target.value)}
                  aria-invalid={err("binary") ? true : undefined}
                  aria-describedby={err("binary") ? errorId : undefined}
                />
                {err("binary") ? (
                  <FieldMessage id={errorId} tone="error">
                    {err("binary")}
                  </FieldMessage>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={argsId} className="text-[0.9375rem] font-medium">
                  Extra arguments
                </label>
                <Textarea
                  id={argsId}
                  value={args}
                  rows={3}
                  spellCheck={false}
                  placeholder={"--model\nmodel-name"}
                  className="font-mono"
                  onChange={(e) => setArgs(e.target.value)}
                  aria-invalid={err("args") ? true : undefined}
                  aria-describedby={[argsHintId, err("args") && errorId].filter(Boolean).join(" ")}
                />
                <p id={argsHintId} className="text-sm text-muted-foreground">
                  One per line.
                </p>
                {err("args") ? (
                  <FieldMessage id={errorId} tone="error">
                    {err("args")}
                  </FieldMessage>
                ) : null}
              </div>
            </div>
          </CollapsiblePanel>
        </Collapsible>
        {error?.field === "form" ? <FieldMessage tone="error">{error.text}</FieldMessage> : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={saving}>
          {saving ? <Spinner /> : null}
          {editing ? "Save" : "Add account"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function resetText(at: string | number | null): string {
  if (at === null) return "";
  const when = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const mins = Math.round((when.getTime() - Date.now()) / 60_000);
  if (mins <= 0) return "Resets now";
  if (mins < 60) return `Resets in ${mins} min`;
  if (mins < 48 * 60) return `Resets in ${Math.round(mins / 60)} h`;
  return `Resets ${when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

export function UsageDialog({ instance, onClose }: { instance: InstanceView | null; onClose: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!instance) return;
    let live = true;
    setUsage(null);
    setError("");
    instanceUsage(instance.config.id).then(
      (u) => live && setUsage(u),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [instance]);
  const name = instance ? CLI_INFO[instance.config.cli].name : "";
  return (
    <Dialog open={instance !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Usage limits</DialogTitle>
          <DialogDescription>
            {name}
            {instance?.account ? ` · ${instance.account}` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4" aria-busy={!usage && !error}>
          {!usage && !error ? (
            <div className="flex flex-col gap-3" aria-label="Loading usage">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-2 w-full" />
            </div>
          ) : null}
          {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
          {usage && !usage.available ? <p className="text-sm text-muted-foreground">{usage.reason}</p> : null}
          {usage?.available
            ? usage.windows.map((w) => (
                <div key={w.label} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium">{w.label}</span>
                    <span className="text-muted-foreground">{Math.round(w.usedPercent)}% used</span>
                  </div>
                  <div
                    role="meter"
                    aria-label={`${w.label} used`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(w.usedPercent)}
                    aria-valuetext={`${Math.round(w.usedPercent)} percent`}
                    className="h-2 overflow-hidden rounded-full bg-muted forced-colors:border"
                  >
                    <div
                      className={w.usedPercent >= 90 ? "h-full rounded-full bg-destructive" : w.usedPercent >= 70 ? "h-full rounded-full bg-warning" : "h-full rounded-full bg-primary"}
                      style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }}
                    />
                  </div>
                  {resetText(w.resetsAt) ? <span className="text-sm text-muted-foreground">{resetText(w.resetsAt)}</span> : null}
                </div>
              ))
            : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
