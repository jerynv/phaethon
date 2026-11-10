/**
 * The private control channel between Electron's main process and the Node
 * core (messages over the utility process's parent port). Only main can open native dialogs and
 * browser windows, and only the core may hold credentials, so anything that
 * needs both (a folder the user picked, cookies from a course-site sign-in)
 * travels here and never through the renderer.
 */

/** main → core, once, before anything else. */
export type HostHello = { t: "hello"; appVersion: string; platform: string };
/** core → main, once it accepts connections. */
export type CoreReady = { t: "ready" };
/** main → core: a renderer connection; the MessagePort travels with this message. */
export type HostConnect = { t: "connect" };
/**
 * core → main: the process groups the core's children lead right now. Main
 * kills them if the core itself dies, so no agent outlives a crashed core.
 */
export type CoreGroups = { t: "groups"; pgids: number[] };

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
  /** Cookies the window's session holds for `url`, or every cookie it holds when `url` is left out. */
  | { op: "windowCookies"; window: number; url?: string }
  | { op: "windowClose"; window: number }
  /** Brings an open sign-in window to the front. */
  | { op: "windowFocus"; window: number }
  /** Drops a sign-in partition's cookies and storage. */
  | { op: "partitionClear"; partition: string }
  | { op: "focusApp" };

export type HostCookie = { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires?: number };

export type HostEventBody =
  | { kind: "windowNavigated"; window: number; url: string }
  | { kind: "windowClosed"; window: number }
  | { kind: "quitting" };

export type HostToCore = HostHello | HostReply | HostEvent | HostConnect;
export type CoreToHost = CoreReady | HostRequest | CoreGroups;
