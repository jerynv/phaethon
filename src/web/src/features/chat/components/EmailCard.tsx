import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useNav, useOpenThread } from "@/app/store";
import { copyText, FileChip } from "@/components/file-chip";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { MailMark, appLabel } from "@/components/mail-mark";
import { LiveFigures } from "@/components/live-figures";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card as Surface } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/core";
import { fetchQuery, getQueryData, setQueryData } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/features/chat/lib/attachments";
import {
  accountsFor,
  discardDraft,
  draftForBlock,
  getDraft,
  listPeople,
  openDraft,
  reviewDraft,
  rewriteDraft,
  sendDraft,
  stopDraft,
  updateDraft,
  type Draft,
  type DraftPatch,
  type MailAccount,
  type PersonListed,
} from "@/features/life/api";

/**
 * The email card: one compact compose surface for every email in chat,
 * whether the agent made it with its draft tool or wrote a `phaethon-email`
 * block (every backend can). Its head says where it belongs: the space, and
 * the account it sends from, chosen only among that space's accounts. Fields
 * are edited in place and saved as you leave them; one Send button sends
 * after a short undo window. An email the agent was asked to send counts down
 * here (Stop, Edit, Send now) and nothing goes before the count ends.
 */

/** Shared with Settings › People and every other card (lib/query.ts), so a card shows names at once. */
const PEOPLE_KEY = ["people:list"] as const;
const draftKey = (space: string, id: string) => ["mail:draft", space, id] as const;

function namesFrom(list: PersonListed[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of list ?? []) for (const e of p.emails) m.set(e.toLowerCase(), p.name);
  return m;
}

function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const splitList = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function Countdown({ left, total }: { left: number; total: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const f = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0 -rotate-90" aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2.5" className="stroke-border" />
      <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-primary transition-[stroke-dashoffset] duration-300 ease-linear" strokeDasharray={c} strokeDashoffset={c * (1 - f)} />
    </svg>
  );
}

/** One labelled line of the compose surface. */
function Line({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 border-t px-4 py-1.5">
      <label htmlFor={htmlFor} className="w-12 shrink-0 text-muted-foreground text-xs">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ text, sub, warn, onRemove }: { text: string; sub?: string; warn?: boolean; onRemove?: () => void }) {
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-sm", warn ? "border-warning/40 bg-warning/8" : "bg-card", !onRemove && "pr-2.5")} title={sub}>
      <span className="shrink-0">{text}</span>
      {sub ? <span className={cn("min-w-0 truncate", warn ? "text-warning-foreground" : "text-subtle-foreground")}>{sub}</span> : null}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${text}`} className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
          <Icon icon={icons.close} className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

const TONES = [
  { label: "More formal", ask: "Make it more formal and professional." },
  { label: "Shorter", ask: "Make it shorter and more direct; keep every fact." },
  { label: "Warmer", ask: "Make it warmer and friendlier." },
];

export function EmailCard({ space, initial, id, intent }: { space: string; initial?: Draft; id?: string; intent?: "draft" | "send" }) {
  // A card shown again (scrolled back to, a reopened chat) starts from the draft it last showed.
  const [d, setDraftState] = useState<Draft | null>(() => {
    const own = initial?.id ?? id;
    const cached = own ? getQueryData<Draft>(draftKey(space, own)) : undefined;
    return cached && (!initial || cached.updated >= initial.updated) ? cached : (initial ?? null);
  });
  const setD = (x: Draft) => {
    setDraftState(x);
    setQueryData(draftKey(space, x.id), x);
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<MailAccount[]>(() => getQueryData<MailAccount[]>(["mail:accounts", space]) ?? []);
  const [names, setNames] = useState<Map<string, string>>(() => namesFrom(getQueryData<PersonListed[]>(PEOPLE_KEY)));
  const [adding, setAdding] = useState("");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [showCc, setShowCc] = useState(false);
  const [custom, setCustom] = useState<string | null>(null);
  const spaceName = useNav((s) => s.spaces.data?.find((x) => x.id === space));
  const openSettings = useNav((s) => s.openSettings);
  const draftId = d?.id ?? id;
  const now = useNow(d?.status === "scheduled" ? 250 : null);
  const left = d?.sendAt !== undefined ? d.sendAt - now : 0;
  const live = d?.status === "scheduled" || d?.status === "sending";
  const [announce, setAnnounce] = useState("");
  const said = useRef("");

  useEffect(() => {
    let alive = true;
    const own = initial?.id ?? id;
    if (initial && !getQueryData(draftKey(space, initial.id))) setQueryData(draftKey(space, initial.id), initial);
    // Always read it again quietly: it may have been sent, stopped or edited elsewhere.
    if (own)
      getDraft(space, own).then(
        (x) => alive && setD(x),
        (e) => alive && !d && setLoadError(errorText(e)),
      );
    fetchQuery(["mail:accounts", space], () => accountsFor(space)).then((a) => alive && setAccounts(a), () => {});
    fetchQuery(PEOPLE_KEY, () => listPeople()).then((list) => alive && setNames(namesFrom(list)), () => {});
    return () => {
      alive = false;
    };
  }, [space, id, initial]);

  // Fields follow the saved draft, except while being typed in.
  const editingRef = useRef(false);
  useEffect(() => {
    if (!d || editingRef.current) return;
    setSubject(d.subject);
    setBody(d.body);
    if (d.cc.length || d.bcc.length) setShowCc(true);
  }, [d?.updated]);

  // The core owns the countdown; follow it, faster near the end.
  useEffect(() => {
    if (!live || !draftId) return;
    const t = setInterval(() => getDraft(space, draftId).then(setD, () => {}), d?.status === "sending" || left < 1500 ? 400 : 1000);
    return () => clearInterval(t);
  }, [live, draftId, space, d?.status, left < 1500]);

  useEffect(() => {
    if (!d) return;
    const k = `${d.status}:${d.sendAt ?? ""}`;
    if (k === said.current) return;
    said.current = k;
    setAnnounce(
      d.status === "scheduled" ? `Sending in ${Math.round((d.sendAt! - Date.now()) / 1000)} seconds unless you stop it.` : d.status === "sent" ? "Sent." : d.status === "failed" ? `Not sent: ${d.error ?? ""}` : "",
    );
  }, [d]);

  if (loadError) return <p className="my-2 text-muted-foreground text-sm">This email couldn’t be shown: {loadError}</p>;
  if (!d || !draftId) return <Surface variant="well" className="my-3 h-44 animate-skeleton" aria-busy="true" aria-label="Loading the email" />;

  const editable = d.status === "draft" || d.status === "failed" || d.status === "opened";
  const run = (which: string, f: () => Promise<Draft>, failed: string) => {
    if (busy) return Promise.resolve();
    setBusy(which);
    return f()
      .then((x) => setD(x), (e) => toast.error(failed, errorText(e)))
      .finally(() => setBusy(null));
  };
  const save = (patch: DraftPatch) => run("save", () => updateDraft(space, draftId, patch), "Couldn’t save the change");
  const dirty = subject !== d.subject || body !== d.body;
  const flush = async () => {
    if (dirty) await updateDraft(space, draftId, { subject, body }).then(setD);
  };
  const addRecipients = (field: "to" | "cc", text: string) => {
    const add = splitList(text);
    if (!add.length) return;
    void save({ [field]: [...d[field], ...add] });
    setAdding("");
  };
  const send = () =>
    run(
      "send",
      async () => {
        await flush();
        return sendDraft(space, draftId);
      },
      "Couldn’t send it",
    );
  const pause = () => run("pause", () => updateDraft(space, draftId, {}), "Couldn’t pause the send");

  const total = d.sendAt !== undefined ? Math.max(1, d.sendAt - d.updated) : 1;
  const status =
    d.status === "scheduled"
      ? `Sending in ${mmss(left)}`
      : d.status === "sending"
        ? "Sending…"
        : d.status === "sent"
          ? `Sent ${d.sentAt ? clock.format(d.sentAt) : ""}`
          : d.status === "failed"
            ? "Not sent"
            : d.status === "opened"
              ? "Opened in Mail"
              : d.status === "discarded"
                ? "Discarded"
                : intent === "send" || d.intent === "send"
                  ? "Ready to send"
                  : "Draft";
  const account = accounts.find((a) => a.key === d.account);
  const fromAddress = /<([^>]+)>/.exec(d.sender)?.[1] ?? d.sender;

  if (d.status === "discarded") {
    return (
      <div className="my-1 flex min-h-8 items-center gap-3 text-muted-foreground text-sm">
        <Icon icon={icons.mail} className="ml-0.5 size-4" />
        <span className="shrink-0">Discarded email</span>
        <span className="min-w-0 truncate text-foreground">{d.subject || "(no subject)"}</span>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 460, damping: 36 }} className="my-3">
      <Surface className="gap-0 p-0" data-slot="mail-draft" data-status={d.status} role="group" aria-label={`Email: ${d.subject || "no subject"}`}>
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
        {/* Where it belongs: status, the space, and the account it goes from. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {d.status === "scheduled" ? <Countdown left={left} total={total} /> : d.status === "sending" ? <Spinner size="sm" className="text-muted-foreground" /> : <MailMark provider={d.provider} className="size-5" />}
            <span className={cn("shrink-0 font-medium text-sm", d.status === "sent" ? "text-success-foreground" : d.status === "failed" ? "text-destructive-foreground" : d.status === "scheduled" ? "text-primary" : "text-foreground")} data-slot="draft-status">
              {d.status === "scheduled" ? <LiveFigures text={status} /> : status}
            </span>
            {spaceName ? (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs" title="This email uses this space’s mail accounts only">
                <SpaceAvatar hue={spaceName.hue} />
                <span className="truncate">{spaceName.name}</span>
              </span>
            ) : null}
          </div>
          {editable && accounts.length > 1 ? (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="ghost-muted" className="min-w-0 gap-1.5" aria-label={`From ${d.sender}. Change account`} />}>
                <MailMark provider={d.provider} className="size-4" />
                <span className="min-w-0 truncate">{fromAddress}</span>
                <Icon icon={icons.chevronsUpDown} />
              </MenuTrigger>
              <MenuPopup align="end" className="w-64">
                {accounts.map((a) => (
                  <MenuItem key={a.key} onClick={() => void save({ account: a.key })}>
                    <MailMark provider={a.provider} className="size-4" />
                    <span className="min-w-0 flex-1 truncate">{a.emails[0]}</span>
                    {a.key === d.account ? <Icon icon={icons.check} /> : null}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs" title={`${d.accountName} via ${appLabel(d.account.split(":")[0] as Parameters<typeof appLabel>[0])}`}>
              <MailMark provider={d.provider} className="size-4" />
              <span className="truncate">{fromAddress}</span>
            </span>
          )}
        </div>

        <Line label="To" htmlFor={`to-${draftId}`}>
          {d.to.map((a) => (
            <Chip key={a} text={names.get(a) ?? a} sub={names.get(a) ? a : "not in People"} warn={!names.get(a)} onRemove={editable ? () => void save({ to: d.to.filter((x) => x !== a) }) : undefined} />
          ))}
          {(d.missing ?? []).map((n) => (
            <Chip key={n} text={n} sub="add their address" warn />
          ))}
          {editable ? (
            <Input
              id={`to-${draftId}`}
              unstyled
              nativeInput
              value={adding}
              placeholder={d.to.length ? "" : d.missing?.length ? "Type their address" : "Add a recipient"}
              aria-label="Add a recipient"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
                  if (adding.trim()) {
                    e.preventDefault();
                    addRecipients("to", adding);
                  }
                } else if (e.key === "Backspace" && !adding && d.to.length) void save({ to: d.to.slice(0, -1) });
              }}
              onBlur={() => addRecipients("to", adding)}
              className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle-foreground"
            />
          ) : null}
          {editable && !showCc ? (
            <button type="button" onClick={() => setShowCc(true)} className="ml-auto shrink-0 text-muted-foreground text-xs hover:text-foreground">
              Cc
            </button>
          ) : null}
        </Line>
        {showCc ? (
          <Line label="Cc">
            {d.cc.map((a) => (
              <Chip key={a} text={names.get(a) ?? a} sub={names.get(a) ? a : undefined} onRemove={editable ? () => void save({ cc: d.cc.filter((x) => x !== a) }) : undefined} />
            ))}
            {editable ? (
              <Input
                unstyled
                nativeInput
                aria-label="Add a Cc recipient"
                placeholder="Add"
                onKeyDown={(e) => {
                  const t = e.currentTarget;
                  if ((e.key === "Enter" || e.key === ",") && t.value.trim()) {
                    e.preventDefault();
                    addRecipients("cc", t.value);
                    t.value = "";
                  }
                }}
                onBlur={(e) => {
                  addRecipients("cc", e.currentTarget.value);
                  e.currentTarget.value = "";
                }}
                className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle-foreground"
              />
            ) : null}
          </Line>
        ) : null}
        <Line label="Subject" htmlFor={`subject-${draftId}`}>
          {editable ? (
            <Input
              id={`subject-${draftId}`}
              unstyled
              nativeInput
              value={subject}
              aria-label="Subject"
              onFocus={() => (editingRef.current = true)}
              onChange={(e) => setSubject(e.target.value)}
              onBlur={() => {
                editingRef.current = false;
                if (subject !== d.subject) void save({ subject });
              }}
              className="min-w-0 flex-1 bg-transparent font-medium text-sm outline-none"
            />
          ) : (
            <span className="min-w-0 font-medium text-sm wrap-anywhere">{d.subject || "(no subject)"}</span>
          )}
        </Line>
        <div className="border-t px-4 py-3" data-slot="draft-body">
          {editable ? (
            <Textarea
              unstyled
              value={body}
              aria-label="Message"
              onFocus={() => (editingRef.current = true)}
              onChange={(e) => setBody(e.target.value)}
              onBlur={() => {
                editingRef.current = false;
                if (body !== d.body) void save({ body });
              }}
              className="block w-full text-sm leading-relaxed [&_textarea]:max-h-none [&_textarea]:min-h-24 [&_textarea]:resize-none [&_textarea]:bg-transparent [&_textarea]:p-0"
            />
          ) : (
            <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{d.body}</p>
          )}
        </div>

        {d.attachments?.length ? (
          <div role="group" aria-label="Attachments" className="flex min-w-0 flex-wrap items-center gap-1.5 border-t px-4 py-2.5" data-slot="draft-attachments">
            {d.attachments.map((a) => (
              <span key={a.path} className="inline-flex max-w-full min-w-0 items-center gap-0.5">
                {/* Opens in Phaethon's viewer, so what goes out can be checked first. */}
                <FileChip
                  space={space}
                  path={a.path}
                  label={
                    <>
                      {a.name} <span className="text-subtle-foreground">{formatBytes(a.size)}</span>
                    </>
                  }
                />
                {editable ? (
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    disabled={!!busy}
                    onClick={() => void save({ attachments: d.attachments!.filter((x) => x.path !== a.path).map((x) => x.path) })}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Icon icon={icons.close} className="size-3.5" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}

        {d.review && editable ? (
          <div className="flex flex-col gap-1 border-t px-4 py-2.5 text-xs" data-slot="draft-review">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="rounded-full bg-info/8 px-2 py-0.5 font-medium text-info-foreground">{d.review.tone || "Reviewed"}</span>
              <span className="min-w-0 text-muted-foreground">{d.review.summary}</span>
            </div>
            {d.review.issues.length ? (
              d.review.issues.map((i) => (
                <p key={i} className="flex items-start gap-1.5 text-warning-foreground">
                  <Icon icon={icons.warning} className="mt-0.5 size-3.5 shrink-0" />
                  {i}
                </p>
              ))
            ) : (
              <p className="flex items-center gap-1.5 text-success-foreground">
                <Icon icon={icons.check} className="size-3.5" />
                Ready to send.
              </p>
            )}
          </div>
        ) : null}
        {(d.note && (d.status === "draft" || d.status === "sent")) || (d.status === "failed" && d.error) ? (
          <p className={cn("border-t px-4 py-2 text-xs", d.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground")}>{d.status === "failed" ? d.error : d.note}</p>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-b-card border-t bg-well px-3 py-2">
          {d.status === "scheduled" ? (
            <>
              <Button size="sm" pending={busy === "stop"} onClick={() => void run("stop", () => stopDraft(space, draftId), "Couldn’t stop it")}>
                <Icon icon={icons.stop} />
                Stop
              </Button>
              <Button size="sm" variant="outline" pending={busy === "pause"} onClick={() => void pause()}>
                <Icon icon={icons.edit} />
                Edit
              </Button>
              <Button size="sm" variant="ghost" pending={busy === "now"} onClick={() => void run("now", () => sendDraft(space, draftId, true), "Couldn’t send it")}>
                Send now
              </Button>
            </>
          ) : editable ? (
            <>
              <Button size="sm" pending={busy === "send"} disabled={!d.to.length || !!busy} onClick={() => void send()} aria-label={d.to.length ? `Send to ${d.to.map((a) => names.get(a) ?? a).join(", ")}` : "Send (add a recipient first)"}>
                <Icon icon={icons.mailSend} />
                {d.status === "failed" ? "Try again" : "Send"}
              </Button>
              <Button size="sm" variant="ghost" pending={busy === "open"} onClick={() => void run("open", async () => (await flush(), openDraft(space, draftId)), "Couldn’t open it in Mail")}>
                Open in Mail
              </Button>
              {custom === null ? (
                <Menu>
                  <MenuTrigger render={<Button size="sm" variant="ghost-muted" pending={busy === "review" || busy === "tone"} />}>
                    Review &amp; tone
                    <Icon icon={icons.chevronDown} />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-48">
                    <MenuItem onClick={() => void run("review", async () => (await flush(), reviewDraft(space, draftId)), "Couldn’t review it")}>
                      <Icon icon={icons.view} />
                      Review it
                    </MenuItem>
                    <MenuSeparator />
                    {TONES.map((t) => (
                      <MenuItem key={t.label} onClick={() => void run("tone", async () => (await flush(), rewriteDraft(space, draftId, t.ask)), "Couldn’t rewrite it")}>
                        {t.label}
                      </MenuItem>
                    ))}
                    <MenuItem onClick={() => setCustom("")}>Something else…</MenuItem>
                  </MenuPopup>
                </Menu>
              ) : (
                <form
                  className="flex min-w-48 flex-1 items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const ask = custom.trim();
                    setCustom(null);
                    if (ask) void run("tone", async () => (await flush(), rewriteDraft(space, draftId, ask)), "Couldn’t rewrite it");
                  }}
                >
                  <Input size="compact" autoFocus placeholder="How should it change?" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="How should it change?" onKeyDown={(e) => e.key === "Escape" && setCustom(null)} />
                  <Button size="xs" type="submit" variant="outline">
                    Rewrite
                  </Button>
                </form>
              )}
              <Button size="icon-sm" variant="ghost-destructive" className="ml-auto" aria-label="Discard this email" pending={busy === "discard"} onClick={() => void run("discard", () => discardDraft(space, draftId), "Couldn’t discard it")}>
                <Icon icon={icons.delete} />
              </Button>
            </>
          ) : d.status === "sent" ? (
            <span className="px-1 text-muted-foreground text-xs">
              Sent from {fromAddress} via {appLabel(d.account.split(":")[0] as Parameters<typeof appLabel>[0])}
            </span>
          ) : d.status === "sending" ? (
            <span className="px-1 text-muted-foreground text-xs">Handing it to Mail…</span>
          ) : null}
          {account === undefined && accounts.length === 0 && editable ? (
            <Button size="sm" variant="link" className="ml-1" onClick={() => openSettings("mail")}>
              Mail settings
            </Button>
          ) : null}
        </div>
      </Surface>
    </motion.div>
  );
}

/** Reads a block leniently for the fallback card. */
function readLoose(code: string): { to: string[]; subject: string; body: string } | null {
  try {
    const o = JSON.parse(code) as Record<string, unknown>;
    const to = Array.isArray(o.to) ? o.to.filter((x): x is string => typeof x === "string") : typeof o.to === "string" ? [o.to] : [];
    return { to, subject: typeof o.subject === "string" ? o.subject : "", body: typeof o.body === "string" ? o.body : "" };
  } catch {
    return null;
  }
}

/** A `phaethon-email` block: the email card once the block is whole; until a space has mail, the email to copy and a way to set mail up. */
export function EmailBlock({ code, space, streaming }: { code: string; space: string; streaming: boolean }) {
  const thread = useOpenThread(space);
  const openSettings = useNav((s) => s.openSettings);
  const blockKey = ["mail:block", space, code] as const;
  const [draft, setDraft] = useState<Draft | null>(() => getQueryData<Draft>(blockKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const loose = readLoose(code);

  useEffect(() => {
    if (streaming || asked.current === code) return;
    asked.current = code;
    fetchQuery(blockKey, () => draftForBlock(space, code, thread)).then(setDraft, (e) => setError(errorText(e)));
  }, [streaming, code, space, thread]);

  if (streaming || (!draft && !error)) {
    return (
      <Surface variant="well" className="my-3 flex-row items-center gap-2.5 px-4 py-3 text-muted-foreground text-sm" aria-busy="true">
        <Spinner size="sm" />
        {streaming ? "Writing an email…" : "Getting the email ready…"}
      </Surface>
    );
  }
  if (draft) return <EmailCard space={space} initial={draft} />;
  return (
    <Surface className="my-3 gap-0 p-0" data-slot="mail-draft" data-status="unavailable">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <Icon icon={icons.mail} className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">Email</span>
        <span className="min-w-0 truncate text-muted-foreground text-xs">{error}</span>
      </div>
      {loose ? (
        <>
          {loose.to.length ? (
            <Line label="To">
              <span className="min-w-0 text-sm">{loose.to.join(", ")}</span>
            </Line>
          ) : null}
          <Line label="Subject">
            <span className="min-w-0 font-medium text-sm">{loose.subject || "(no subject)"}</span>
          </Line>
          <p className="border-t px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{loose.body}</p>
        </>
      ) : (
        <pre className="border-t px-4 py-3 text-xs whitespace-pre-wrap">{code}</pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5 rounded-b-card border-t bg-well px-3 py-2">
        <Button size="sm" onClick={() => openSettings("mail")}>
          <Icon icon={icons.mail} />
          Set up mail
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyText(loose ? `Subject: ${loose.subject}\n\n${loose.body}` : code, "Email copied")}>
          <Icon icon={icons.copy} />
          Copy
        </Button>
      </div>
    </Surface>
  );
}
