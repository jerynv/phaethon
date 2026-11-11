import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// The UI is being rebuilt from scratch; see docs/UI-REBUILD.md.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="grid h-dvh place-items-center text-sm text-neutral-500">Phaethon</main>
  </StrictMode>,
);
