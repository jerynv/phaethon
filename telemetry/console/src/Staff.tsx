import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { request, SessionExpired, AccessDenied, type AccessChange, type StaffMember, type StaffRole } from "./api";
import type { StaffCache } from "./staff-state";

const roleName = (role: StaffRole) => role === "owner" ? "Super admin" : "Viewer";
const empty = { email: "", username: "", role: "viewer" as StaffRole, disabled: false };
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function StaffSkeleton() {
  return <div role="status" aria-label="Loading staff" className="overflow-hidden rounded-card border bg-card">
    <span className="sr-only">Loading staff…</span>
    <div aria-hidden className="border-b bg-well px-4 py-3"><Skeleton className="h-3 w-28" /></div>
    {[0, 1, 2].map((row) => <div key={row} aria-hidden className="flex items-center justify-between gap-6 border-b px-4 py-4 last:border-0">
      <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-20" /></div>
      <Skeleton className="h-5 w-16" /><Skeleton className="hidden h-7 w-16 sm:block" />
    </div>)}
  </div>;
}

function AuditSkeleton() {
  return <div role="status" aria-label="Loading access changes" className="divide-y rounded-card border bg-card">
    <span className="sr-only">Loading access changes…</span>
    {[0, 1, 2].map((row) => <div key={row} aria-hidden className="flex flex-wrap items-center justify-between gap-3 px-4 py-4"><Skeleton className="h-4 w-72 max-w-full" /><Skeleton className="h-3 w-24" /></div>)}
  </div>;
}

export function Staff({ cache, onExpired }: { cache: StaffCache; onExpired: () => void }) {
  const editor = useRef<HTMLElement>(null);
  const [members, setMembers] = useState(cache.members);
  const [changes, setChanges] = useState(cache.changes);
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState(empty);
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

  useEffect(() => {
    if (selected !== undefined) { editor.current?.scrollIntoView({ block: "start" }); editor.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); }
  }, [selected]);
  const expire = useCallback(() => {
    cache.members = null; cache.changes = null;
    staffRequest.current?.abort(); auditRequest.current?.abort(); mutation.current?.abort();
    setMembers(null); setChanges(null); onExpired();
  }, [cache, onExpired]);

  const loadStaff = useCallback(async () => {
    staffRequest.current?.abort();
    const controller = new AbortController();
    staffRequest.current = controller;
    setLoadingStaff(true); setStaffError("");
    try {
      const result = await request<{ items: StaffMember[] }>("/staff", { signal: controller.signal });
      if (controller.signal.aborted) return false;
      cache.members = result.items;
      setMembers(result.items);
      if (creationConfirmedRef.current) {
        creationConfirmedRef.current = false;
        setCreationConfirmed(false); setSelected(undefined); setPassword("");
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof SessionExpired || error instanceof AccessDenied) expire();
        else setStaffError(message(error, "Couldn’t load staff."));
      }
      return false;
    } finally {
      if (!controller.signal.aborted) setLoadingStaff(false);
    }
  }, [cache, expire]);

  const loadAudit = useCallback(async () => {
    auditRequest.current?.abort();
    const controller = new AbortController();
    auditRequest.current = controller;
    setLoadingAudit(true); setAuditError("");
    try {
      const result = await request<{ items: AccessChange[] }>("/staff/audit", { signal: controller.signal });
      if (!controller.signal.aborted) { cache.changes = result.items; setChanges(result.items); }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof SessionExpired || error instanceof AccessDenied) expire();
        else setAuditError(message(error, "Couldn’t load access changes."));
      }
    } finally {
      if (!controller.signal.aborted) setLoadingAudit(false);
    }
  }, [cache, expire]);

  useEffect(() => {
    void loadStaff(); void loadAudit();
    return () => { staffRequest.current?.abort(); auditRequest.current?.abort(); mutation.current?.abort(); };
  }, [loadStaff, loadAudit]);

  const edit = (member?: StaffMember) => {
    if (mutation.current || creationConfirmedRef.current) return;
    setSelected(member?.id ?? null);
    setDraft(member ? { email: member.email, username: member.username, role: member.role, disabled: member.disabled } : empty);
    setPassword(""); setFormError(""); setNotice("");
  };
  const close = () => { setSelected(undefined); setPassword(""); setFormError(""); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (mutation.current || creationConfirmedRef.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    // A read started before the write must not replace the confirmed change later.
    staffRequest.current?.abort(); auditRequest.current?.abort();
    setLoadingStaff(false); setLoadingAudit(false); setBusy("save"); setFormError(""); setNotice("");
    try {
      const body = selected ? { ...draft, ...(password ? { password } : {}) } : { email: draft.email, username: draft.username, role: draft.role, password };
      await request(selected ? `/staff/${encodeURIComponent(selected)}` : "/staff", { method: selected ? "PATCH" : "POST", body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted) return;
      setPassword("");
      if (selected) {
        // Change only after the server accepts it; a rejected last-owner change leaves the row intact.
        const next = (cache.members ?? []).map((member) => member.id === selected ? { ...member, ...draft } : member);
        cache.members = next; setMembers(next); close(); setNotice("Account updated.");
        void loadStaff(); void loadAudit();
      } else {
        creationConfirmedRef.current = true; setCreationConfirmed(true); setSelected(undefined); setNotice("Account created.");
        // Creation returns no id. Keep the editor pending until the authoritative list arrives.
        await loadStaff();
        if (!controller.signal.aborted) void loadAudit();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof SessionExpired || error instanceof AccessDenied) expire();
        else setFormError(message(error, "Couldn’t save access."));
      }
    } finally {
      if (!controller.signal.aborted) { setBusy(null); mutation.current = null; }
    }
  };
  const revoke = async () => {
    if (!selected || mutation.current) return;
    const controller = new AbortController(); mutation.current = controller;
    setBusy("revoke"); setFormError(""); setNotice("");
    try {
      await request(`/staff/${encodeURIComponent(selected)}/revoke`, { method: "POST", body: "{}", signal: controller.signal });
      if (!controller.signal.aborted) { close(); setNotice("Active sessions signed out."); void loadAudit(); }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof SessionExpired || error instanceof AccessDenied) expire();
        else setFormError(message(error, "Couldn’t sign out sessions."));
      }
    } finally {
      if (!controller.signal.aborted) { setBusy(null); mutation.current = null; }
    }
  };
  const locked = busy !== null || creationConfirmed;

  return <main className="flex min-w-0 flex-col gap-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-medium tracking-tight">Staff access</h1><p className="mt-1 text-sm text-muted-foreground">Manage who can open the console.</p></div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Refresh staff" disabled={locked || loadingStaff || loadingAudit} onClick={() => { void loadStaff(); void loadAudit(); }}><Icon icon={icons.reload} className="size-3.5" />Refresh</Button>
        <Button size="sm" disabled={locked || !members} onClick={() => edit()}><Icon icon={icons.add} className="size-3.5" />Add account</Button>
      </div>
    </div>
    <div className="flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs">
      <p role="status" className="text-muted-foreground">{notice || (members ? `${members.length} ${members.length === 1 ? "account" : "accounts"}` : "Staff accounts")}</p>
      {members && loadingStaff ? <span className="flex items-center gap-1.5 text-muted-foreground"><Icon icon={icons.reload} className="size-3 motion-safe:animate-spin" aria-hidden />Updating</span> : null}
    </div>
    {staffError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 p-3 text-sm text-destructive-foreground"><span>{creationConfirmed ? "Account created, but the staff list couldn’t refresh." : staffError}</span><Button size="sm" variant="outline" disabled={loadingStaff || busy !== null} onClick={() => void loadStaff()}>Retry staff</Button></div> : null}
    {members ? <div className="overflow-x-auto rounded-card border bg-card" aria-busy={loadingStaff}>
      <table className="hidden w-full text-left text-sm sm:table"><caption className="sr-only">Staff accounts</caption>
        <thead className="border-b bg-well text-xs text-muted-foreground"><tr>{["Account", "Role", "Sign-in", ""].map((heading, index) => <th scope="col" key={index} className="px-4 py-3 font-normal">{heading}</th>)}</tr></thead>
        <tbody className="divide-y">{members.map((member) => <tr key={member.id}>
          <td className="px-4 py-4"><span className="block font-medium">{member.email}</span><span className="text-xs text-muted-foreground">{member.username}</span></td>
          <td className="whitespace-nowrap px-4 py-4"><span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{roleName(member.role)}</span></td>
          <td className="px-4 py-4"><span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"><span aria-hidden className={`size-1.5 rounded-full ${member.disabled ? "bg-muted-foreground/50" : "bg-emerald-600 dark:bg-emerald-400"}`} />{member.disabled ? "Disabled" : "Enabled"}</span></td>
          <td className="px-4 py-4 text-right"><Button size="sm" variant="outline" disabled={locked} aria-label={`Manage ${member.email}`} onClick={() => edit(member)}>Manage</Button></td>
        </tr>)}</tbody>
      </table>
      <ul className="divide-y sm:hidden" aria-label="Staff accounts">{members.map((member) => <li key={member.id} className="space-y-4 p-4"><div><p className="break-all font-medium text-sm">{member.email}</p><p className="mt-1 text-xs text-muted-foreground">{member.username}</p></div><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{roleName(member.role)}</span><span aria-hidden>·</span><span>{member.disabled ? "Disabled" : "Enabled"}</span></div><Button size="sm" variant="outline" disabled={locked} aria-label={`Manage ${member.email}`} onClick={() => edit(member)}>Manage</Button></div></li>)}</ul>
      {!members.length ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">No staff accounts.</p> : null}
    </div> : !staffError ? <StaffSkeleton /> : null}
    {selected !== undefined ? <section ref={editor} className="max-w-xl scroll-mt-6 rounded-card border bg-card p-5" aria-label="Account editor" aria-busy={busy !== null}>
      <div className="mb-5 flex items-center justify-between gap-3"><h2 className="font-medium">{selected ? "Manage account" : "Add account"}</h2><Button size="sm" variant="ghost" disabled={locked} onClick={close}>Cancel</Button></div>
      <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2"><Label htmlFor="staff-email">Email</Label><Input id="staff-email" type="email" placeholder="name@company.com" autoComplete="off" required maxLength={254} value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} disabled={locked} /></div>
        <div className="flex flex-col gap-2"><Label htmlFor="staff-username">Username</Label><Input id="staff-username" placeholder="name" autoComplete="off" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" minLength={3} maxLength={64} value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} disabled={locked} /></div>
        <div className="flex flex-col gap-2"><Label htmlFor="staff-role">Role</Label>
          <Select value={draft.role} onValueChange={(value) => value != null && setDraft({ ...draft, role: value as StaffRole })} disabled={locked}>
            <SelectTrigger id="staff-role" aria-label="Role"><SelectValue>{(value: StaffRole | null) => roleName(value ?? "viewer")}</SelectValue></SelectTrigger>
            <SelectPopup><SelectItem value="viewer">Viewer</SelectItem><SelectItem value="owner">Super admin</SelectItem></SelectPopup>
          </Select>
          <p className="text-xs text-muted-foreground">{draft.role === "owner" ? "Can read telemetry and manage staff access." : "Can read telemetry and export events."}</p>
        </div>
        <div className="flex flex-col gap-2"><Label htmlFor="staff-password">{selected ? "New password (optional)" : "Password"}</Label><Input id="staff-password" type="password" placeholder={selected ? "Keep current password" : "At least 14 characters"} autoComplete="new-password" required={!selected && !creationConfirmed} minLength={14} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} disabled={locked} /><p className="text-xs text-muted-foreground">14–256 characters.</p></div>
        {selected ? <div className="flex items-center justify-between gap-3 rounded-lg border p-3"><Label htmlFor="staff-enabled">Allow sign-in</Label><Switch id="staff-enabled" checked={!draft.disabled} onCheckedChange={(on) => setDraft({ ...draft, disabled: !on })} disabled={locked} /></div> : null}
        {formError ? <p role="alert" className="text-sm text-destructive-foreground">{formError}</p> : null}
        <div className="flex flex-wrap items-center gap-2"><Button type="submit" size="sm" disabled={locked} pending={busy === "save"}>Save account</Button>{selected ? <Button type="button" size="sm" variant="outline" disabled={locked} pending={busy === "revoke"} onClick={() => void revoke()}>Sign out all sessions</Button> : null}</div>
        {selected ? <p className="text-xs text-muted-foreground">Saving account changes signs out its active sessions.</p> : null}
      </form>
    </section> : null}
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-medium">Recent access changes</h2>{changes && loadingAudit ? <span className="text-xs text-muted-foreground">Updating</span> : null}</div>
      {auditError ? <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 p-3 text-sm text-destructive-foreground"><span>{auditError}</span><Button size="sm" variant="outline" disabled={busy !== null || loadingAudit} onClick={() => void loadAudit()}>Retry access changes</Button></div> : null}
      {changes ? <div className="divide-y rounded-card border bg-card" aria-busy={loadingAudit}>{changes.length ? changes.map((change) => <div key={change.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 text-sm"><div className="min-w-0 break-words"><span>{change.actorEmail}</span><span className="text-muted-foreground"> · {change.action.replaceAll("_", " ")} · {change.targetEmail}</span></div><time dateTime={change.createdAt} className="text-xs text-muted-foreground">{new Date(change.createdAt).toLocaleString()}</time></div>) : <p className="px-4 py-6 text-sm text-muted-foreground">No access changes yet.</p>}</div> : !auditError ? <AuditSkeleton /> : null}
    </section>
  </main>;
}
