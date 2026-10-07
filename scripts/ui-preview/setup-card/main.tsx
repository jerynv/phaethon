// A test page for the first-run SetupCard on its own, until the chat renders
// it in the empty state. Built with vite.config.mjs beside it and shot with
// shoot.mjs --dist <out> --scenarios scripts/ui-preview/setup-card/scenarios.
// It stands in for the empty conversation: the space heading above, a message
// box below (where focus goes after setup). Never shipped.
import React from "react";
import ReactDOM from "react-dom/client";

import "./harness.css";
import { SetupCard } from "@/components/onboarding/setup-card";
import { initAppearance } from "@/theme";

initAppearance();

const space = { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250 };

function Harness() {
  return (
    <main className="flex min-h-dvh flex-col bg-bg text-ink">
      <h1 className="px-6 pt-4 text-lg font-semibold">School</h1>
      <div className="flex flex-1 flex-col justify-center-safe overflow-y-auto px-6 py-6">
        <SetupCard space={space} />
      </div>
      <form className="border-t border-line px-6 py-3" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="msg" className="sr-only">
          Message School
        </label>
        <textarea id="msg" data-composer-input="" rows={2} className="w-full rounded-lg border border-line-strong bg-raised px-3 py-2 text-base" />
      </form>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
