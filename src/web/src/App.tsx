import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { AppShell } from "@/app/AppShell";
import { useNav } from "@/app/nav";
import { useSpaces } from "@/app/spaces";
import { isOnboarded, markOnboarded, Onboarding, type OnboardingResult } from "@/features/onboarding/Onboarding";

/** How long to wait for the core before showing first-run setup anyway. */
const SETTINGS_WAIT_MS = 3000;

/**
 * First run shows setup; after that, the app. Someone whose vault already
 * has a working assistant (set up before this version) skips setup.
 */
export function App() {
  const [phase, setPhase] = useState<"checking" | "onboarding" | "app">(() => (isOnboarded() ? "app" : "checking"));

  useEffect(() => {
    if (phase !== "checking") return;
    let settled = false;
    const settle = (next: "onboarding" | "app") => {
      if (settled) return;
      settled = true;
      if (next === "app") markOnboarded();
      setPhase(next);
    };
    const t = setTimeout(() => settle("onboarding"), SETTINGS_WAIT_MS);
    api.settings().then(
      (s) => settle(s.providerReady ? "app" : "onboarding"),
      () => settle("onboarding"),
    );
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "checking") return null;
  if (phase === "onboarding") {
    return (
      <Onboarding
        onFinish={async (result: OnboardingResult) => {
          if (result.openCourses && result.spaceId) {
            const space = useSpaces.getState().spaces.find((s) => s.id === result.spaceId);
            if (!space?.educationEnabled) {
              await api.updateSpace({ id: result.spaceId, educationEnabled: true }).catch(() => {});
            }
            useNav.getState().go({ kind: "courses" }, result.spaceId);
          }
          setPhase("app");
        }}
      />
    );
  }
  return <AppShell />;
}
