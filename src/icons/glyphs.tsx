import type { ReactNode } from "react";

import type { IconName } from "./names";

/*
 * Phaethon's icons, drawn by hand on a 24 x 24 grid.
 *
 * Each entry is the inner SVG only: <Icon> supplies the viewBox, stroke
 * (currentColor, width from --ph-icon-stroke), round caps and round joins.
 *
 * Grid rules, so new glyphs match:
 * - Live area 3..21 (about 2px padding). Circles are r 8.5 (17 across),
 *   frames are 17 x 15 or 16 x 16 with rx 2.5, centred on 12, 12.
 * - Diagonals run at 45 degrees. Chevrons and arrowheads have a softened
 *   apex (a short quadratic curve instead of a sharp point).
 * - Solids only where a shape needs one (dots, the stop square, the lantern
 *   flame, the contrast half): fill="currentColor" stroke="none".
 * - The phaethon-only motifs: a space is a two-drawer cabinet (a compartment),
 *   the agent is a small lantern (a Phaethon lighting the way).
 */

const solid = { fill: "currentColor", stroke: "none" } as const;

/** Chevron pointing down; the others are this one turned. */
const chevronDown = "M6.5 9.25 11.1 13.85Q12 14.75 12.9 13.85L17.5 9.25";
/** The standard circle used by the status glyphs. */
const ring = <circle cx="12" cy="12" r="8.5" />;

const thumb =
  "M7.5 19.5H16a2 2 0 0 0 1.95-1.57l1.3-6A2 2 0 0 0 17.3 9.5H13.5l.6-3.1a2.1 2.1 0 0 0-2.06-2.5h-.12a1 1 0 0 0-.87.5L7.5 10.5";

export const GLYPHS: Record<IconName, ReactNode> = {
  // ---- actions ----
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  check: <path d="m5 12.75 4.25 4.25L19 7.25" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5" />
      <path d="M15.5 8.5v-2A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2" />
    </>
  ),
  edit: (
    <>
      <path d="M5 19 5.88 14.93 14.37 6.45A2.25 2.25 0 0 1 17.55 9.63L9.07 18.12Z" />
      <path d="m12.6 8.22 3.18 3.18" />
    </>
  ),
  retry: (
    <>
      <path d="M19 12a7 7 0 1 1-2.05-4.95" />
      <path d="M17 3.75V7h-3.25" />
    </>
  ),
  more: (
    <>
      <circle cx="5.75" cy="12" r="1.5" {...solid} />
      <circle cx="12" cy="12" r="1.5" {...solid} />
      <circle cx="18.25" cy="12" r="1.5" {...solid} />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10.5" />
      <path d="M7.75 10.5 11.1 13.85Q12 14.75 12.9 13.85L16.25 10.5" />
      <path d="M4.5 15.5V17A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-1.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.25" />
      <path d="m15.25 15.25 4.5 4.5" />
    </>
  ),
  send: (
    <>
      <path d="M12 19.5V5.5" />
      <path d="M6.5 11 11.1 6.4Q12 5.5 12.9 6.4L17.5 11" />
    </>
  ),
  stop: <rect x="6.25" y="6.25" width="11.5" height="11.5" rx="2.5" {...solid} />,
  attach: (
    <path
      transform="rotate(45 12 12)"
      d="M10 9.5V15a2 2 0 0 0 4 0V6.5a3 3 0 0 0-6 0V16a4 4 0 0 0 8 0V10"
    />
  ),
  remove: (
    <>
      {ring}
      <path d="M8 12h8" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.8 11.1A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.9L17.5 7" />
      <path d="M10.25 11v5M13.75 11v5" />
    </>
  ),
  play: <path d="M8.75 5.9v12.2a.9.9 0 0 0 1.37.77l9.6-6.1a.9.9 0 0 0 0-1.54l-9.6-6.1a.9.9 0 0 0-1.37.77Z" />,
  pause: (
    <>
      <rect x="7" y="5.5" width="3.5" height="13" rx="1.25" />
      <rect x="13.5" y="5.5" width="3.5" height="13" rx="1.25" />
    </>
  ),

  // ---- direction ----
  "chevron-down": <path d={chevronDown} />,
  "chevron-up": <path d={chevronDown} transform="rotate(180 12 12)" />,
  "chevron-left": <path d={chevronDown} transform="rotate(90 12 12)" />,
  "chevron-right": <path d={chevronDown} transform="rotate(-90 12 12)" />,
  "arrow-down": (
    <>
      <path d="M12 4.5v14" />
      <path d="M6.5 13 11.1 17.6Q12 18.5 12.9 17.6L17.5 13" />
    </>
  ),

  // ---- files and media ----
  file: (
    <>
      <path d="M13.5 3H8a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 8 21h8a2.5 2.5 0 0 0 2.5-2.5V8Z" />
      <path d="M13.5 3v3.5A1.5 1.5 0 0 0 15 8h3.5" />
    </>
  ),
  "file-text": (
    <>
      <path d="M13.5 3H8a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 8 21h8a2.5 2.5 0 0 0 2.5-2.5V8Z" />
      <path d="M13.5 3v3.5A1.5 1.5 0 0 0 15 8h3.5" />
      <path d="M8.75 12h6.5M8.75 15h6.5M8.75 18h4" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="15.5" cy="9" r="1.75" />
      <path d="m3.75 17.25 5-5 6.5 6.5" />
      <path d="m13 16.25 1.75-1.75 4.75 4.75" />
    </>
  ),
  "image-off": (
    <>
      <path d="M7.5 4.5H18A2.5 2.5 0 0 1 20.5 7v9.5" />
      <path d="M17 19.5H6A2.5 2.5 0 0 1 3.5 17V7.5" />
      <path d="m3.75 16.25 4-4 2.25 2.25" />
      <path d="m3.5 3.5 17 17" />
    </>
  ),
  video: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M10 9.4v5.2a.6.6 0 0 0 .9.52l4.3-2.6a.6.6 0 0 0 0-1.04l-4.3-2.6a.6.6 0 0 0-.9.52Z" />
    </>
  ),
  audio: (
    <>
      <circle cx="9.25" cy="17" r="2.75" />
      <path d="M12 17V4.25c.6 2.4 2.1 3.6 3.6 4.7 1.35 1 2.15 2.3 1.4 4.55" />
    </>
  ),
  // An open book: a course.
  book: (
    <>
      <path d="M12 6.75C10.25 5.4 7.75 4.75 4.5 4.75v12.5c3.25 0 5.75.65 7.5 2 1.75-1.35 4.25-2 7.5-2V4.75c-3.25 0-5.75.65-7.5 2Z" />
      <path d="M12 6.75v12.5" />
    </>
  ),
  folder: (
    <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.3a1.5 1.5 0 0 1 1.06.44L12 6.5h6a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17Z" />
  ),

  // ---- agent ----
  thinking: (
    <>
      <rect x="7" y="3.5" width="14" height="10.5" rx="5.25" />
      <circle cx="7" cy="17.25" r="1.75" />
      <circle cx="4.1" cy="20.15" r="1.05" {...solid} />
    </>
  ),
  tool: (
    <path
      transform="rotate(45 12 12)"
      d="M10.5 10.21A4 4 0 0 1 10.5 2.79V6.5h3V2.79A4 4 0 0 1 13.5 10.21V19a1.5 1.5 0 0 1-3 0Z"
    />
  ),
  agent: (
    <>
      <path d="M10.25 5v-.5a1.75 1.75 0 0 1 3.5 0V5" />
      <path d="M6.75 8 9.5 5h5l2.75 3Z" />
      <path d="M8 8v9M16 8v9" />
      <rect x="6.75" y="17" width="10.5" height="3" rx="1.25" />
      <path
        {...solid}
        d="M12 9.5c1.3 1.5 2 2.65 2 3.7a2 2 0 0 1-4 0c0-1.05.7-2.2 2-3.7Z"
      />
    </>
  ),
  spinner: <path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5" />,
  voice: <path d="M4.5 10.5v3M8.25 7.5v9M12 4.5v15M15.75 8v8M19.5 10v4" />,
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="10.5" rx="3" />
      <path d="M5.75 11a6.25 6.25 0 0 0 12.5 0" />
      <path d="M12 17.25v3.25M9 20.5h6" />
    </>
  ),
  phone: (
    <path d="M8.5 3.8 10.4 7.6a1.3 1.3 0 0 1-.3 1.6L8.7 10.5c1.1 2.3 2.6 3.8 4.8 4.8l1.3-1.4a1.3 1.3 0 0 1 1.6-.3l3.8 1.9a1.2 1.2 0 0 1 .6 1.5l-.7 1.8a2.5 2.5 0 0 1-2.9 1.6C10.3 19.2 4.8 13.7 3.6 6.8a2.5 2.5 0 0 1 1.6-2.9l1.8-.7a1.2 1.2 0 0 1 1.5.6Z" />
  ),

  // ---- feedback and state ----
  info: (
    <>
      {ring}
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.9" r="1.1" {...solid} />
    </>
  ),
  warning: (
    <>
      <path d="M10.27 4.6a2 2 0 0 1 3.46 0l6.9 12.2a2 2 0 0 1-1.73 3H5.1a2 2 0 0 1-1.73-3Z" />
      <path d="M12 9.5v4.25" />
      <circle cx="12" cy="16.6" r="1.1" {...solid} />
    </>
  ),
  error: (
    <>
      {ring}
      <path d="m9.25 9.25 5.5 5.5m0-5.5-5.5 5.5" />
    </>
  ),
  success: (
    <>
      {ring}
      <path d="m8.25 12.25 2.5 2.5 5-5" />
    </>
  ),
  shield: (
    <path d="M12 3.5q3.1 2 6.5 2.25v5.75c0 4-2.8 7.1-6.5 9-3.7-1.9-6.5-5-6.5-9V5.75Q8.9 5.5 12 3.5Z" />
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <path d="M12 15v2" />
    </>
  ),
  key: (
    <>
      <circle cx="8.5" cy="15.5" r="4.5" />
      <circle cx="7.6" cy="16.4" r="1.1" {...solid} />
      <path d="m11.7 12.3 7.8-7.8" />
      <path d="m17.25 6.75 2.25 2.25M14.75 9.25l1.75 1.75" />
    </>
  ),
  link: (
    <g transform="rotate(-45 12 12)">
      <path d="M10 8.75H7.25a3.25 3.25 0 0 0 0 6.5H10" />
      <path d="M14 8.75h2.75a3.25 3.25 0 0 1 0 6.5H14" />
      <path d="M9 12h6" />
    </g>
  ),
  "thumbs-up": (
    <>
      <rect x="3.75" y="10.5" width="3.75" height="9" rx="1.25" />
      <path d={thumb} />
    </>
  ),
  "thumbs-down": (
    <g transform="matrix(1 0 0 -1 0 24.5)">
      <rect x="3.75" y="10.5" width="3.75" height="9" rx="1.25" />
      <path d={thumb} />
    </g>
  ),

  // ---- app and window ----
  settings: (
    <>
      <path d="M4 7h9.25M16.75 7H20M4 12h3.25M10.75 12H20M4 17h7.25M14.75 17H20" />
      <circle cx="15" cy="7" r="1.75" />
      <circle cx="9" cy="12" r="1.75" />
      <circle cx="13" cy="17" r="1.75" />
    </>
  ),
  appearance: (
    <>
      {ring}
      <path {...solid} d="M12 3.5a8.5 8.5 0 0 1 0 17Z" />
    </>
  ),
  accessibility: (
    <>
      {ring}
      <circle cx="12" cy="7.6" r="1.4" {...solid} />
      <path d="M7.75 10.25q4.25 1.25 8.5 0" />
      <path d="M12 10.9v3.1l-2.4 3.75M12 14l2.4 3.75" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
      <path d="M5.75 8h1.5M5.75 10.75h1.5" />
    </>
  ),
  space: (
    <>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" />
      <path d="M4.5 12h15" />
      <path d="M10.25 7.75h3.5M10.25 16.25h3.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.25" r="3.75" />
      <path d="M5.25 19.75a6.75 6.75 0 0 1 13.5 0" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
    </>
  ),
  moon: <path d="M19.25 14.25A7.75 7.75 0 1 1 9.75 4.75a6.25 6.25 0 0 0 9.5 9.5Z" />,
  "window-minimize": <path d="M7 12h10" />,
  "window-maximize": <rect x="7" y="7" width="10" height="10" rx="1" />,
  "window-restore": (
    <>
      <rect x="7" y="9" width="8" height="8" rx="1" />
      <path d="M9 9V8a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" />
    </>
  ),
  "window-close": <path d="m7 7 10 10m0-10L7 17" />,
};
