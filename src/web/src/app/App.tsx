import { useEffect, useState } from "react";
import { ToastProvider } from "@/components/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { connectCore } from "@/lib/core";
import { api } from "./api";
import { Shell } from "./Shell";
import { useNav } from "./store";
import { useApplyTheme, useTheme } from "./theme";
import { Onboarding } from "@/features/onboarding/Onboarding";

const ONBOARDED = "phaethon.onboarded";

function onboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED) === "1";
  } catch {
    return true;
  }
}

export function App() {
  useApplyTheme();
  const loadSpaces = useNav((s) => s.loadSpaces);
  const hydrate = useTheme((s) => s.hydrate);
  const [setup, setSetup] = useState(!onboarded());

  useEffect(() => {
    void connectCore().catch(() => {});
    void loadSpaces();
    void api.settings().then((s) => hydrate(s.appearance), () => {});
  }, [loadSpaces, hydrate]);

  return (
    <TooltipProvider delay={400}>
      <ToastProvider>
        {setup ? (
          <Onboarding
            onDone={() => {
              try {
                localStorage.setItem(ONBOARDED, "1");
              } catch {
                // ignore
              }
              setSetup(false);
              void loadSpaces();
            }}
          />
        ) : (
          <Shell />
        )}
      </ToastProvider>
    </TooltipProvider>
  );
}
