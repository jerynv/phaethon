import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  AccessDenied,
  errorMessage,
  request,
  roleName,
  SessionExpired,
  type AccessChange,
  type StaffMember,
} from "./api";
import { AccountEditor, emptyDraft } from "./AccountEditor";
import type { StaffCache } from "./staff-state";

function restart(ref: RefObject<AbortController | null>): AbortController {
  ref.current?.abort();
  ref.current = new AbortController();
  return ref.current;
}

export function Staff({ cache, onExpired }: { cache: StaffCache; onExpired: () => void }) {
  const [members, setMembers] = useState(cache.members);
  const [changes, setChanges] = useState(cache.changes);
  // undefined: editor closed; null: adding an account; otherwise the id being edited.
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState(emptyDraft);
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [staffError, setStaffError] = useState("");
  const [auditError, setAuditError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"save" | "revoke" | null>(null);
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [creationConfirmed, setCreationConfirmed] = useState(false);
  const creationConfirmedRef = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  const staffRequest = useRef<AbortController | null>(null);
  const auditRequest = useRef<AbortController | null>(null);

  const expire = useCallback(() => {
    cache.members = null;
    cache.changes = null;
    staffRequest.current?.abort();
    auditRequest.current?.abort();
    mutation.current?.abort();
    setMembers(null);
    setChanges(null);
    onExpired();
  }, [cache, onExpired]);

  /** Reports a failed request unless it was cancelled; losing the session or owner role signs out. */
  const fail = useCallback(
    (controller: AbortController, error: unknown, show: (text: string) => void, fallback: string) => {
      if (controller.signal.aborted) return;
      if (error instanceof SessionExpired || error instanceof AccessDenied) expire();
      else show(errorMessage(error, fallback));
    },
    [expire],
  );

  const loadStaff = useCallback(async () => {
    const controller = restart(staffRequest);
    setLoadingStaff(true);
    setStaffError("");
    try {
      const result = await request<{ items: StaffMember[] }>("/staff", { signal: controller.signal });
      if (controller.signal.aborted) return;
      cache.members = result.items;
      setMembers(result.items);
      if (creationConfirmedRef.current) {
        creationConfirmedRef.current = false;
        setCreationConfirmed(false);
        setSelected(undefined);
        setPassword("");
      }
    } catch (error) {
      fail(controller, error, setStaffError, "Couldn’t load staff.");
    } finally {
      if (!controller.signal.aborted) setLoadingStaff(false);
    }
  }, [cache, fail]);

  const loadAudit = useCallback(async () => {
    const controller = restart(auditRequest);
    setLoadingAudit(true);
    setAuditError("");
    try {
      const result = await request<{ items: AccessChange[] }>("/staff/audit", { signal: controller.signal });
      if (controller.signal.aborted) return;
      cache.changes = result.items;
      setChanges(result.items);
    } catch (error) {
      fail(controller, error, setAuditError, "Couldn’t load access changes.");
    } finally {
      if (!controller.signal.aborted) setLoadingAudit(false);
    }
  }, [cache, fail]);

  const reload = useCallback(() => {
    void loadStaff();
    void loadAudit();
  }, [loadStaff, loadAudit]);

  useEffect(() => {
    reload();
    return () => {
      staffRequest.current?.abort();
      auditRequest.current?.abort();
      mutation.current?.abort();
    };
  }, [reload]);

  const edit = (member?: StaffMember) => {
    if (mutation.current || creationConfirmedRef.current) return;
    setSelected(member?.id ?? null);
    setDraft(
      member
        ? { email: member.email, username: member.username, role: member.role, disabled: member.disabled }
        : emptyDraft,
    );
    setPassword("");
    setFormError("");
    setNotice("");
  };

  const close = () => {
    setSelected(undefined);
    setPassword("");
    setFormError("");
  };

  /** Runs one write at a time; `run` returns once the write and its follow-up reads are done. */
  const mutate = async (
    kind: "save" | "revoke",
    run: (signal: AbortSignal) => Promise<void>,
    fallback: string,
  ) => {
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(kind);
    setFormError("");
    setNotice("");
    try {
      await run(controller.signal);
    } catch (error) {
      fail(controller, error, setFormError, fallback);
    } finally {
      if (!controller.signal.aborted) {
        setBusy(null);
        mutation.current = null;
      }
    }
  };

  const save = () => {
    if (mutation.current || creationConfirmedRef.current) return;
    // A read started before the write must not replace the confirmed change later.
    staffRequest.current?.abort();
    auditRequest.current?.abort();
    setLoadingStaff(false);
    setLoadingAudit(false);
    void mutate(
      "save",
      async (signal) => {
        const body = selected
          ? { ...draft, ...(password ? { password } : {}) }
          : { email: draft.email, username: draft.username, role: draft.role, password };
        await request(selected ? `/staff/${encodeURIComponent(selected)}` : "/staff", {
          method: selected ? "PATCH" : "POST",
          body: JSON.stringify(body),
          signal,
        });
        if (signal.aborted) return;
        setPassword("");
        if (selected) {
          // Change only after the server accepts it; a rejected last-owner change leaves the row intact.
          const next = (cache.members ?? []).map((member) =>
            member.id === selected ? { ...member, ...draft } : member,
          );
          cache.members = next;
          setMembers(next);
          close();
          setNotice("Account updated.");
          reload();
        } else {
          creationConfirmedRef.current = true;
          setCreationConfirmed(true);
          setSelected(undefined);
          setNotice("Account created.");
          // Creation returns no id. Keep the editor pending until the authoritative list arrives.
          await loadStaff();
          if (!signal.aborted) void loadAudit();
        }
      },
      "Couldn’t save access.",
    );
  };

  const revoke = () => {
    if (!selected || mutation.current) return;
    void mutate(
      "revoke",
      async (signal) => {
        await request(`/staff/${encodeURIComponent(selected)}/revoke`, {
          method: "POST",
          body: "{}",
          signal,
        });
        if (signal.aborted) return;
        close();
        setNotice("Active sessions signed out.");
        void loadAudit();
      },
      "Couldn’t sign out sessions.",
    );
  };

  const locked = busy !== null || creationConfirmed;

  return (
    <main className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Staff access</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage who can open the console.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label="Refresh staff"
            disabled={locked || loadingStaff || loadingAudit}
            onClick={reload}
          >
            <Icon icon={icons.reload} className="size-3.5" />
            Refresh
          </Button>
          <Button size="sm" disabled={locked || !members} onClick={() => edit()}>
            <Icon icon={icons.add} className="size-3.5" />
            Add account
          </Button>
        </div>
      </div>
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs">
        <p role="status" className="text-muted-foreground">
          {notice ||
            (members
              ? `${members.length} ${members.length === 1 ? "account" : "accounts"}`
              : "Staff accounts")}
        </p>
        {members && loadingStaff ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Icon icon={icons.reload} className="size-3 motion-safe:animate-spin" aria-hidden />
            Updating
          </span>
        ) : null}
      </div>
      {staffError ? (
        <ErrorBanner
          message={creationConfirmed ? "Account created, but the staff list couldn’t refresh." : staffError}
          retryLabel="Retry staff"
          retryDisabled={loadingStaff || busy !== null}
          onRetry={() => void loadStaff()}
        />
      ) : null}
      {members ? (
        <StaffList members={members} loading={loadingStaff} locked={locked} onManage={edit} />
      ) : !staffError ? (
        <StaffSkeleton />
      ) : null}
      {selected !== undefined ? (
        <AccountEditor
          key={selected ?? "new"}
          existing={selected !== null}
          draft={draft}
          onDraftChange={setDraft}
          password={password}
          onPasswordChange={setPassword}
          passwordRequired={!selected && !creationConfirmed}
          locked={locked}
          busy={busy}
          error={formError}
          onSave={save}
          onCancel={close}
          onRevoke={revoke}
        />
      ) : null}
      <section className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-medium">Recent access changes</h2>
          {changes && loadingAudit ? <span className="text-xs text-muted-foreground">Updating</span> : null}
        </div>
        {auditError ? (
          <ErrorBanner
            className="mb-3"
            message={auditError}
            retryLabel="Retry access changes"
            retryDisabled={busy !== null || loadingAudit}
            onRetry={() => void loadAudit()}
          />
        ) : null}
        {changes ? (
          <AccessChanges changes={changes} loading={loadingAudit} />
        ) : !auditError ? (
          <AuditSkeleton />
        ) : null}
      </section>
    </main>
  );
}

function ErrorBanner({
  message,
  retryLabel,
  retryDisabled,
  onRetry,
  className,
}: {
  message: string;
  retryLabel: string;
  retryDisabled: boolean;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 p-3 text-sm text-destructive-foreground",
        className,
      )}
    >
      <span>{message}</span>
      <Button size="sm" variant="outline" disabled={retryDisabled} onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}

/** Accounts as a table from the `sm` breakpoint up, and as a list of cards below it. */
function StaffList({
  members,
  loading,
  locked,
  onManage,
}: {
  members: StaffMember[];
  loading: boolean;
  locked: boolean;
  onManage: (member: StaffMember) => void;
}) {
  const manage = (member: StaffMember) => (
    <Button
      size="sm"
      variant="outline"
      disabled={locked}
      aria-label={`Manage ${member.email}`}
      onClick={() => onManage(member)}
    >
      Manage
    </Button>
  );
  return (
    <div className="overflow-x-auto rounded-card border bg-card" aria-busy={loading}>
      <table className="hidden w-full text-left text-sm sm:table">
        <caption className="sr-only">Staff accounts</caption>
        <thead className="border-b bg-well text-xs text-muted-foreground">
          <tr>
            {["Account", "Role", "Sign-in", ""].map((heading, index) => (
              <th scope="col" key={index} className="px-4 py-3 font-normal">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {members.map((member) => (
            <tr key={member.id}>
              <td className="px-4 py-4">
                <span className="block font-medium">{member.email}</span>
                <span className="text-xs text-muted-foreground">{member.username}</span>
              </td>
              <td className="whitespace-nowrap px-4 py-4">
                <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {roleName(member.role)}
                </span>
              </td>
              <td className="px-4 py-4">
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      member.disabled ? "bg-muted-foreground/50" : "bg-emerald-600 dark:bg-emerald-400",
                    )}
                  />
                  {member.disabled ? "Disabled" : "Enabled"}
                </span>
              </td>
              <td className="px-4 py-4 text-right">{manage(member)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y sm:hidden" aria-label="Staff accounts">
        {members.map((member) => (
          <li key={member.id} className="space-y-4 p-4">
            <div>
              <p className="break-all font-medium text-sm">{member.email}</p>
              <p className="mt-1 text-xs text-muted-foreground">{member.username}</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{roleName(member.role)}</span>
                <span aria-hidden>·</span>
                <span>{member.disabled ? "Disabled" : "Enabled"}</span>
              </div>
              {manage(member)}
            </div>
          </li>
        ))}
      </ul>
      {!members.length ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">No staff accounts.</p>
      ) : null}
    </div>
  );
}

function AccessChanges({ changes, loading }: { changes: AccessChange[]; loading: boolean }) {
  return (
    <div className="divide-y rounded-card border bg-card" aria-busy={loading}>
      {changes.length ? (
        changes.map((change) => (
          <div
            key={change.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 text-sm"
          >
            <div className="min-w-0 break-words">
              <span>{change.actorEmail}</span>
              <span className="text-muted-foreground">
                {" "}
                · {change.action.replaceAll("_", " ")} · {change.targetEmail}
              </span>
            </div>
            <time dateTime={change.createdAt} className="text-xs text-muted-foreground">
              {new Date(change.createdAt).toLocaleString()}
            </time>
          </div>
        ))
      ) : (
        <p className="px-4 py-6 text-sm text-muted-foreground">No access changes yet.</p>
      )}
    </div>
  );
}

function StaffSkeleton() {
  return (
    <div role="status" aria-label="Loading staff" className="overflow-hidden rounded-card border bg-card">
      <span className="sr-only">Loading staff…</span>
      <div aria-hidden className="border-b bg-well px-4 py-3">
        <Skeleton className="h-3 w-28" />
      </div>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          aria-hidden
          className="flex items-center justify-between gap-6 border-b px-4 py-4 last:border-0"
        >
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-5 w-16" />
          <Skeleton className="hidden h-7 w-16 sm:block" />
        </div>
      ))}
    </div>
  );
}

function AuditSkeleton() {
  return (
    <div role="status" aria-label="Loading access changes" className="divide-y rounded-card border bg-card">
      <span className="sr-only">Loading access changes…</span>
      {[0, 1, 2].map((row) => (
        <div key={row} aria-hidden className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
