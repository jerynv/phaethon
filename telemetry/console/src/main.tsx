import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage, request, SessionExpired, type Session } from "./api";
import { SignIn, SessionLoading } from "./SignIn";
import { ConsoleLoading } from "./Loading";
import "./style.css";
import "./theme";

const Dashboard = lazy(() => import("./Dashboard"));

function App() {
  // undefined while the session check is in flight, null when signed out.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<Session>("/session", { signal: controller.signal })
      .then(setSession)
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof SessionExpired) setSession(null);
        else setError(errorMessage(e, "Couldn’t open the console. Try again."));
      });
    return () => controller.abort();
  }, [retry]);

  // Stable, so authenticated requests that depend on it don't re-run when App renders.
  const [signOut] = useState(() => () => {
    history.replaceState(null, "", location.pathname + location.search);
    setSession(null);
  });

  if (session === undefined) return <SessionLoading error={error} onRetry={() => setRetry((n) => n + 1)} />;
  if (!session) return <SignIn onSignIn={setSession} />;
  return (
    <Suspense fallback={<ConsoleLoading />}>
      <Dashboard key={`${session.email}:${session.role}`} session={session} onSignOut={signOut} />
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
