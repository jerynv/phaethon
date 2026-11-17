import { renderToString } from "react-dom/server";
import type { Snapshot } from "./github.ts";
import { Page } from "./page.tsx";

export function render(snap: Snapshot): string {
  return renderToString(<Page built={snap} />);
}
