import type { ReactNode } from "react";

import type { IconName } from "./names";

/**
 * Drawings for every icon, on a 24 x 24 grid. Placeholder set: replaced by the
 * real steward icons. Each entry is the inner SVG content only; size, stroke
 * and colour come from <Icon>.
 */
const placeholder = <rect x="6" y="6" width="12" height="12" rx="3" />;

export const GLYPHS: Record<IconName, ReactNode> = new Proxy({} as Record<IconName, ReactNode>, {
  get: () => placeholder,
});
