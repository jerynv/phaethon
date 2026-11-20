import { useEffect, useRef, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { roleName, type StaffRole } from "./api";

type AccountDraft = { email: string; username: string; role: StaffRole; disabled: boolean };
export const emptyDraft: AccountDraft = { email: "", username: "", role: "viewer", disabled: false };

/** Adds an account, or edits an existing one when `existing` is set. Mount it once per account. */
export function AccountEditor({
  existing,
  draft,
  onDraftChange,
  password,
  onPasswordChange,
  passwordRequired,
  locked,
  busy,
  error,
  onSave,
  onCancel,
  onRevoke,
}: {
  existing: boolean;
  draft: AccountDraft;
  onDraftChange: (draft: AccountDraft) => void;
  password: string;
  onPasswordChange: (password: string) => void;
  passwordRequired: boolean;
  locked: boolean;
  busy: "save" | "revoke" | null;
  error: string;
  onSave: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  const editor = useRef<HTMLElement>(null);
  const update = (change: Partial<AccountDraft>) => onDraftChange({ ...draft, ...change });

  useEffect(() => {
    editor.current?.scrollIntoView({ block: "start" });
    editor.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave();
  };

  return (
    <section
      ref={editor}
      className="max-w-xl scroll-mt-6 rounded-card border bg-card p-5"
      aria-label="Account editor"
      aria-busy={busy !== null}
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="font-medium">{existing ? "Manage account" : "Add account"}</h2>
        <Button size="sm" variant="ghost" disabled={locked} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="staff-email">Email</Label>
          <Input
            id="staff-email"
            type="email"
            placeholder="name@company.com"
            autoComplete="off"
            required
            maxLength={254}
            value={draft.email}
            onChange={(event) => update({ email: event.target.value })}
            disabled={locked}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="staff-username">Username</Label>
          <Input
            id="staff-username"
            placeholder="name"
            autoComplete="off"
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}"
            minLength={3}
            maxLength={64}
            value={draft.username}
            onChange={(event) => update({ username: event.target.value })}
            disabled={locked}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="staff-role">Role</Label>
          <Select
            value={draft.role}
            onValueChange={(value) => value != null && update({ role: value as StaffRole })}
            disabled={locked}
          >
            <SelectTrigger id="staff-role" aria-label="Role">
              <SelectValue>{(value: StaffRole | null) => roleName(value ?? "viewer")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="viewer">Viewer</SelectItem>
              <SelectItem value="owner">Super admin</SelectItem>
            </SelectPopup>
          </Select>
          <p className="text-xs text-muted-foreground">
            {draft.role === "owner"
              ? "Can read telemetry and manage staff access."
              : "Can read telemetry and export events."}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="staff-password">{existing ? "New password (optional)" : "Password"}</Label>
          <Input
            id="staff-password"
            type="password"
            placeholder={existing ? "Keep current password" : "At least 14 characters"}
            autoComplete="new-password"
            required={passwordRequired}
            minLength={14}
            maxLength={256}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            disabled={locked}
          />
          <p className="text-xs text-muted-foreground">14–256 characters.</p>
        </div>
        {existing ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <Label htmlFor="staff-enabled">Allow sign-in</Label>
            <Switch
              id="staff-enabled"
              checked={!draft.disabled}
              onCheckedChange={(on) => update({ disabled: !on })}
              disabled={locked}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={locked} pending={busy === "save"}>
            Save account
          </Button>
          {existing ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              pending={busy === "revoke"}
              onClick={onRevoke}
            >
              Sign out all sessions
            </Button>
          ) : null}
        </div>
        {existing ? (
          <p className="text-xs text-muted-foreground">
            Saving account changes signs out its active sessions.
          </p>
        ) : null}
      </form>
    </section>
  );
}
