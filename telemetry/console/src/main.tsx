import { StrictMode, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CATEGORIES, LABELS, SessionExpired, eventName, request, type Category, type Detail, type EventPage, type EventSummary, type Overview } from "./api";
import "./style.css";

const format = new Intl.NumberFormat();
const date = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const message = (e: unknown) => e instanceof Error ? e.message : "Couldn’t load telemetry. Try again.";

function Wordmark() {
  return <span className="flex items-center gap-2.5 font-medium"><span aria-hidden="true" className="flex size-7 items-center justify-center rounded-lg bg-primary text-sm text-primary-foreground">P</span>Phaethon<span className="font-normal text-muted-foreground">/ Telemetry</span></span>;
}

function SignIn({ onSignIn }: { onSignIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const result = await request<{ email: string }>("/login", { method: "POST", body: JSON.stringify({ email, password }) });
      setPassword(""); onSignIn(result.email);
    } catch (e) { setError(e instanceof SessionExpired ? "Email or password wasn’t recognized." : message(e)); }
    finally { setBusy(false); }
  };
  return <main className="flex min-h-svh flex-col">
    <header className="border-b px-5 py-4"><Wordmark /></header>
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-5 py-12">
      <div><h1 className="text-2xl font-medium tracking-tight">Sign in</h1><p className="mt-2 text-sm text-muted-foreground">Use your team account to open telemetry.</p></div>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
        <div className="flex flex-col gap-2"><Label htmlFor="password">Password</Label><Input id="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
        <Button type="submit" pending={busy} className="mt-1 w-full">Sign in</Button>
      </form>
    </div>
  </main>;
}

function Activity({ points }: { points: Overview["days"] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  return <section className="rounded-card border bg-card p-4">
    <h2 className="text-sm font-medium">Events over time</h2>
    {points.length ? <>
      <div className="mt-5 flex h-36 items-end gap-1" role="img" aria-label={points.map((p) => `${p.day}: ${p.count} events`).join("; ")}>
        {points.map((p) => <div key={p.day} className="flex h-full min-w-0 flex-1 items-end"><div title={`${p.day}: ${format.format(p.count)}`} className="w-full rounded-t-sm bg-primary/75" style={{ height: `${Math.max(p.count ? 2 : 0, p.count / max * 100)}%` }} /></div>)}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{points[0]?.day}</span><span>{points.at(-1)?.day}</span></div>
    </> : <p className="py-12 text-sm text-muted-foreground">No events in this period.</p>}
  </section>;
}

function Breakdown({ title, rows }: { title: string; rows: { name: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return <section className="rounded-card border bg-card p-4"><h2 className="mb-4 text-sm font-medium">{title}</h2>
    {rows.length ? <ul className="flex flex-col gap-3">{rows.map((r) => <li key={r.name}><div className="mb-1 flex justify-between gap-3 text-xs"><span>{eventName(r.name)}</span><span className="tabular-nums text-muted-foreground">{format.format(r.count)}</span></div><div className="h-1 rounded-full bg-muted"><div className="h-full rounded-full bg-primary/65" style={{ width: `${r.count / max * 100}%` }} /></div></li>)}</ul> : <p className="text-sm text-muted-foreground">No events in this period.</p>}
  </section>;
}

function EventDetail({ item, onClose, onExpired }: { item: EventSummary; onClose: () => void; onExpired: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request<Detail>(`/events/${encodeURIComponent(item.id)}`, { signal: controller.signal }).then(setDetail).catch((e) => { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onExpired(); else setError(message(e)); } });
    return () => controller.abort();
  }, [item.id, onExpired]);
  return <section className="min-w-0 rounded-card border bg-card" aria-label="Event detail">
    <div className="flex items-start justify-between gap-3 border-b p-4"><div><h2 className="font-medium">{eventName(item.event)}</h2><p className="mt-1 text-xs text-muted-foreground">{date(item.receivedAt)} · {item.platform} · {item.appVersion}</p></div><Button variant="ghost" size="sm" onClick={onClose}>Close</Button></div>
    {error ? <p role="alert" className="p-4 text-sm text-destructive-foreground">{error}</p> : !detail ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading event…</p> : <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-muted-foreground">Signature verified. Self-signed events verify payload integrity; they do not attest the app or the report’s accuracy.</p>
      {detail.payload.data.messages?.map((m, i) => <div key={i} className="rounded-lg border p-3"><h3 className="mb-2 text-xs font-medium capitalize text-muted-foreground">{m.role}</h3><p className="whitespace-pre-wrap break-words text-sm">{m.text}</p></div>)}
      {detail.payload.data.text ? <p className="whitespace-pre-wrap break-words text-sm">{detail.payload.data.text}</p> : null}
      <details><summary className="cursor-pointer text-sm">Raw record</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-well p-3 font-mono text-xs">{JSON.stringify(detail, null, 2)}</pre></details>
    </div>}
  </section>;
}

function Dashboard({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [days, setDays] = useState(7);
  const [category, setCategory] = useState<Category | "">("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<EventPage | null>(null);
  const [selected, setSelected] = useState<EventSummary | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [more, setMore] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const queryGeneration = useRef(0);
  const pageRequest = useRef<AbortController | null>(null);
  const exportRequest = useRef<AbortController | null>(null);
  const params = new URLSearchParams({ days: String(days), ...(category ? { category } : {}) });

  useEffect(() => {
    const controller = new AbortController();
    queryGeneration.current++;
    setBusy(true); setMore(false); setError(""); setSelected(null); setEvents(null); setOverview(null);
    Promise.all([request<Overview>(`/overview?days=${days}`, { signal: controller.signal }), request<EventPage>(`/events?${new URLSearchParams({ days: String(days), ...(category ? { category } : {}) })}`, { signal: controller.signal })])
      .then(([overview, events]) => { if (!controller.signal.aborted) { setOverview(overview); setEvents(events); } })
      .catch((e) => { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onSignOut(); else setError(message(e)); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); pageRequest.current?.abort(); };
  }, [days, category, refresh, onSignOut]);

  useEffect(() => () => exportRequest.current?.abort(), []);

  const loadMore = async () => {
    if (!events?.nextCursor) return;
    const generation = queryGeneration.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    setMore(true); setError("");
    try {
      const next = await request<EventPage>(`/events?${params}&before=${encodeURIComponent(events.nextCursor)}`, { signal: controller.signal });
      if (!controller.signal.aborted && generation === queryGeneration.current) setEvents((old) => ({ items: [...(old?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
    } catch (e) { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onSignOut(); else setError(message(e)); } }
    finally { if (generation === queryGeneration.current) setMore(false); }
  };
  const exportData = async () => {
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true); setError("");
    try {
      const chunks: Blob[] = [];
      let cursor = "";
      let bytes = 0;
      const visited = new Set<string>();
      do {
        if (visited.has(cursor)) throw new Error("Couldn’t complete the export. Try again.");
        visited.add(cursor);
        const response = await fetch(`/api/export?${params}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (response.status === 401) return onSignOut();
        if (!response.ok) throw new Error("Couldn’t export events. Try again.");
        const chunk = await response.blob();
        bytes += chunk.size;
        if (bytes > 50 * 1024 * 1024) throw new Error("This export exceeds 50 MB. Choose a shorter period or one category.");
        chunks.push(chunk);
        cursor = response.headers.get("X-Next-Cursor") ?? "";
      } while (cursor && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: "application/x-ndjson" }));
      const link = document.createElement("a"); link.href = url; link.download = `phaethon-telemetry-${category || "all"}-${days}d.ndjson`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { if (!controller.signal.aborted) setError(message(e)); }
    finally { setExporting(false); exportRequest.current = null; }
  };
  const signOut = async () => {
    exportRequest.current?.abort();
    pageRequest.current?.abort();
    setSigningOut(true); setError("");
    try { await request("/logout", { method: "POST", body: "{}" }); onSignOut(); }
    catch (e) { if (e instanceof SessionExpired) onSignOut(); else setError(message(e)); }
    finally { setSigningOut(false); }
  };
  const visible = events?.items.filter((e) => `${e.event} ${e.platform} ${e.appVersion}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="min-h-svh">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 sm:px-8"><Wordmark /><div className="flex min-w-0 items-center gap-3"><span className="max-w-48 truncate text-xs text-muted-foreground">{email}</span><Button size="sm" variant="ghost" pending={signingOut} onClick={() => void signOut()}>Sign out</Button></div></header>
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-medium tracking-tight">Telemetry</h1><p className="mt-1 text-sm text-muted-foreground">Usage, reliability, and feedback from shared events.</p></div><div className="flex items-center gap-2"><label className="sr-only" htmlFor="period">Time period</label><select id="period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8 rounded-control border bg-card px-2 text-sm">{[7,30,90].map((n) => <option key={n} value={n}>Last {n} days</option>)}</select><Button size="sm" variant="outline" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>Refresh</Button></div></div>
      {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 p-3 text-sm text-destructive-foreground">{error}<Button size="sm" variant="outline" onClick={() => setRefresh((n) => n + 1)}>Retry</Button></div> : null}
      {busy ? <p role="status" className="text-sm text-muted-foreground">Loading telemetry…</p> : null}
      {overview ? <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{CATEGORIES.map((c) => <button key={c} onClick={() => setCategory(category === c ? "" : c)} aria-pressed={category === c} className="rounded-card border bg-card p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary"><span className="text-xs text-muted-foreground">{LABELS[c]}</span><span className="mt-2 block text-2xl font-medium tabular-nums">{format.format(overview.totals[c] ?? 0)}</span></button>)}</div>
        <div className="grid gap-3 lg:grid-cols-[2fr_1fr_1fr]"><Activity points={overview.days} /><Breakdown title="Events" rows={overview.events.map((e) => ({ name: e.event, count: e.count }))} /><Breakdown title="Turn outcomes" rows={overview.outcomes.map((e) => ({ name: e.outcome, count: e.count }))} /></div>
      </> : null}
      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Event explorer</h2><Button size="sm" variant="outline" pending={exporting} onClick={() => void exportData()}>Export NDJSON</Button></div>
        <div className="mb-3 flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor="category">Event category</label><select id="category" value={category} disabled={more} onChange={(e) => setCategory(e.target.value as Category | "")} className="h-8 rounded-control border bg-card px-2 text-sm"><option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{LABELS[c]}</option>)}</select><Input type="search" aria-label="Filter loaded events" placeholder="Filter loaded events…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-72" /></div>
        <div className="overflow-x-auto rounded-card border bg-card"><table className="w-full text-left text-sm"><caption className="sr-only">Shared telemetry events</caption><thead className="border-b bg-well text-xs text-muted-foreground"><tr>{["Event", "Category", "Received", "Version", "Platform"].map((h) => <th scope="col" key={h} className="whitespace-nowrap px-4 py-2 font-normal">{h}</th>)}</tr></thead><tbody className="divide-y">{visible.map((e) => <tr key={e.id} className={selected?.id === e.id ? "bg-accent" : ""}><td className="px-4 py-3"><button className="text-left font-medium outline-none hover:text-primary focus-visible:underline" onClick={() => setSelected(e)}>{eventName(e.event)}</button></td><td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{LABELS[e.category]}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{date(e.receivedAt)}</td><td className="px-4 py-3 text-xs text-muted-foreground">{e.appVersion}</td><td className="px-4 py-3 text-xs text-muted-foreground">{e.platform}</td></tr>)}</tbody></table>{!busy && !visible.length ? <p className="p-8 text-center text-sm text-muted-foreground">{search ? "No loaded events match this filter." : "No shared events in this period."}</p> : null}</div>
        {events?.nextCursor ? <div className="mt-3 flex justify-center"><Button size="sm" variant="outline" pending={more} onClick={() => void loadMore()}>Load more</Button></div> : null}
      </section>
      {selected ? <EventDetail key={selected.id} item={selected} onClose={() => setSelected(null)} onExpired={onSignOut} /> : null}
    </main>
  </div>;
}

function App() {
  const [session, setSession] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<{ email: string }>("/session", { signal: controller.signal }).then((s) => setSession(s.email)).catch((e) => { if (!controller.signal.aborted) { if (e instanceof SessionExpired) setSession(null); else setError(message(e)); } });
    return () => controller.abort();
  }, [retry]);
  // Stable callbacks keep authenticated requests from re-running when their parent renders.
  const [signOut] = useState(() => () => setSession(null));
  if (session === undefined) return <main className="mx-auto flex max-w-sm flex-col gap-3 px-5 py-16">{error ? <><p role="alert" className="text-sm">{error}</p><Button variant="outline" onClick={() => setRetry((n) => n + 1)}>Retry</Button></> : <p role="status" className="text-sm text-muted-foreground">Opening telemetry…</p>}</main>;
  return session ? <Dashboard email={session} onSignOut={signOut} /> : <SignIn onSignIn={setSession} />;
}

const media = window.matchMedia("(prefers-color-scheme: dark)");
document.documentElement.classList.toggle("dark", media.matches);
media.addEventListener("change", (e) => document.documentElement.classList.toggle("dark", e.matches));
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
