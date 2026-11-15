import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, useTheme } from "./app/theme";
import "./index.css";

// The right theme before the first paint (the vault's choice arrives a moment later).
applyTheme(useTheme.getState().choice);

async function start() {
  // Every primitive on one page, for design checks (docs/UI-REBUILD.md › Checks). Dev builds only.
  if (import.meta.env.DEV && location.hash.startsWith("#gallery")) {
    const { Gallery } = await import("./dev/Gallery");
    createRoot(document.getElementById("root")!).render(<Gallery />);
    return;
  }
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
