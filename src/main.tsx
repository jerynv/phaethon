import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Follow the system light/dark setting live. The `.dark` class (shadcn convention)
// leaves room for an explicit in-app override later.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", darkQuery.matches);
applyScheme();
darkQuery.addEventListener("change", applyScheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
