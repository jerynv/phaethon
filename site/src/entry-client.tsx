import { hydrateRoot } from "react-dom/client";
import type { Snapshot } from "./github.ts";
import { Page } from "./page.tsx";
import "./site.css";

const built = JSON.parse(document.getElementById("snapshot")?.textContent || "null") as Snapshot;
hydrateRoot(document.getElementById("root")!, <Page built={built} />);
