import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { request, SessionExpired, type Session } from "./api";
import { SignIn, SessionLoading } from "./SignIn";
import { ConsoleLoading } from "./Loading";
import "./style.css";
import "./theme";

const Dashboard = lazy(() => import("./Dashboard"));
const message = (error: unknown) => error instanceof Error ? error.message : "Couldn’t open the console. Try again.";

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<Session>("/session", { signal: controller.signal }).then(setSession).catch((e) => { if (!controller.signal.aborted) { if (e instanceof SessionExpired) setSession(null); else setError(message(e)); } });
    return () => controller.abort();
  }, [retry]);
  // Stable callbacks keep authenticated requests from re-running when their parent renders.
  const [signOut] = useState(() => () => { history.replaceState(null, "", location.pathname + location.search); setSession(null); });
  if (session === undefined) return <SessionLoading error={error} onRetry={() => setRetry((n) => n + 1)} />;
  return session ? <Suspense fallback={<ConsoleLoading />}><Dashboard key={`${session.email}:${session.role}`} session={session} onSignOut={signOut} /></Suspense> : <SignIn onSignIn={setSession} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
