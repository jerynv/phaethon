import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./components/shell/shell.css";
import { setSpaceActivity } from "./lib/activity";
import { initPlatform } from "./lib/platform";
import { devLog } from "./lib/tauri";
import { initAppearance } from "./theme";

// Debug builds: surface CSP violations in the terminal (the Rust side drops them in release; no-op in a browser).
document.addEventListener("securitypolicyviolation", (e) => {
  void devLog(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`);
});

// The UI preview harness (scripts/ui-preview, never shipped) drives the per-space activity
// store directly, to check the sidebar's "Answering…" / "Needs you" without a real reply.
if ("__MOCK__" in window) (window as unknown as { __setSpaceActivity: typeof setSpaceActivity }).__setSpaceActivity = setSpaceActivity;

initPlatform();
initAppearance();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Dev only: confirm the UI actually rendered under the CSP.
setTimeout(() => void devLog(`ui mounted: ${document.querySelectorAll("button").length} buttons, prototype frozen: ${Object.isFrozen(Object.prototype)}`), 1500);
