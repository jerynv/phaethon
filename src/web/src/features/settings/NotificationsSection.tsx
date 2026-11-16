import { useState } from "react";
import { SkeletonRows } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { invoke } from "@/lib/core";
import { invalidate } from "@/lib/query";
import { isMac } from "@/lib/platform";
import { cleanMessage } from "@/components/errors";
import { Loader, Row, SettingsGroup, SwitchRow, useLoad } from "./ui";

/**
 * Settings › Notifications: which notifications Phaethon shows, reminders'
 * lead time, quiet hours, and how it runs in the background (in the menu bar
 * after the window closes, at login, automations paused).
 */

type Kind = "reply" | "schedule" | "mail" | "reminder" | "digest" | "job";
type NotifySettings = { enabled: boolean; kinds: Record<Kind, boolean>; reminderMinutes: number; quiet: { from: string; to: string } | null };
type BackgroundSettings = { keepRunning: boolean; openAtLogin: boolean; pausedUntil?: number };

const KINDS: { id: Kind; label: string; description?: string }[] = [
  { id: "reply", label: "Replies", description: "When a reply finishes while you're in another app." },
  { id: "reminder", label: "Reminders", description: "Shortly before an event or a task's due time on the front burner." },
  { id: "schedule", label: "Scheduled tasks", description: "When one of your schedules has run." },
  { id: "mail", label: "Mail", description: "When an email is sent while you're away, and always when one couldn't be." },
  { id: "digest", label: "Daily digest" },
  { id: "job", label: "Problems with automations", description: "When a schedule or the daily review couldn't run." },
];
const LEADS = [5, 10, 15, 30, 60];
const clock = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

const KEY = "notify:settings";
const BG_KEY = "notify:background";

export function NotificationsSection() {
  const notify = useLoad(() => invoke<NotifySettings>("notify_settings_get"), [], KEY);
  const bg = useLoad(() => invoke<BackgroundSettings>("background_get"), [], BG_KEY);
  const [pending, setPending] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const saveNotify = async (which: string, patch: Partial<NotifySettings>) => {
    const before = notify.data;
    if (!before) return;
    notify.setData({ ...before, ...patch, kinds: { ...before.kinds, ...(patch.kinds ?? {}) } });
    setPending(which);
    try {
      notify.setData(await invoke<NotifySettings>("notify_settings_set", { patch }));
      invalidate("jobs:");
    } catch (e) {
      notify.setData(before);
      toast.error("Couldn’t change that", cleanMessage(e));
    } finally {
      setPending(null);
    }
  };
  const saveBg = async (which: string, cmd: string, args: Record<string, unknown>) => {
    setPending(which);
    try {
      bg.setData(await invoke<BackgroundSettings>(cmd, args));
    } catch (e) {
      toast.error("Couldn’t change that", cleanMessage(e));
    } finally {
      setPending(null);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const r = await invoke<{ shown: boolean; desktop: boolean }>("notify_test");
      if (!r.desktop) toast.info("Notifications appear in the desktop app", "This window isn’t the desktop app.");
      else if (!r.shown) toast.info("Nothing was shown", isMac() ? "Check System Settings › Notifications › Phaethon." : "Check your system’s notification settings for Phaethon.");
    } catch (e) {
      toast.error("Couldn’t send a test notification", cleanMessage(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SettingsGroup label="Notifications" action={<Button size="xs" variant="ghost" pending={testing} onClick={() => void test()}>Send a test</Button>}>
        <Loader state={notify} errorTitle="Couldn’t read your notification settings" skeleton={<SkeletonRows count={6} className="px-3 py-2" />}>
          {(s) => (
            <>
              <SwitchRow label="Show notifications" checked={s.enabled} pending={pending === "enabled"} onCheckedChange={(v) => void saveNotify("enabled", { enabled: v })} />
              {s.enabled
                ? KINDS.map((k) => (
                    <SwitchRow
                      key={k.id}
                      label={k.label}
                      description={k.description}
                      checked={s.kinds[k.id]}
                      pending={pending === k.id}
                      onCheckedChange={(v) => void saveNotify(k.id, { kinds: { [k.id]: v } as Record<Kind, boolean> })}
                    />
                  ))
                : null}
              {s.enabled && s.kinds.reminder ? (
                <Row label="Remind me">
                  <Select value={String(s.reminderMinutes)} onValueChange={(v) => v != null && void saveNotify("lead", { reminderMinutes: Number(v) })}>
                    <SelectTrigger size="sm" aria-label="How long before" className="w-40">
                      <SelectValue>{(v: string | null) => (v ? `${Number(v) >= 60 ? `${Number(v) / 60} hour` : `${v} min`} before` : "")}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {LEADS.map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {m >= 60 ? `${m / 60} hour` : `${m} min`} before
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Row>
              ) : null}
              {s.enabled ? (
                <SwitchRow
                  label="Quiet hours"
                  description={s.quiet ? "No banners or sounds then; they still collect in the menu bar." : undefined}
                  checked={!!s.quiet}
                  pending={pending === "quiet"}
                  onCheckedChange={(v) => void saveNotify("quiet", { quiet: v ? { from: "22:00", to: "07:00" } : null })}
                />
              ) : null}
              {s.enabled && s.quiet ? (
                <Row label="From">
                  <span className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Input size="sm" type="time" aria-label="Quiet from" value={s.quiet.from} onChange={(e) => e.target.value && void saveNotify("quiet", { quiet: { ...s.quiet!, from: e.target.value } })} className="w-28" />
                    to
                    <Input size="sm" type="time" aria-label="Quiet until" value={s.quiet.to} onChange={(e) => e.target.value && void saveNotify("quiet", { quiet: { ...s.quiet!, to: e.target.value } })} className="w-28" />
                  </span>
                </Row>
              ) : null}
            </>
          )}
        </Loader>
      </SettingsGroup>

      <SettingsGroup label="In the background" note="Phaethon keeps running reminders, automations and timed sends from the menu bar, using little memory: the window is closed, not hidden.">
        <Loader state={bg} errorTitle="Couldn’t read the background settings" skeleton={<SkeletonRows count={3} className="px-3 py-2" />}>
          {(b) => (
            <>
              <SwitchRow
                label={isMac() ? "Keep running in the menu bar" : "Keep running in the notification area"}
                description="When you close the window."
                checked={b.keepRunning}
                pending={pending === "keep"}
                onCheckedChange={(v) => void saveBg("keep", "background_set", { patch: { keepRunning: v } })}
              />
              <SwitchRow
                label="Open at login"
                description={isMac() ? "In the menu bar only, with no window." : "In the notification area only, with no window."}
                checked={b.openAtLogin}
                pending={pending === "login"}
                onCheckedChange={(v) => void saveBg("login", "background_set", { patch: { openAtLogin: v } })}
              />
              <Row label="Automations" description={b.pausedUntil ? `Paused until ${clock.format(b.pausedUntil)}` : "Running on their schedules."}>
                {b.pausedUntil ? (
                  <Button size="xs" variant="outline" pending={pending === "pause"} onClick={() => void saveBg("pause", "automations_resume", {})}>
                    Resume
                  </Button>
                ) : (
                  <Button size="xs" variant="outline" pending={pending === "pause"} onClick={() => void saveBg("pause", "automations_pause", { minutes: 60 })}>
                    Pause for 1 hour
                  </Button>
                )}
              </Row>
            </>
          )}
        </Loader>
      </SettingsGroup>
    </>
  );
}
