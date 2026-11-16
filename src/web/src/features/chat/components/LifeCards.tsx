import { useState } from "react";
import type { UiRecord } from "#shared/agent.ts";
import { useNav } from "@/app/store";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card as Surface } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { setScheduleEnabled, updateMemory } from "@/features/life/api";
import { EmailCard } from "./EmailCard";

/**
 * What the agent did for the person's life outside the files, in chat: a quiet
 * line when it remembered or closed something (with Undo), added to a person
 * or a profile; a card for a schedule it suggests (off until turned on); and
 * the email card, which shows exactly what would go, from which account, and
 * counts down before anything is sent.
 */

type LifeRecord = Extract<UiRecord, { kind: "memory" | "person" | "profile" | "mailDraft" | "schedule" }>;

export function isLifeRecord(r: UiRecord): r is LifeRecord {
  return r.kind === "memory" || r.kind === "person" || r.kind === "profile" || r.kind === "mailDraft" || r.kind === "schedule";
}

function Line({ icon, children }: { icon: IconData; children: React.ReactNode }) {
  return (
    <div className="my-0.5 flex min-h-8 min-w-0 items-center gap-3 text-muted-foreground text-sm">
      <span className="flex w-5 shrink-0 justify-center">
        <Icon icon={icon} className="size-4" />
      </span>
      {children}
    </div>
  );
}

const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function LinkButton({ onClick, children, label }: { onClick: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="shrink-0 text-primary hover:underline">
      {children}
    </button>
  );
}

function MemoryLine({ record }: { record: Extract<UiRecord, { kind: "memory" }> }) {
  const openSettings = useNav((s) => s.openSettings);
  const [undone, setUndone] = useState(false);
  const verb = record.action === "closed" ? (record.status === "dismissed" ? "Dismissed" : "Done") : record.action === "updated" ? "Updated memory" : "Remembered";
  const time = record.when !== undefined ? fmt.format(record.when) : record.until !== undefined ? `until ${fmt.format(record.until)}` : null;
  const undo = () =>
    updateMemory(record.id, { status: "dismissed" }).then(
      () => setUndone(true),
      (e) => toast.error("Couldn’t undo", errorText(e)),
    );
  return (
    <Line icon={record.action === "closed" ? icons.done : icons.memory}>
      <span className="shrink-0">{undone ? "Forgot" : verb}</span>
      <span className={cn("min-w-0 truncate text-foreground", undone && "line-through opacity-60")}>{record.text}</span>
      {time && !undone ? <span className="shrink-0 text-subtle-foreground tabular-nums">· {time}</span> : null}
      {record.outcome && record.action === "closed" ? <span className="min-w-0 truncate text-subtle-foreground">· {record.outcome}</span> : null}
      {record.scope === "vault" && record.action !== "closed" && !undone ? <span className="shrink-0 text-subtle-foreground">· every space</span> : null}
      {record.action === "saved" && !undone ? (
        <LinkButton onClick={() => void undo()} label={`Undo: forget ${record.text}`}>
          Undo
        </LinkButton>
      ) : null}
      <LinkButton onClick={() => openSettings("memory")}>Manage</LinkButton>
    </Line>
  );
}

function PersonLine({ record }: { record: Extract<UiRecord, { kind: "person" }> }) {
  const openSettings = useNav((s) => s.openSettings);
  return (
    <Line icon={icons.person}>
      <span className="shrink-0">{record.action === "created" ? "Added to people:" : "Updated"}</span>
      <span className="shrink-0 text-foreground">{record.name}</span>
      {record.detail ? <span className="min-w-0 truncate text-subtle-foreground">· {record.detail}</span> : null}
      <LinkButton onClick={() => openSettings("people")}>Open</LinkButton>
    </Line>
  );
}

function ProfileLine({ record }: { record: Extract<UiRecord, { kind: "profile" }> }) {
  const openSettings = useNav((s) => s.openSettings);
  return (
    <Line icon={icons.person}>
      <span className="shrink-0">{record.scope === "vault" ? "Added to your profile:" : "Added to this space’s profile:"}</span>
      <span className="min-w-0 truncate text-foreground">{record.text}</span>
      <LinkButton onClick={() => openSettings("memory")}>Manage</LinkButton>
    </Line>
  );
}

function ScheduleCard({ record }: { record: Extract<UiRecord, { kind: "schedule" }> }) {
  const openSettings = useNav((s) => s.openSettings);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (next: boolean) => {
    setBusy(true);
    setScheduleEnabled(record.id, next)
      .then((s) => setOn(s.enabled), (e) => toast.error("Couldn’t change the schedule", errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Surface variant="well" className="my-3 flex-row items-center gap-3 px-4 py-3" data-slot="schedule-card">
      <Icon icon={icons.automation} className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{record.title}</div>
        <div className="truncate text-muted-foreground text-xs">
          {record.when} · {on ? "On" : "Off until you turn it on"}
        </div>
      </div>
      <Button size="xs" variant="ghost-muted" onClick={() => openSettings("automations")}>
        Edit
      </Button>
      <Switch aria-label={`Run “${record.title}” on its schedule`} checked={on} disabled={busy} onCheckedChange={toggle} />
    </Surface>
  );
}

export function LifeRecordView({ record, space }: { record: LifeRecord; space: string }) {
  switch (record.kind) {
    case "memory":
      return <MemoryLine record={record} />;
    case "person":
      return <PersonLine record={record} />;
    case "profile":
      return <ProfileLine record={record} />;
    case "schedule":
      return <ScheduleCard record={record} />;
    case "mailDraft":
      return <EmailCard space={space} id={record.id} intent={record.intent} />;
  }
}

