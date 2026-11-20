import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { FilterSelect } from "./FilterSelect";
import { OverviewSkeleton, TableSkeleton } from "./Loading";
import { ConsoleShell, type Page } from "./ConsoleShell";
import { Preferences } from "./Preferences";
import { CATEGORIES, LABELS, SessionExpired, eventName, request, type Category, type Detail, type EventPage, type EventSummary, type Overview, type Session } from "./api";
import { createStaffCache } from "./staff-state";

const Staff = lazy(() => import("./Staff").then((module) => ({ default: module.Staff })));

const format = new Intl.NumberFormat();
const date = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const message = (e: unknown) => e instanceof Error ? e.message : "Couldn’t load telemetry. Try again.";

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
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: "start" }); }, [item.id]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request<Detail>(`/events/${encodeURIComponent(item.id)}`, { signal: controller.signal }).then(setDetail).catch((e) => { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onExpired(); else setError(message(e)); } });
    return () => controller.abort();
  }, [item.id, onExpired]);
  return <section ref={panel} tabIndex={-1} className="min-w-0 scroll-mt-6 rounded-card border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Event detail">
    <div className="flex items-start justify-between gap-3 border-b p-4"><div><h2 className="font-medium">{eventName(item.event)}</h2><p className="mt-1 text-xs text-muted-foreground">{date(item.receivedAt)} · {item.platform} · {item.appVersion}</p></div><Button variant="ghost" size="sm" onClick={onClose}>Close</Button></div>
    {error ? <p role="alert" className="p-4 text-sm text-destructive-foreground">{error}</p> : !detail ? <div role="status" aria-label="Loading event" className="space-y-4 p-5"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div> : <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-muted-foreground">Signature verified. Self-signed events verify payload integrity; they do not attest the app or the report’s accuracy.</p>
      {detail.payload.data.messages?.map((m, i) => <div key={i} className="rounded-lg border p-3"><h3 className="mb-2 text-xs font-medium capitalize text-muted-foreground">{m.role}</h3><p className="whitespace-pre-wrap break-words text-sm">{m.text}</p></div>)}
      {detail.payload.data.text ? <p className="whitespace-pre-wrap break-words text-sm">{detail.payload.data.text}</p> : null}
      <details><summary className="cursor-pointer text-sm">Raw record</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-well p-3 font-mono text-xs">{JSON.stringify(detail, null, 2)}</pre></details>
    </div>}
  </section>;
}

function readPage(session: Session): Page {
  const hash = window.location.hash.slice(1);
  return hash === "events" || hash === "preferences" || (hash === "staff" && session.role === "owner") ? hash : "overview";
}

export default function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [staffCache] = useState(createStaffCache);
  const [page, setPage] = useState<Page>(() => readPage(session));
  const navigate = (next: Page) => { if (next !== "events") exportRequest.current?.abort(); window.location.hash = next; setPage(next); };
  useEffect(() => {
    const changed = () => setPage(readPage(session));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [session]);
  const cache = useRef(new Map<string, { overview: Overview; events: EventPage }>());
  const [days, setDays] = useState(7);
  const [category, setCategory] = useState<Category | "">("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<EventPage | null>(null);
  const [selected, setSelected] = useState<EventSummary | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [signOutError, setSignOutError] = useState("");
  const [busy, setBusy] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [more, setMore] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const queryGeneration = useRef(0);
  const pageRequest = useRef<AbortController | null>(null);
  const exportRequest = useRef<AbortController | null>(null);
  const effectiveCategory = page === "overview" ? "" : category;
  const params = new URLSearchParams({ days: String(days), ...(effectiveCategory ? { category: effectiveCategory } : {}) });

  useEffect(() => {
    const controller = new AbortController();
    queryGeneration.current++;
    const key = `${days}:${effectiveCategory}`;
    const cached = cache.current.get(key);
    setBusy(true); setMore(false); setError(""); setSelected(null);
    setEvents(cached?.events ?? null); setOverview(cached?.overview ?? null);
    Promise.all([request<Overview>(`/overview?days=${days}`, { signal: controller.signal }), request<EventPage>(`/events?${new URLSearchParams({ days: String(days), ...(effectiveCategory ? { category: effectiveCategory } : {}) })}`, { signal: controller.signal })])
      .then(([overview, events]) => { if (!controller.signal.aborted) { cache.current.set(key, { overview, events }); setOverview(overview); setEvents(events); } })
      .catch((e) => { if (!controller.signal.aborted) { if (e instanceof SessionExpired) onSignOut(); else setError(message(e)); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); pageRequest.current?.abort(); };
  }, [days, effectiveCategory, refresh, onSignOut]);

  useEffect(() => () => exportRequest.current?.abort(), []);

  const loadMore = async () => {
    if (!events?.nextCursor || more) return;
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
    setSigningOut(true); setSignOutError("");
    try { await request("/logout", { method: "POST", body: "{}" }); onSignOut(); }
    catch (e) { if (e instanceof SessionExpired) onSignOut(); else setSignOutError("Couldn’t sign out. Try again."); }
    finally { setSigningOut(false); }
  };
  const openEvent = (event: EventSummary) => {
    if (page === "overview") { setCategory(""); setSearch(""); navigate("events"); }
    setSelected(event);
  };
  const visible = events?.items.filter((e) => page === "overview" || `${e.event} ${e.platform} ${e.appVersion}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <ConsoleShell session={session} page={page} navigate={navigate} signingOut={signingOut} signOutError={signOutError} onSignOut={() => void signOut()}>
    {page === "staff" && session.role === "owner" ? <Suspense fallback={<div className="space-y-6"><h1 className="text-2xl font-medium tracking-tight">Staff access</h1><TableSkeleton columns={4} /></div>}><Staff cache={staffCache} onExpired={onSignOut} /></Suspense> : page === "preferences" ? <Preferences session={session} /> : <main className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-medium tracking-tight">{page === "overview" ? "Telemetry" : "Event explorer"}</h1><p className="mt-2 text-sm text-muted-foreground">{page === "overview" ? "A closer look at how Phaethon is being used." : "Inspect the events and feedback people have shared."}</p></div><div className="flex items-center gap-2"><FilterSelect label="Time period" value={String(days)} onChange={(value) => setDays(Number(value))} options={[7, 30, 90].map((n) => ({ value: String(n), label: `Last ${n} days` }))} className="w-36" /><Button size="icon" variant="outline" disabled={busy} aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><Icon icon={icons.reload} className={`size-4 ${busy ? "motion-safe:animate-spin" : ""}`} /></Button></div></div>
      {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 p-3 text-sm text-destructive-foreground">{error}<Button size="sm" variant="outline" onClick={() => setRefresh((n) => n + 1)}>Retry</Button></div> : null}
      {busy && overview ? <span role="status" className="sr-only">Refreshing telemetry…</span> : null}
      {page === "overview" && !overview && busy ? <OverviewSkeleton /> : null}
      {page === "overview" && overview ? <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{CATEGORIES.map((c) => <button key={c} onClick={() => { setCategory(c); navigate("events"); }} className="cursor-pointer rounded-card border bg-card p-4 text-left outline-none transition-colors hover:border-border-strong hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"><span className="text-xs text-muted-foreground">{LABELS[c]}</span><span className="mt-2 block text-2xl font-medium tabular-nums">{format.format(overview.totals[c] ?? 0)}</span></button>)}</div>
        <div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr]"><Activity points={overview.days} /><Breakdown title="Events" rows={overview.events.map((e) => ({ name: e.event, count: e.count }))} /><Breakdown title="Attempt outcomes" rows={overview.outcomes.map((e) => ({ name: e.outcome, count: e.count }))} /></div>
      </> : null}
      <section className="min-w-0" aria-busy={busy}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">{page === "overview" ? "Recent events" : "Shared events"}</h2>{page === "overview" ? <Button size="sm" variant="ghost" onClick={() => navigate("events")}>View all events<Icon icon={icons.external} className="size-3.5" /></Button> : <Button size="sm" variant="outline" pending={exporting} disabled={exporting || !events} onClick={() => void exportData()}><Icon icon={icons.download} className="size-3.5" />Export NDJSON</Button>}</div>
        {page === "events" ? <div className="mb-4 flex flex-wrap items-center gap-3"><FilterSelect label="Event category" value={category || "all"} onChange={(value) => setCategory(value === "all" ? "" : value as Category)} options={[{ value: "all", label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c, label: LABELS[c] }))]} className="w-44" /><Input type="search" aria-label="Filter loaded events" placeholder="Search loaded events…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-72" /></div> : null}
        {!events && busy ? <TableSkeleton /> : events ? <>
        <div className="overflow-x-auto rounded-card border bg-card"><table className="hidden w-full text-left text-sm sm:table"><caption className="sr-only">Shared telemetry events</caption><thead className="border-b bg-well text-xs text-muted-foreground"><tr>{["Event", "Category", "Received", "Version", "Platform"].map((h) => <th scope="col" key={h} className="whitespace-nowrap px-4 py-2 font-normal">{h}</th>)}</tr></thead><tbody className="divide-y">{(page === "overview" ? visible.slice(0, 5) : visible).map((e) => <tr key={e.id} className={selected?.id === e.id ? "bg-accent" : ""}><td className="px-4 py-3"><button className="text-left font-medium outline-none hover:text-primary focus-visible:underline" onClick={() => openEvent(e)}>{eventName(e.event)}</button></td><td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{LABELS[e.category]}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{date(e.receivedAt)}</td><td className="px-4 py-3 text-xs text-muted-foreground">{e.appVersion}</td><td className="px-4 py-3 text-xs text-muted-foreground">{e.platform}</td></tr>)}</tbody></table><ul className="divide-y sm:hidden" aria-label="Shared telemetry events">{(page === "overview" ? visible.slice(0, 5) : visible).map((e) => <li key={e.id}><button onClick={() => openEvent(e)} className="flex w-full cursor-pointer flex-col gap-2 p-4 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><span className="flex w-full items-center justify-between gap-3"><span className="text-sm font-medium">{eventName(e.event)}</span><span className="text-xs text-muted-foreground">{LABELS[e.category]}</span></span><span className="text-xs text-muted-foreground">{date(e.receivedAt)} · {e.platform} · {e.appVersion}</span></button></li>)}</ul>{!busy && !visible.length ? <div className="flex flex-col items-center gap-3 px-5 py-12 text-center"><Icon icon={icons.fileText} className="size-6 text-muted-foreground/60" /><p className="text-sm">{page === "events" && search ? "No loaded events match this filter." : "No shared events in this period."}</p><p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{page === "events" && search ? "Try a different event name, version, or platform." : "Events appear here after someone saves their privacy choices and shares activity."}</p></div> : null}</div>
        {page === "events" && events?.nextCursor ? <div className="mt-3 flex justify-center"><Button size="sm" variant="outline" pending={more} disabled={more} onClick={() => void loadMore()}>Load more</Button></div> : null}
        </> : null}
      </section>
      {page === "events" && selected ? <EventDetail key={selected.id} item={selected} onClose={() => setSelected(null)} onExpired={onSignOut} /> : null}
    </main>}
  </ConsoleShell>;
}

