import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { devLog } from "./lib/tauri";
import { initAppearance } from "./theme";

// Debug builds: surface CSP violations in the terminal (the Rust side drops them in release; no-op in a browser).
document.addEventListener("securitypolicyviolation", (e) => {
  void devLog(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`);
});

initAppearance();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Dev only: confirm the UI actually rendered under the CSP.
setTimeout(() => void devLog(`ui mounted: ${document.querySelectorAll("button").length} buttons`), 1500);
