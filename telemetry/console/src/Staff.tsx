import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { request, SessionExpired, type AccessChange, type StaffMember, type StaffRole } from "./api";

const roleName = (role: StaffRole) => role === "owner" ? "Super admin" : "Viewer";
const empty = { email: "", username: "", role: "viewer" as StaffRole, disabled: false };

export function Staff({ onExpired }: { onExpired: () => void }) {
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [changes, setChanges] = useState<AccessChange[]>([]);
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState(empty);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    Promise.all([request<{ items: StaffMember[] }>("/staff", { signal: controller.signal }), request<{ items: AccessChange[] }>("/staff/audit", { signal: controller.signal })])
      .then(([staff, audit]) => { if (!controller.signal.aborted) { setMembers(staff.items); setChanges(audit.items); } })
      .catch((e) => { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onExpired(); else setError(e instanceof Error ? e.message : "Couldn’t load staff."); } });
    return () => controller.abort();
  }, [refresh, onExpired]);
  useEffect(() => () => mutation.current?.abort(), []);

  const edit = (member?: StaffMember) => {
    setSelected(member?.id ?? null); setDraft(member ? { email: member.email, username: member.username, role: member.role, disabled: member.disabled } : empty); setPassword(""); setError("");
  };
  const close = () => { setSelected(undefined); setPassword(""); setError(""); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const controller = new AbortController(); mutation.current = controller;
    setBusy(true); setError("");
    try {
      const body = selected ? { ...draft, ...(password ? { password } : {}) } : { email: draft.email, username: draft.username, role: draft.role, password };
      await request(selected ? `/staff/${encodeURIComponent(selected)}` : "/staff", { method: selected ? "PATCH" : "POST", body: JSON.stringify(body), signal: controller.signal });
      if (!controller.signal.aborted) { close(); setRefresh((n) => n + 1); }
    } catch (e) { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onExpired(); else setError(e instanceof Error ? e.message : "Couldn’t save access."); } }
    finally { setBusy(false); mutation.current = null; }
  };
  const revoke = async () => {
    const controller = new AbortController(); mutation.current = controller;
    setBusy(true); setError("");
    try {
      await request(`/staff/${encodeURIComponent(selected!)}/revoke`, { method: "POST", body: "{}", signal: controller.signal });
      if (!controller.signal.aborted) { close(); setRefresh((n) => n + 1); }
    } catch (e) { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onExpired(); else setError(e instanceof Error ? e.message : "Couldn’t revoke sessions."); } }
    finally { setBusy(false); mutation.current = null; }
  };

  return <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
    <div className="flex items-center justify-between gap-3"><h1 className="text-2xl font-medium tracking-tight">Staff access</h1><Button size="sm" disabled={busy} onClick={() => edit()}>Add account</Button></div>
    {error ? <div role="alert" className="rounded-card border border-destructive/30 p-3 text-sm text-destructive-foreground">{error}</div> : null}
    {members ? <div className="overflow-x-auto rounded-card border bg-card"><table className="w-full text-left text-sm"><caption className="sr-only">Staff accounts</caption><thead className="border-b bg-well text-xs text-muted-foreground"><tr>{["Account", "Role", "Sign-in", ""].map((h, i) => <th scope="col" key={i} className="px-4 py-2 font-normal">{h}</th>)}</tr></thead><tbody className="divide-y">{members.map((member) => <tr key={member.id}><td className="px-4 py-3"><span className="block">{member.email}</span><span className="text-xs text-muted-foreground">{member.username}</span></td><td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{roleName(member.role)}</td><td className="px-4 py-3 text-muted-foreground">{member.disabled ? "Disabled" : "Enabled"}</td><td className="px-4 py-3 text-right"><Button size="sm" variant="outline" disabled={busy} aria-label={`Manage ${member.email}`} onClick={() => edit(member)}>Manage</Button></td></tr>)}</tbody></table></div> : <p role="status" className="text-sm text-muted-foreground">Loading staff…</p>}
    {selected !== undefined ? <section className="max-w-xl rounded-card border bg-card p-4" aria-label="Account editor">
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-medium">{selected ? "Manage account" : "Add account"}</h2><Button size="sm" variant="ghost" disabled={busy} onClick={close}>Cancel</Button></div>
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2"><Label htmlFor="staff-email">Email</Label><Input id="staff-email" type="email" autoComplete="off" required maxLength={254} value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} disabled={busy} /></div>
        <div className="flex flex-col gap-2"><Label htmlFor="staff-username">Username</Label><Input id="staff-username" autoComplete="off" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" minLength={3} maxLength={64} value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} disabled={busy} /></div>
        <div className="flex flex-col gap-2"><Label htmlFor="staff-role">Role</Label><select id="staff-role" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as StaffRole })} disabled={busy} className="h-8 rounded-control border bg-background px-2 text-sm"><option value="viewer">Viewer</option><option value="owner">Super admin</option></select><p className="text-xs text-muted-foreground">Super admins manage staff access. Viewers can read telemetry.</p></div>
        <div className="flex flex-col gap-2"><Label htmlFor="staff-password">{selected ? "New password (optional)" : "Password"}</Label><Input id="staff-password" type="password" autoComplete="new-password" required={!selected} minLength={14} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /><p className="text-xs text-muted-foreground">14–256 characters.</p></div>
        {selected ? <div className="flex items-center justify-between gap-3"><Label htmlFor="staff-enabled">Allow sign-in</Label><Switch id="staff-enabled" checked={!draft.disabled} onCheckedChange={(on) => setDraft({ ...draft, disabled: !on })} disabled={busy} /></div> : null}
        <div className="flex flex-wrap items-center gap-2"><Button type="submit" size="sm" pending={busy}>Save account</Button>{selected ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void revoke()}>Sign out all sessions</Button> : null}</div>
        {selected ? <p className="text-xs text-muted-foreground">Saving account changes signs out its active sessions.</p> : null}
      </form>
    </section> : null}
    <section><h2 className="mb-3 font-medium">Recent access changes</h2><div className="divide-y rounded-card border bg-card">{changes.length ? changes.map((change) => <div key={change.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"><div><span>{change.actorEmail}</span><span className="text-muted-foreground"> · {change.action.replaceAll("_", " ")} · {change.targetEmail}</span></div><time dateTime={change.createdAt} className="text-xs text-muted-foreground">{new Date(change.createdAt).toLocaleString()}</time></div>) : <p className="px-4 py-4 text-sm text-muted-foreground">No access changes yet.</p>}</div></section>
  </main>;
}
