import { renderToString } from "react-dom/server";
import type { Snapshot } from "./github.ts";
import type { Route } from "./layout.tsx";
import { App } from "./routes.tsx";

export { routeFor, routes } from "./routes.tsx";

export function render(route: Route, snap: Snapshot): string {
  return renderToString(<App route={route} built={snap} />);
}
