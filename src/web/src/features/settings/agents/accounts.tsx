import { motion } from "motion/react";
import { useState } from "react";
import { FieldError, RowError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Row, Status, useLoad } from "../ui";
import {
  CLI_INFO,
  type CliId,
  cancelInstanceSignIn,
  type InstanceView,
  instanceUsage,
  removeInstance,
  saveInstance,
  selectInstance,
  signInInstance,
  signOutInstance,
  type UsageWindow,
} from "./api";
import { instanceStatus } from "./logic";

/**
 * A coding agent's accounts, as Settings › AI & Models shows them under a
 * plan (Claude Code, Codex, Gemini CLI): each account with its sign-in state
 * and usage limits, and adding, choosing or removing one. Signing in runs the
 * CLI's own login; Phaethon never sees the credentials.
 */

/** "2 h", "3 d": how long until a usage window resets. */
function resetsIn(at: string | number | null): string | null {
  if (at === null) return null;
  const ms = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const h = diff / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(diff / 60_000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

function UsageBar({ w }: { w: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
  const reset = resetsIn(w.resetsAt);
  return (
    <div className="grid grid-cols-[4.5rem_1fr_4.5rem_6.5rem] items-center gap-3 text-xs">
      <span className="truncate text-muted-foreground">{w.label}</span>
      <div
        role="progressbar"
        aria-label={w.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 420, damping: 40 }}
          className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-warning" : "bg-primary")}
        />
      </div>
      <span className="text-right tabular-nums">{pct}% used</span>
      <span className="truncate text-right text-subtle-foreground tabular-nums">{reset ? (reset === "now" ? "resets now" : `resets in ${reset}`) : ""}</span>
    </div>
  );
}

function Usage({ id }: { id: string }) {
  const usage = useLoad(() => instanceUsage(id), [id], "agents:usage");
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try { await usage.reload(); }
    finally { setRefreshing(false); }
  };
  const waiting = useDelayed(usage.loading && !usage.data);
  if (usage.error && !usage.data) return <RowError className="h-5" message="Couldn’t load usage" onRetry={() => void usage.reload()} />;
  if (!usage.data) {
    return waiting ? (
      <div className="flex flex-col gap-2 motion-safe:animate-skeleton" aria-hidden>
        <Skeleton className="h-1 w-full animate-none" />
        <Skeleton className="h-1 w-full animate-none" />
      </div>
    ) : null;
  }
  const u = usage.data;
  if (!u.available || u.windows.length === 0) return (
    <div className="flex items-center gap-2">
      <p className="min-w-0 flex-1 text-subtle-foreground text-xs">{u.reason ?? "No usage limits to show."}</p>
      <Button size="xs" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
        {refreshing ? <Spinner /> : <Icon icon={icons.retry} />}
        Refresh usage
      </Button>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      {u.windows.map((w) => (
        <UsageBar key={w.label} w={w} />
      ))}
    </div>
  );
}

export function InstanceRow({ i, current, many, onChanged }: { i: InstanceView; current: boolean; many: boolean; onChanged: () => Promise<void> }) {
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState<"use" | "out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const status = instanceStatus(i);
  const builtIn = i.config.id === i.config.cli;

  const signIn = async (sso = false) => {
    setSigning(true);
    setError(null);
    try {
      const r = await signInInstance(i.config.id, { sso });
      if (r.status === "signedIn") {
        toast.success(r.message);
        await onChanged();
      } else if (r.status !== "cancelled") setError(r.message);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setSigning(false);
    }
  };
  const act = async (kind: "use" | "out") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "use") await selectInstance(i.config.id);
      else await signOutInstance(i.config.id);
      await onChanged();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    try {
      await removeInstance(i.config.id);
      await onChanged();
      toast.success(`${i.config.name} removed`);
    } catch (e) {
      toast.error(`Couldn’t remove ${i.config.name}`, cleanMessage(e));
    }
  };

  const canSignIn = i.installed && i.loggedIn !== true && !i.readOnly;
  const canSignOut = i.installed && i.loggedIn === true && !i.readOnly;
  const canRemove = !builtIn && !i.readOnly;

  return (
    <Row
      label={
        <span className="flex min-w-0 items-center gap-2">
          <Truncate className="min-w-0">{i.config.name}</Truncate>
          {current && many ? (
            <Badge variant="secondary" size="sm" className="shrink-0">
              In use
            </Badge>
          ) : null}
          {i.readOnly && !/system/i.test(i.config.name) ? <span className="shrink-0 font-normal text-subtle-foreground text-xs">System</span> : null}
          <Status tone={status.tone} className="min-w-0">
            <Truncate className="min-w-0">{status.text}</Truncate>
          </Status>
        </span>
      }
      below={
        <>
          {error ? <FieldError>{error}</FieldError> : null}
          {i.loggedIn === true ? <Usage id={i.config.id} /> : null}
        </>
      }
    >
      {signing ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
            <Spinner size="sm" />
            Finish in your browser…
          </span>
          <Button size="xs" variant="ghost" onClick={() => void cancelInstanceSignIn(i.config.id)}>
            Cancel
          </Button>
        </>
      ) : canSignIn ? (
        <>
          {i.config.cli === "claude" ? (
            <Button size="xs" variant="ghost" onClick={() => void signIn(true)} aria-label="Sign in with school or work SSO">
              Use SSO
            </Button>
          ) : null}
          <Button size="xs" variant={i.loggedIn === false ? "default" : "outline"} onClick={() => void signIn()}>
            Sign in
          </Button>
        </>
      ) : null}
      {many && !current && i.installed ? (
        <Button size="xs" variant="outline" pending={busy === "use"} onClick={() => void act("use")}>
          Use
        </Button>
      ) : null}
      {canSignOut || canRemove ? (
        <Menu>
          <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${i.config.name} actions`} />}>
            {busy === "out" ? <Spinner /> : <Icon icon={icons.more} />}
          </MenuTrigger>
          <MenuPopup align="end">
            {canSignOut ? (
              <MenuItem onClick={() => void act("out")}>
                <Icon icon={icons.signOut} />
                Sign out
              </MenuItem>
            ) : null}
            {canRemove ? (
              <MenuItem variant="destructive" onClick={() => setConfirm(true)}>
                <Icon icon={icons.delete} />
                Remove account
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove ${i.config.name}?`} confirm="Remove" destructive onConfirm={() => void remove()}>
        <p>Phaethon will sign out and remove this account. Any conversations using it will switch to {CLI_INFO[i.config.cli].name}’s default account.</p>
      </ConfirmDialog>
    </Row>
  );
}

export function AddAccount({ cli, onChanged }: { cli: CliId; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `new-account-${cli}`;
  if (!open) {
    return (
      <div className="flex h-9 items-center px-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-7 w-fit items-center gap-1.5 rounded-md text-primary text-sm outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={icons.add} className="size-4" />
          Add account
        </button>
      </div>
    );
  }
  const submit = async () => {
    const n = name.trim();
    if (!n) return setError("Enter a name for this account, like Work or Personal.");
    setBusy(true);
    setError(null);
    try {
      const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "account";
      await saveInstance({ id: `${cli}-${slug}-${Math.random().toString(36).slice(2, 6)}`, cli, name: n, binary: "", args: [] });
      await onChanged();
      setOpen(false);
      setName("");
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Account name"
      htmlFor={id}
      below={
        <div className="flex flex-col gap-1.5">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input id={id} size="sm" autoFocus value={name} maxLength={80} placeholder="e.g. Work or Personal" aria-invalid={error ? true : undefined} onChange={(e) => setName(e.target.value)} />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" pending={busy}>
              Add
            </Button>
          </form>
          <FieldError>{error}</FieldError>
        </div>
      }
    />
  );
}
