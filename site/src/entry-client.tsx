import { hydrateRoot } from "react-dom/client";
import type { Snapshot } from "./github.ts";
import type { Route } from "./layout.tsx";
import { App } from "./routes.tsx";
import "./site.css";

const root = document.getElementById("root")!;
const built = JSON.parse(document.getElementById("snapshot")?.textContent || "null") as Snapshot;
hydrateRoot(root, <App route={root.dataset.route as Route} built={built} />);
