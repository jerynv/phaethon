/**
 * The private control channel between Electron's main process and the Node
 * core (JSON lines on file descriptor 3). Only main can open native dialogs and
 * browser windows, and only the core may hold credentials, so anything that
 * needs both (a folder the user picked, cookies from a course-site sign-in)
 * travels here and never through the renderer.
 */

/** main → core, once, before anything else. */
export type HostHello = { t: "hello"; token: string; origins: string[]; appVersion: string; platform: string };
/** core → main, once it listens. */
export type CoreReady = { t: "ready"; port: number };

/** core → main request, answered by a `HostReply` with the same id. */
export type HostRequest = { t: "hreq"; id: number; op: HostOp };
export type HostReply = { t: "hres"; id: number; ok: true; value: unknown } | { t: "hres"; id: number; ok: false; error: string };
/** main → core, unprompted (a sign-in window navigated or closed). */
export type HostEvent = { t: "hevt"; event: HostEventBody };

export type DialogFilter = { name: string; extensions: string[] };

export type HostOp =
  | { op: "pickFolder"; title: string; defaultPath?: string }
  | { op: "pickFiles"; title: string; defaultPath?: string; multiple: boolean; folders?: boolean; filters?: DialogFilter[] }
  | { op: "saveFile"; title: string; defaultPath?: string; filters?: DialogFilter[] }
  | { op: "openPath"; path: string }
  | { op: "revealPath"; path: string }
  | { op: "openExternal"; url: string }
  /** Opens a sign-in window with its own cookie partition. Resolves with a window id. */
  | { op: "windowOpen"; url: string; title: string; partition: string; width?: number; height?: number }
  /** Cookies the window's session holds for `url`. */
  | { op: "windowCookies"; window: number; url: string }
  | { op: "windowClose"; window: number }
  /** Drops a sign-in partition's cookies and storage. */
  | { op: "partitionClear"; partition: string }
  | { op: "focusApp" };

export type HostCookie = { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires?: number };

export type HostEventBody =
  | { kind: "windowNavigated"; window: number; url: string }
  | { kind: "windowClosed"; window: number }
  | { kind: "quitting" };

export type HostToCore = HostHello | HostReply | HostEvent;
export type CoreToHost = CoreReady | HostRequest;
