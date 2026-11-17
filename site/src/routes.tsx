import type { Snapshot } from "./github.ts";
import { Shell, useLive, type Route } from "./layout.tsx";
import { DownloadPage } from "./pages/download.tsx";
import { HomePage } from "./pages/home.tsx";
import { StatusPage } from "./pages/status.tsx";

/**
 * The site's pages. Each is its own HTML file at the site root (index.html,
 * download.html, status.html: Cloudflare serves them at /, /download and
 * /status); the build fills in its head from here and prerenders its body.
 */
export const routes: Record<Route, { file: string; path: string; title: string; description: string }> = {
  home: {
    file: "index.html",
    path: "/",
    title: "Phaethon",
    description: "An open-source desktop app for the AI you choose, with each part of your life in its own space of plain files. For macOS, Windows and Linux.",
  },
  download: {
    file: "download.html",
    path: "/download",
    title: "Download Phaethon",
    description: "Phaethon for macOS, Windows and Linux, or built from source.",
  },
  status: {
    file: "status.html",
    path: "/status",
    title: "Status · Phaethon",
    description: "Where Phaethon stands: the latest release, the build on main, recent changes and the roadmap.",
  },
};

export function routeFor(file: string): Route {
  const found = (Object.keys(routes) as Route[]).find((r) => routes[r].file === file);
  if (!found) throw new Error(`No route for ${file}`);
  return found;
}

export function App({ route, built }: { route: Route; built: Snapshot }) {
  const live = useLive(built);
  return (
    <Shell route={route} stars={live.snap.stars} bleed={route === "home"}>
      {route === "home" ? <HomePage {...live} /> : route === "download" ? <DownloadPage {...live} /> : <StatusPage {...live} />}
    </Shell>
  );
}
