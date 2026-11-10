import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import "@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css";
import "@fontsource-variable/atkinson-hyperlegible-mono/wght.css";
import "@fontsource-variable/lexend/wght.css";
import "@fontsource/opendyslexic/400.css";
import "@fontsource/opendyslexic/700.css";
import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { startAppearance } from "./lib/appearance";
import { connectCore } from "./lib/core";

async function boot() {
  // The fake core exists only in dev builds; Vite drops this branch from production.
  if (import.meta.env.DEV && location.hash.includes("mock")) {
    const { installMockCore } = await import("./dev/mock-core");
    installMockCore();
  }
  startAppearance();
  void connectCore().catch(() => {});
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
