import { Suspense, lazy, useEffect, useState } from "react";
import { request, SessionExpired, type EventSummary, type Session, type TelemetryCategory } from "./api";
import { ConsoleShell, type Page } from "./ConsoleShell";
import { EventsPage } from "./EventsPage";
import { TableSkeleton } from "./Loading";
import { OverviewPage } from "./OverviewPage";
import { Preferences } from "./Preferences";
import { createStaffCache } from "./staff-state";
import { TelemetryPage } from "./TelemetryPage";
import { useTelemetry } from "./useTelemetry";

const Staff = lazy(() => import("./Staff").then((module) => ({ default: module.Staff })));

function readPage(session: Session): Page {
  const hash = window.location.hash.slice(1);
  if (hash === "events" || hash === "preferences") return hash;
  if (hash === "staff" && session.role === "owner") return hash;
  return "overview";
}

// Overview and Events share one TelemetryPage, so its header and period picker stay mounted between them.
const PAGE_COPY = {
  overview: { title: "Telemetry", description: "A closer look at how Phaethon is being used." },
  events: { title: "Event explorer", description: "Inspect the events and feedback people have shared." },
};

/** The signed-in console: routes between pages by URL hash and owns the telemetry query they share. */
export default function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>(() => readPage(session));
  const [staffCache] = useState(createStaffCache);
  const [days, setDays] = useState(7);
  const [category, setCategory] = useState<TelemetryCategory | "">("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<EventSummary | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");

  // Overview always counts every category; the category filter belongs to Events.
  const queryCategory = page === "overview" ? "" : category;
  const telemetry = useTelemetry({ days, category: queryCategory, refresh, onExpired: onSignOut });

  useEffect(() => {
    const changed = () => setPage(readPage(session));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [session]);

  // A new query replaces the event list, so the selection would point at nothing.
  useEffect(() => setSelected(null), [days, queryCategory, refresh]);

  const navigate = (next: Page) => {
    if (next !== "events") telemetry.cancelExport();
    window.location.hash = next;
    setPage(next);
  };

  const signOut = async () => {
    telemetry.cancelPending();
    setSigningOut(true);
    setSignOutError("");
    try {
      await request("/logout", { method: "POST", body: "{}" });
      onSignOut();
    } catch (e) {
      if (e instanceof SessionExpired) onSignOut();
      else setSignOutError("Couldn’t sign out. Try again.");
    } finally {
      setSigningOut(false);
    }
  };

  const overviewPage = () => (
    <OverviewPage
      busy={telemetry.busy}
      overview={telemetry.overview}
      events={telemetry.events}
      selectedId={selected?.id}
      onOpenCategory={(next) => {
        setCategory(next);
        navigate("events");
      }}
      onOpenEvent={(event) => {
        setCategory("");
        setSearch("");
        navigate("events");
        setSelected(event);
      }}
      onViewAll={() => navigate("events")}
    />
  );

  const eventsPage = () => (
    <EventsPage
      busy={telemetry.busy}
      events={telemetry.events}
      category={category}
      onCategoryChange={setCategory}
      search={search}
      onSearchChange={setSearch}
      selected={selected}
      onSelect={setSelected}
      loadingMore={telemetry.loadingMore}
      onLoadMore={() => void telemetry.loadMore()}
      exporting={telemetry.exporting}
      onExport={() => void telemetry.exportEvents()}
      onExpired={onSignOut}
    />
  );

  const content = () => {
    switch (page) {
      case "staff":
        return (
          <Suspense
            fallback={
              <div className="space-y-6">
                <h1 className="text-2xl font-medium tracking-tight">Staff access</h1>
                <TableSkeleton columns={4} />
              </div>
            }
          >
            <Staff cache={staffCache} onExpired={onSignOut} />
          </Suspense>
        );
      case "preferences":
        return <Preferences session={session} />;
      case "overview":
      case "events":
        return (
          <TelemetryPage
            {...PAGE_COPY[page]}
            days={days}
            onDaysChange={setDays}
            busy={telemetry.busy}
            refreshing={telemetry.busy && telemetry.overview !== null}
            error={telemetry.error}
            onRefresh={() => setRefresh((n) => n + 1)}
          >
            {page === "overview" ? overviewPage() : eventsPage()}
          </TelemetryPage>
        );
    }
  };

  return (
    <ConsoleShell
      session={session}
      page={page}
      navigate={navigate}
      signingOut={signingOut}
      signOutError={signOutError}
      onSignOut={() => void signOut()}
    >
      {content()}
    </ConsoleShell>
  );
}
