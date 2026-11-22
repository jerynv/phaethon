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
  | { op: "focusApp" }
  /** Asks the release feed for a newer version; nothing is downloaded. */
  | { op: "updateCheck" }
  /** Downloads the update the last check found and verifies it; progress arrives as `updateProgress` events. */
  | { op: "updateDownload" }
  /** Quits and installs the downloaded update, then starts the new version. */
  | { op: "updateInstall" }
  /** macOS: starts the system's dictation in the focused field. */
  | { op: "dictationStart" }
  /** Diagnostics: a PNG of the main window to $PHAETHON_SNAPSHOT_PATH, only when main's own environment names one. */
  | { op: "snapshot" }
  /** A system notification. Resolves with whether it was shown (one marked `whenAway` isn't while a Phaethon window has focus). */
  | { op: "notify"; notification: AppNotification }
  /** What the menu-bar menu shows, and how Phaethon runs in the background; sent whenever it changes. */
  | { op: "trayState"; state: TrayState };

/** Where a notification or a menu item takes you in the app. */
export type AppTarget = { kind: "thread"; space: string; thread: string } | { kind: "settings"; section: string } | { kind: "space"; space: string; view?: string };

export type NotificationKind = "reply" | "schedule" | "mail" | "reminder" | "digest" | "job";

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  target?: AppTarget;
  /** Only when no Phaethon window has focus (a reply you'd see anyway). */
  whenAway?: boolean;
  silent?: boolean;
  at: number;
};

export type TrayState = {
  /** Keep running in the menu bar when the last window closes. */
  keepRunning: boolean;
  /** Start at login, in the menu bar only. */
  openAtLogin: boolean;
  /** Replies being written right now (a window closed mid-reply stays alive, hidden, until they finish). */
  running: number;
  /** Emails counting down to send. */
  sending: { space: string; id: string; to: string; subject: string; sendAt: number }[];
  /** Automations: how many are on, the next one, and whether they're paused. */
  automations: { on: number; next?: { title: string; at: number }; runningTitle?: string; pausedUntil?: number };
  /** The latest notifications, newest first. */
  recent: AppNotification[];
  /** Notifications since the menu was last opened. */
  unseen: number;
};

/** What a menu-bar item asks the core to do. */
export type TrayAction =
  | { kind: "stopSend"; space: string; id: string }
  | { kind: "pauseAutomations"; minutes: number }
  | { kind: "resumeAutomations" }
  | { kind: "seen" };

/**
 * Where updates come from: the project's GitHub releases. electron-builder.yml
 * `publish` names the same repository (a test checks they agree).
 */
export const UPDATE_FEED = { provider: "github", owner: "jerynv", repo: "phaethon" } as const;

/** An update error as electron-updater raised it; the core puts it in words. */
export type UpdateError = { message: string; code?: string; statusCode?: number };
export type UpdateFound = { version: string; notes: string | null; date: string | null };
export type UpdateCheckResult =
  | { kind: "available"; update: UpdateFound }
  | { kind: "none" }
  | { kind: "failed"; error: UpdateError };
export type UpdateDownloadResult = { kind: "ok" } | { kind: "failed"; error: UpdateError };

export type HostCookie = { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires?: number };

export type HostEventBody =
  | { kind: "windowNavigated"; window: number; url: string }
  | { kind: "windowLoadFailed"; window: number; code: string }
  | { kind: "windowClosed"; window: number }
  | { kind: "quitting" }
  /** Download progress of `updateDownload`, in bytes (`total` when the server said). */
  | { kind: "updateProgress"; received: number; total: number | null }
  /** A menu-bar item was chosen. */
  | { kind: "trayAction"; action: TrayAction }
  /** A notification or menu item asks the app to show something (the window is open or opening). */
  | { kind: "openTarget"; target: AppTarget };

export type HostToCore = HostHello | HostReply | HostEvent | HostConnect;
export type CoreToHost = CoreReady | HostRequest | CoreGroups;
