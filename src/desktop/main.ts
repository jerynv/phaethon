import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, Notification, protocol, session, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHANNEL, IDENTITY } from "../shared/channel.ts";
import type { AppNotification, AppTarget, HostOp, TrayState } from "../shared/host.ts";
import { createTray } from "./tray.ts";
import { startCore, type CoreProcess } from "./core-process.ts";
import { loadSignInPage } from "./sign-in-load.ts";
import { updateCheck, updateDownload, updateInstall } from "./updater.ts";
import { keepWindowState, loadWindowState } from "./window-state.ts";

/**
 * Phaethon's desktop shell. It owns windows and native dialogs, serves the UI
 * from app://phaethon with a strict CSP, and runs the Node core as a child.
 * Everything else (files, keys, agents) lives in the core.
 */

const SCHEME = "app";
const APP_ORIGIN = `${SCHEME}://phaethon`;
const devUrl = process.env.PHAETHON_DEV_URL;
const captureTo = process.env.PHAETHON_CAPTURE;

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);

// Chromium keeps its cookie key in a "Phaethon Safe Storage" keychain entry that only the signature
// that wrote it may read. Builds are signed ad hoc, so every update asked for the login password.
// Sign-in cookies are copied to the core's own keychain entry, so the browser profile can do without.
if (process.platform === "darwin") app.commandLine.appendSwitch("use-mock-keychain");

// Skia Graphite (Chromium's Metal rasterizer on macOS) draws vector paths with multisampling: an icon's
// curves and the active tab's corners came out in about 7 grey levels, stepped instead of smooth.
// Ganesh, still GPU rasterization, antialiases them analytically (100+ levels, as text is).
// Measured by screenshotting the real window over CDP with and without the switch.
app.commandLine.appendSwitch("disable-features", "SkiaGraphite");

// A dev build installs beside the release: its own name, so its own userData (browser profile,
// window state) and single-instance lock. electron-builder.dev.yml names the packaged app the same.
if (CHANNEL === "dev") {
  app.setName(IDENTITY.productName);
  app.setPath("userData", path.join(app.getPath("appData"), IDENTITY.productName));
}

// Headless capture (scripts/capture.mjs) renders offscreen, skips the single-instance lock and uses
// a throwaway browser profile, so a capture never reads or leaves state in the app's real one.
if (captureTo) app.setPath("userData", process.env.PHAETHON_CAPTURE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-capture-")));
if (!captureTo && !app.requestSingleInstanceLock()) {
  app.quit();
}

const distDir = path.join(__dirname, "..");
const webRoot = path.join(distDir, "web");
let core: CoreProcess | undefined;
let mainWindow: BrowserWindow | undefined;
const signInWindows = new Map<number, BrowserWindow>();
let quitting = false;
/** The menu-bar icon and what the core last said it should show (and how Phaethon runs in the background). */
let tray: ReturnType<typeof createTray> | undefined;
let trayState: TrayState | undefined;
/** Notifications on screen, kept so their click handler isn't collected. */
const shownNotes = new Set<Notification>();
/** Started at login: no window until asked for. */
// macOS says whether it launched the app at login; Windows and Linux pass the flag set below.
const startHidden = () => process.argv.includes("--hidden") || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
const keepRunning = () => (trayState?.keepRunning ?? true) && !captureTo && !!tray;

function csp(): string {
  return [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function serveApp(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const root = path.resolve(webRoot);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
      if (pathname.includes("\0")) throw new Error("Invalid path");
    } catch { return new Response("Bad request", { status: 400 }); }
    let file = path.resolve(root, "." + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response("Forbidden", { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp());
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
}

function isSafeExternal(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

function hardenContents(window: BrowserWindow, allowedOrigin: string): void {
  const allowed = new URL(allowedOrigin);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    let permitted = false;
    try {
      const target = new URL(url);
      // Node's URL.origin is "null" for our registered app:// scheme.
      permitted = target.protocol === allowed.protocol && target.host === allowed.host;
    } catch {
      // Not a URL: never navigate to it.
    }
    if (!permitted) {
      event.preventDefault();
      if (isSafeExternal(url)) void shell.openExternal(url).catch(() => {});
    }
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * Web permissions are denied unless listed: the app's own pages only copy to
 * the clipboard and show video full screen, and course-site sign-in pages need nothing (no
 * camera, microphone, location, notifications or devices).
 */
function lockPermissions(target: Electron.Session, allowed: ReadonlySet<string>): void {
  target.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  target.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  target.setDevicePermissionHandler(() => false);
}
const APP_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);
const NO_PERMISSIONS = new Set<string>();

/**
 * The system's own menu for text: right-click in a field (spelling fixes,
 * cut, copy, paste, select all) or on selected text (copy, select all). The
 * page's own menus (messages, files, code) call preventDefault, so this only
 * appears where the page has none.
 */
function textMenuTemplate(contents: Electron.WebContents, p: Electron.ContextMenuParams): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (p.isEditable && p.misspelledWord) {
    for (const word of p.dictionarySuggestions.slice(0, 5)) items.push({ label: word, click: () => contents.replaceMisspelling(word) });
    if (!p.dictionarySuggestions.length) items.push({ label: "No suggestions", enabled: false });
    items.push({ label: "Add to dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    items.push({ type: "separator" });
  }
  if (p.isEditable) {
    items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste });
    items.push({ type: "separator" }, { role: "selectAll", enabled: p.editFlags.canSelectAll });
  } else if (p.selectionText.trim()) {
    items.push({ role: "copy" }, { type: "separator" }, { role: "selectAll" });
  }
  return items;
}

function textContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template = textMenuTemplate(window.webContents, params);
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });
}

/**
 * electron-updater replaces the app only when its installer left app-update.yml
 * in the resources. A dev build has none, and neither has a release packaged
 * with `electron-builder --dir`: offering those an update only failed at install.
 */
function canSelfUpdate(): boolean {
  return app.isPackaged && CHANNEL === "release" && fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
}

function createMainWindow(): BrowserWindow {
  const min = { width: 380, height: 480 };
  const saved = captureTo ? null : loadWindowState(min);
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    ...saved?.bounds,
    minWidth: min.width,
    minHeight: min.height,
    title: IDENTITY.productName,
    // Hidden until the first paint, then shown by ready-to-show. Don't set
    // paintWhenInitiallyHidden: false; Electron never fires ready-to-show then,
    // and the window stays hidden for good.
    show: false,
    // The web --background colour (src/web/src/index.css), so the first frame matches.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#ffffff",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // The buttons are 14 px across: y = 24 - 7 centres them on the title bar's line (--titlebar-line,
    // 24 px down the 40 px bar), and x is the same 17 px from the window's left edge, as macOS does in a
    // toolbar window. The web side leaves 17 + 54 + 17 px for them (--traffic-light-inset in src/web/src/index.css).
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 17, y: 17 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      offscreen: Boolean(captureTo),
    },
  });
  const origin = devUrl ? new URL(devUrl).origin : APP_ORIGIN;
  hardenContents(window, origin);
  textContextMenu(window);
  if (!captureTo) keepWindowState(window);
  // The page's <title> would replace the app's name, which is Phaethon Dev in a dev build.
  window.on("page-title-updated", (event) => event.preventDefault());
  window.once("ready-to-show", () => {
    if (captureTo) return;
    if (saved?.maximized) window.maximize();
    window.show();
  });
  void window.loadURL(devUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}

async function capture(window: BrowserWindow): Promise<void> {
  const [w, h] = (process.env.PHAETHON_CAPTURE_SIZE ?? "1280x800").split("x").map(Number);
  window.setContentSize(w || 1280, h || 800);
  window.webContents.setFrameRate(30);
  await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
  // PHAETHON_CAPTURE_SKIP_SETUP=1: capture the app itself rather than first-run setup (and PHAETHON_CAPTURE_THEME=dark|light).
  if (process.env.PHAETHON_CAPTURE_SKIP_SETUP === "1" || process.env.PHAETHON_CAPTURE_THEME) {
    const theme = process.env.PHAETHON_CAPTURE_THEME === "dark" ? "dark" : process.env.PHAETHON_CAPTURE_THEME === "light" ? "light" : null;
    await window.webContents.executeJavaScript(
      `${process.env.PHAETHON_CAPTURE_SKIP_SETUP === "1" ? 'localStorage.setItem("phaethon.onboarded","1");' : ""}${theme ? `localStorage.setItem("phaethon.theme",${JSON.stringify(theme)});` : ""}true`,
    );
    const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    window.webContents.reload();
    await reloaded;
  }
  await new Promise((r) => setTimeout(r, Number(process.env.PHAETHON_CAPTURE_DELAY || 4000)));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(captureTo!, image.toPNG());
  app.quit();
}

/** Diagnostics: the main window as a PNG, only where main's own environment says (never a path from the page). */
async function snapshot(): Promise<null> {
  const to = process.env.PHAETHON_SNAPSHOT_PATH;
  if (!to || !mainWindow) return null;
  try {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(to, image.toPNG());
    console.error("[webview] native snapshot written: true");
  } catch {
    console.error("[webview] native snapshot written: false");
  }
  return null;
}

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

async function handle(op: HostOp): Promise<unknown> {
  switch (op.op) {
    case "pickFolder": {
      const parent = parentWindow();
      const options = { title: op.title, defaultPath: op.defaultPath, properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
    case "pickFiles": {
      const parent = parentWindow();
      const properties: Array<"openFile" | "openDirectory" | "multiSelections"> = [op.folders ? "openDirectory" : "openFile"];
      if (op.multiple) properties.push("multiSelections");
      const options = { title: op.title, defaultPath: op.defaultPath, properties, filters: op.filters };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    }
    case "saveFile": {
      const parent = parentWindow();
      const options = { title: op.title, defaultPath: op.defaultPath, filters: op.filters };
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      return result.canceled ? null : (result.filePath ?? null);
    }
    case "openPath": {
      const error = await shell.openPath(op.path);
      if (error) throw new Error(error);
      return null;
    }
    case "revealPath":
      shell.showItemInFolder(op.path);
      return null;
    case "openExternal":
      if (!isSafeExternal(op.url)) throw new Error("Only web and mail links open outside Phaethon.");
      await shell.openExternal(op.url);
      return null;
    case "windowOpen": {
      const window = new BrowserWindow({
        width: op.width ?? 980,
        height: op.height ?? 760,
        title: op.title,
        minWidth: 480,
        minHeight: 480,
        center: true,
        parent: mainWindow,
        webPreferences: { partition: op.partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      lockPermissions(window.webContents.session, NO_PERMISSIONS);
      const id = window.id;
      signInWindows.set(id, window);
      const contents = window.webContents;
      let hasLoadedPage = false;
      const failed = (code: string) => core?.emit({ kind: "windowLoadFailed", window: id, code });
      // Web pages and the in-page documents SSO frames are built from; never files, app links or the app.
      const signInAllowed = (url: string) => {
        try {
          return ["https:", "http:", "about:", "blob:", "data:"].includes(new URL(url).protocol);
        } catch {
          return false;
        }
      };
      contents.setWindowOpenHandler(({ url }) => {
        // Sign-in pages sometimes open their identity provider in a popup; keep it in the same window.
        if (/^https?:/i.test(url)) void window.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
      contents.on("will-navigate", (event) => {
        if (!signInAllowed(event.url)) event.preventDefault();
      });
      contents.on("will-redirect", (event) => {
        if (!signInAllowed(event.url)) event.preventDefault();
      });
      contents.on("will-attach-webview", (event) => event.preventDefault());
      const navigated = (url: string) => core?.emit({ kind: "windowNavigated", window: id, url });
      contents.on("did-navigate", (_e, url, status) => {
        if (status > 0) hasLoadedPage = true;
        navigated(url);
      });
      contents.on("did-navigate-in-page", (_e, url) => navigated(url));
      contents.on("did-fail-load", (_event, _code, description, _url, isMainFrame) => {
        // After the first page, never repeat a sign-in form submission or a Duo step.
        if (hasLoadedPage && isMainFrame && description !== "ERR_ABORTED") failed(description);
      });
      window.on("closed", () => {
        signInWindows.delete(id);
        core?.emit({ kind: "windowClosed", window: id });
      });
      void loadSignInPage(contents, op.url, () => hasLoadedPage).then((error) => {
        if (error !== null) failed(error);
      });
      return id;
    }
    case "windowCookies": {
      const window = signInWindows.get(op.window);
      if (!window) throw new Error("That sign-in window is closed.");
      const cookies = await window.webContents.session.cookies.get(op.url ? { url: op.url } : {});
      return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? "", path: c.path ?? "/", secure: c.secure ?? false, httpOnly: c.httpOnly ?? false, expires: c.expirationDate }));
    }
    case "windowFocus":
      signInWindows.get(op.window)?.focus();
      return null;
    case "windowClose":
      signInWindows.get(op.window)?.close();
      return null;
    case "partitionClear":
      await session.fromPartition(op.partition).clearStorageData();
      return null;
    case "focusApp":
      mainWindow?.show();
      mainWindow?.focus();
      return null;
    case "updateCheck":
      return updateCheck();
    case "updateDownload":
      return updateDownload((event) => core?.emit(event));
    case "updateInstall":
      return updateInstall();
    case "dictationStart":
      if (process.platform !== "darwin") throw new Error("Use your operating system's dictation shortcut in the message field.");
      if (!mainWindow) throw new Error("Dictation did not start.");
      mainWindow.focus();
      mainWindow.webContents.focus();
      // The same action AppKit's Edit › Start Dictation sends to the focused field.
      Menu.sendActionToFirstResponder("startDictation:");
      return null;
    case "snapshot":
      return snapshot();
    case "notify":
      return { shown: showNotification(op.notification) };
    case "trayState":
      applyTrayState(op.state);
      return null;
  }
}

/** A system notification; clicking it opens what it's about. One marked whenAway waits out a focused window. */
function showNotification(n: AppNotification): boolean {
  if (!Notification.isSupported()) return false;
  if (n.whenAway && BrowserWindow.getFocusedWindow()) return false;
  const note = new Notification({ title: n.title, body: n.body, silent: n.silent ?? false });
  shownNotes.add(note);
  note.on("click", () => openApp(n.target));
  note.on("close", () => shownNotes.delete(note));
  note.show();
  if (process.env.PHAETHON_TRAY_LOG) console.error(`[tray] notification shown: ${JSON.stringify({ kind: n.kind, title: n.title })}`);
  return true;
}

function applyTrayState(state: TrayState): void {
  const before = trayState;
  trayState = state;
  tray?.update(state);
  if (process.env.PHAETHON_TRAY_LOG) console.error(`[tray] state: ${JSON.stringify({ running: state.running, sending: state.sending.length, automations: state.automations.on, recent: state.recent.length, unseen: state.unseen, keepRunning: state.keepRunning })}`);
  // Start at login, in the menu bar only (packaged builds: a dev build would register Electron itself).
  if (app.isPackaged && before?.openAtLogin !== state.openAtLogin) app.setLoginItemSettings({ openAtLogin: state.openAtLogin, args: ["--hidden"] });
  // A window closed while a reply was being written was only hidden; once nothing runs, it goes (and its memory with it).
  if (state.running === 0 && mainWindow && !mainWindow.isVisible() && hiddenForReply) {
    hiddenForReply = false;
    mainWindow.destroy();
  }
}

let hiddenForReply = false;

/** Shows the window (making one if it was closed), then whatever `target` names. */
function openApp(target?: AppTarget): void {
  if (captureTo) return;
  if (!mainWindow) {
    mainWindow = createMainWindow();
    watchMainWindow(mainWindow);
  }
  if (process.platform === "darwin") void app.dock?.show();
  bringBack();
  if (target) core?.emit({ kind: "openTarget", target });
}

/**
 * Closing the window keeps Phaethon in the menu bar (unless the person turned
 * that off): the window is destroyed, so its memory goes with it, and only the
 * small main process and the core stay. A window closed while a reply is being
 * written is hidden until the reply ends, so the reply isn't cut off.
 */
function watchMainWindow(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (quitting || !keepRunning()) return;
    if ((trayState?.running ?? 0) > 0) {
      event.preventDefault();
      hiddenForReply = true;
      window.hide();
      if (process.platform === "darwin") app.dock?.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
}

// The renderer asks for a connection; it gets a MessagePort straight to the core. Only the main
// window's own frame may ask.
ipcMain.on("phaethon:connect", (event) => {
  if (!core || event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
  event.sender.postMessage("phaethon:port", null, [core.connect()]);
});

function bringBack(): void {
  if (captureTo) return;
  if (!mainWindow) return openApp();
  hiddenForReply = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on("second-instance", bringBack);
// macOS: clicking the Dock icon brings the window back.
app.on("activate", bringBack);

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.whenReady().then(async () => {
  lockPermissions(session.defaultSession, APP_PERMISSIONS);
  core = await startCore({
    entry: path.join(distDir, "server", "main.mjs"),
    appVersion: app.getVersion(),
    env: { PHAETHON_PACKAGED: app.isPackaged ? "1" : "", PHAETHON_SELF_UPDATE: canSelfUpdate() ? "1" : "0" },
    handle,
    onExit: (code) => {
      if (!quitting) {
        dialog.showErrorBox("Phaethon stopped", `Phaethon's core stopped unexpectedly (code ${code}). Restart the app to continue.`);
        app.quit();
      }
    },
  });
  serveApp();
  if (!captureTo)
    tray = createTray({
      open: openApp,
      action: (action) => {
        if (process.env.PHAETHON_TRAY_LOG) console.error(`[tray] action: ${JSON.stringify(action)}`);
        core?.emit({ kind: "trayAction", action });
      },
      quit: () => app.quit(),
    });
  if (!captureTo && startHidden()) {
    if (process.platform === "darwin") app.dock?.hide();
  } else {
    mainWindow = createMainWindow();
    watchMainWindow(mainWindow);
    if (captureTo) void capture(mainWindow);
  }
});

app.on("window-all-closed", () => {
  // Phaethon stays in the menu bar to run reminders, automations and timed sends; the Dock icon goes with the window.
  if (keepRunning()) {
    if (process.platform === "darwin") app.dock?.hide();
    return;
  }
  app.quit();
});

app.on("before-quit", (event) => {
  if (quitting || !core) return;
  event.preventDefault();
  quitting = true;
  core.emit({ kind: "quitting" });
  void core.stop().finally(() => app.quit());
});
