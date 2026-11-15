import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, useTheme } from "./app/theme";
import "./index.css";

// The right theme before the first paint (the vault's choice arrives a moment later).
applyTheme(useTheme.getState().choice);

async function start() {
  if (import.meta.env.DEV && location.hash.startsWith("#mock")) {
    const { installMockCore } = await import("./dev/mock-core");
    installMockCore();
  }
  const { App } = await import("./app/App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
