import { useEffect, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { FieldError, cleanMessage } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonCard } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  deleteSchedule,
  describeSchedule,
  getDigest,
  listJobs,
  listSchedules,
  runJob,
  runScheduleNow,
  saveSchedule,
  setDigest,
  setJobEnabled,
  setScheduleEnabled,
  type DigestSettings,
  type JobView,
  type Schedule,
} from "@/features/life/api";
import { relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { ConfirmDialog, EmptyRow, Loader, SettingsGroup, Status, useLoad, type Loaded } from "../ui";
import { SpaceSelect, SpacesPicker, spaceName, untilText, useSpaceList, type SpaceLite } from "./shared";

/**
 * Settings › Automations: Phaethon's background jobs (each says why it's idle
 * when it has nothing to do), the daily digest, and the user's own schedules.
 */

const JOB_ICON: Record<string, IconData> = {
  "memory-sweep": icons.archive,
  "memory-review": icons.memory,
  "mail-people": icons.people,
  "daily-digest": icons.fileText,
};

/** While anything runs, the list is read again this often. */
const POLL_MS = 3000;

function JobStatus({ job, running }: { job: JobView | undefined; running: boolean }) {
  if (running || job?.running) return <Status tone="busy">Running…</Status>;
  if (!job) return null;
  const now = Date.now();
  if (!job.enabled) return <Status tone="neutral">Off</Status>;
  if (!job.ready.ok) return <Status tone="warning">Waiting: {job.ready.reason}</Status>;
  const last =
    job.lastRun !== undefined ? (
      job.lastOk === false ? (
        <Status tone="error" className="shrink">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Failed {relativeTime(job.lastRun, now).toLowerCase()}
            {job.lastError ? `: ${job.lastError}` : ""}
          </span>
        </Status>
      ) : (
        <span className="min-w-0 text-muted-foreground text-xs [overflow-wrap:anywhere]">
          Last run {relativeTime(job.lastRun, now).toLowerCase()}
          {job.lastResult ? `: ${job.lastResult}` : ""}
        </span>
      )
    ) : null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
      {job.next !== null ? <Status tone="ready">Next {untilText(job.next, now)}</Status> : null}
      {last}
    </span>
  );
}

function useRun(jobs: Loaded<JobView[]>) {
  const [running, setRunning] = useState<Set<string>>(new Set());
  const mark = (id: string, on: boolean) =>
    setRunning((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  // Read the list again while anything runs, so "Running…" turns into its result.
  const busy = running.size > 0 || !!jobs.data?.some((j) => j.running);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void jobs.reload(), POLL_MS);
    return () => clearInterval(t);
  }, [busy, jobs.reload]);
  return { running, mark };
}

function DigestDetail({ spaces, onChanged }: { spaces: SpaceLite[]; onChanged: () => Promise<void> }) {
  const state = useLoad(getDigest, [], "jobs:digest");
  const [time, setTime] = useState<string | null>(null);
  const save = async (d: DigestSettings) => {
    const before = state.data;
    if (!before) return;
    state.setData(d);
    try {
      state.setData(await setDigest(d));
      await onChanged();
    } catch (e) {
      state.setData(before);
      toast.error("Couldn’t change the digest", cleanMessage(e));
    }
  };
  const d = state.data;
  if (!d) return null;
  const commitTime = () => {
    if (time && time !== d.time) void save({ ...d, time });
    setTime(null);
  };
  return (
    <div className="ms-12 divide-y border-t">
      <div className="flex min-h-10 items-center gap-4 py-1.5 pe-3">
        <label htmlFor="digest-time" className="min-w-0 flex-1 text-sm">
          Time
        </label>
        <Input
          id="digest-time"
          type="time"
          size="sm"
          value={time ?? d.time.padStart(5, "0")}
          className="w-32"
          onChange={(e) => setTime(e.target.value)}
          onBlur={commitTime}
          onKeyDown={(e) => e.key === "Enter" && commitTime()}
        />
      </div>
      <div className="flex min-h-10 items-center gap-4 py-1.5 pe-1">
        <span className="min-w-0 flex-1 text-sm">Spaces</span>
        <SpacesPicker value={d.spaces} spaces={spaces} label="Spaces that get a digest" empty="Choose spaces" onChange={(next) => void save({ ...d, spaces: next })} />
      </div>
    </div>
  );
}

function JobsGroup({ jobs, spaces, running, mark }: { jobs: Loaded<JobView[]>; spaces: SpaceLite[]; running: Set<string>; mark: (id: string, on: boolean) => void }) {
  const [toggling, setToggling] = useState<string | null>(null);
  const run = async (j: JobView) => {
    mark(j.id, true);
    void jobs.reload();
    try {
      const r = await runJob(j.id);
      toast.success(j.title, r.result || "Done");
    } catch (e) {
      toast.error(`${j.title} didn’t finish`, cleanMessage(e));
    } finally {
      mark(j.id, false);
      void jobs.reload();
    }
  };
  const toggle = async (j: JobView, on: boolean) => {
    const before = jobs.data;
    if (!before) return;
    jobs.setData(before.map((x) => (x.id === j.id ? { ...x, enabled: on } : x)));
    setToggling(j.id);
    try {
      jobs.setData(await setJobEnabled(j.id, on));
    } catch (e) {
      jobs.setData(before);
      toast.error(`Couldn’t turn ${on ? "on" : "off"} ${j.title}`, cleanMessage(e));
    } finally {
      setToggling(null);
    }
  };
  return (
    <SettingsGroup label="Background jobs">
      <Loader state={jobs} errorTitle="Couldn’t read the background jobs" skeleton={<SkeletonCard rows={4} className="rounded-none border-0" />}>
        {(list) =>
          list
            .filter((j) => !j.id.startsWith("schedule:"))
            .map((j) => {
              const isRunning = running.has(j.id) || j.running;
              return (
                <div key={j.id}>
                  <div className="flex items-start gap-3 px-3 py-2.5">
                    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                      <Icon icon={JOB_ICON[j.id] ?? icons.automation} className="size-4" />
                    </span>
                    {/* The actions drop under the text in a narrow window rather than squeezing it. */}
                    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2">
                      <div className="flex min-w-56 flex-1 flex-col gap-1 pt-0.5">
                        <span className="text-sm">{j.title}</span>
                        <span className="text-muted-foreground text-xs">{j.description}</span>
                        <JobStatus job={j} running={running.has(j.id)} />
                      </div>
                      <div className="ms-auto flex shrink-0 items-center gap-2">
                        <Button size="xs" variant="outline" onClick={() => void run(j)} pending={isRunning} disabled={!j.enabled}>
                          Run now
                        </Button>
                        {j.optional ? (
                          <Switch checked={j.enabled} aria-label={j.title} disabled={toggling === j.id} aria-busy={toggling === j.id || undefined} onCheckedChange={(v) => void toggle(j, v)} />
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {j.id === "daily-digest" && j.enabled ? <DigestDetail spaces={spaces} onChanged={jobs.reload} /> : null}
                </div>
              );
            })
        }
      </Loader>
    </SettingsGroup>
  );
}

// ---- Schedules ----------------------------------------------------------------

const PRESETS: { label: string; when: string }[] = [
  { label: "Daily", when: "daily 08:00" },
  { label: "Weekdays", when: "weekdays 08:00" },
  { label: "Weekly", when: "weekly mon 09:00" },
  { label: "Hourly", when: "hourly" },
];

type Editing = { mode: "new" } | { mode: "edit"; schedule: Schedule };

function ScheduleDialog({ editing, spaces, onOpenChange, onSaved }: { editing: Editing | null; spaces: SpaceLite[]; onOpenChange: (o: boolean) => void; onSaved: () => Promise<void> }) {
  const active = useNav((s) => s.activeSpace);
  const current = editing?.mode === "edit" ? editing.schedule : undefined;
  const [title, setTitle] = useState("");
  const [space, setSpace] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [when, setWhen] = useState("");
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!editing) return;
    setError(null);
    setTitle(current?.title ?? "");
    setPrompt(current?.prompt ?? "");
    setWhen(current?.cron ?? "daily 08:00");
    setSpace(current?.space ?? (spaces.some((s) => s.id === active) ? active : (spaces[0]?.id ?? null)));
  }, [editing]);
  // How the schedule reads, as it's typed ("Every day at 7:30 AM"), or why it can't be read.
  useEffect(() => {
    if (!editing) return;
    const n = ++seq.current;
    if (!when.trim()) return setHint(null);
    const t = setTimeout(() => {
      describeSchedule(when).then(
        (r) => n === seq.current && setHint(r),
        () => n === seq.current && setHint(null),
      );
    }, 200);
    return () => clearTimeout(t);
  }, [when, editing]);
  const submit = async () => {
    if (!title.trim()) return setError("Give it a name.");
    if (!space) return setError("Choose a space.");
    if (!prompt.trim()) return setError("Say what to do.");
    if (!when.trim()) return setError("Say when to run it.");
    if (hint && !hint.ok) return setError(hint.text);
    setBusy(true);
    setError(null);
    try {
      await saveSchedule({
        ...(current ? { id: current.id } : {}),
        space,
        title: title.trim(),
        prompt: prompt.trim(),
        when: when.trim(),
      });
      await onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!editing} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{current ? "Edit schedule" : "New schedule"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-title">Name</Label>
            <Input id="schedule-title" autoFocus value={title} maxLength={80} placeholder="Morning inbox check" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Space</Label>
            <SpaceSelect value={space} onChange={setSpace} spaces={spaces} className="w-full" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-prompt">What to do</Label>
            <Textarea
              id="schedule-prompt"
              rows={3}
              value={prompt}
              maxLength={4000}
              placeholder="Summarise unread mail from people I know and draft replies to anything urgent."
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-when">When</Label>
            <div className="flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <Button key={p.label} size="xs" variant={when.trim().toLowerCase() === p.when ? "secondary" : "ghost-muted"} onClick={() => setWhen(p.when)}>
                  {p.label}
                </Button>
              ))}
            </div>
            <Input
              id="schedule-when"
              value={when}
              font="mono"
              placeholder="daily 07:30"
              aria-invalid={hint && !hint.ok ? true : undefined}
              aria-describedby="schedule-when-hint"
              onChange={(e) => setWhen(e.target.value)}
            />
            <p id="schedule-when-hint" aria-live="polite" className={cn("min-h-4 text-xs", hint && !hint.ok ? "text-destructive-foreground" : "text-muted-foreground")}>
              {hint?.text ?? ""}
            </p>
          </div>
          <FieldError>{error}</FieldError>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} pending={busy}>
            {current ? "Save" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SchedulesGroup({ jobs, spaces, running, mark }: { jobs: Loaded<JobView[]>; spaces: SpaceLite[]; running: Set<string>; mark: (id: string, on: boolean) => void }) {
  const openThread = useNav((s) => s.openThread);
  const schedules = useLoad(listSchedules, [], "jobs:schedules");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const reloadAll = async () => {
    await Promise.all([schedules.reload(), jobs.reload()]);
  };
  const toggle = async (s: Schedule, on: boolean) => {
    const before = schedules.data;
    if (!before) return;
    schedules.setData(before.map((x) => (x.id === s.id ? { ...x, enabled: on } : x)));
    setToggling(s.id);
    try {
      await setScheduleEnabled(s.id, on);
      await reloadAll();
    } catch (e) {
      schedules.setData(before);
      toast.error(`Couldn’t turn ${on ? "on" : "off"} ${s.title}`, cleanMessage(e));
    } finally {
      setToggling(null);
    }
  };
  const run = async (s: Schedule) => {
    mark(`schedule:${s.id}`, true);
    try {
      const r = await runScheduleNow(s.id);
      toast.show({
        type: "success",
        title: s.title,
        description: r.summary,
        action: {
          label: "Open",
          onClick: () => void openThread(s.space, r.thread),
        },
      });
    } catch (e) {
      toast.error(`${s.title} didn’t finish`, cleanMessage(e));
    } finally {
      mark(`schedule:${s.id}`, false);
      void jobs.reload();
    }
  };
  const remove = async (s: Schedule) => {
    try {
      await deleteSchedule(s.id);
      await reloadAll();
      toast.success(`${s.title} deleted`);
    } catch (e) {
      toast.error("Couldn’t delete the schedule", cleanMessage(e));
    }
  };
  return (
    <>
      <SettingsGroup
        label="Your schedules"
        action={
          <Button size="xs" variant="ghost" onClick={() => setEditing({ mode: "new" })} disabled={!spaces.length}>
            <Icon icon={icons.add} />
            New schedule
          </Button>
        }
        note="Runs happen while Phaethon is open. A run can’t approve anything, so it only reads and drafts."
      >
        <Loader state={schedules} errorTitle="Couldn’t read your schedules" skeleton={<SkeletonCard rows={2} className="rounded-none border-0" />}>
          {(list) =>
            list.length === 0 ? (
              <EmptyRow>No schedules yet.</EmptyRow>
            ) : (
              list.map((s) => {
                const job = jobs.data?.find((j) => j.id === `schedule:${s.id}`);
                const isRunning = running.has(`schedule:${s.id}`);
                return (
                  <div key={s.id} className="flex items-start gap-3 px-3 py-2.5">
                    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                      <Icon icon={icons.automation} className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <Truncate className="min-w-0 text-sm">{s.title}</Truncate>
                        {s.origin === "agent" && !s.enabled ? <Badge variant="info">Suggested by Phaethon</Badge> : null}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {s.when} · {spaceName(spaces, s.space)}
                      </span>
                      {s.enabled || isRunning ? <JobStatus job={job} running={isRunning} /> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`Run ${s.title} now`} pending={isRunning} onClick={() => void run(s)} />}>
                          <Icon icon={icons.play} />
                        </TooltipTrigger>
                        <TooltipPopup>Run now</TooltipPopup>
                      </Tooltip>
                      <Menu>
                        <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`More for ${s.title}`} />}>
                          <Icon icon={icons.more} />
                        </MenuTrigger>
                        <MenuPopup align="end" className="w-40">
                          <MenuItem onClick={() => setEditing({ mode: "edit", schedule: s })}>
                            <Icon icon={icons.edit} />
                            Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => setDeleting(s)}>
                            <Icon icon={icons.delete} />
                            Delete
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                      <Switch
                        className="ms-1"
                        checked={s.enabled}
                        aria-label={s.title}
                        disabled={toggling === s.id}
                        aria-busy={toggling === s.id || undefined}
                        onCheckedChange={(v) => void toggle(s, v)}
                      />
                    </div>
                  </div>
                );
              })
            )
          }
        </Loader>
      </SettingsGroup>
      <ScheduleDialog editing={editing} spaces={spaces} onOpenChange={(o) => !o && setEditing(null)} onSaved={reloadAll} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.title ?? "schedule"}?`}
        confirm="Delete"
        destructive
        onConfirm={() => deleting && void remove(deleting)}
      >
        <p>Conversations it already started stay.</p>
      </ConfirmDialog>
    </>
  );
}

export function AutomationsSection() {
  const spaces = useSpaceList();
  const jobs = useLoad(listJobs, [], "jobs:list");
  const { running, mark } = useRun(jobs);
  return (
    <>
      <JobsGroup jobs={jobs} spaces={spaces} running={running} mark={mark} />
      <SchedulesGroup jobs={jobs} spaces={spaces} running={running} mark={mark} />
    </>
  );
}
