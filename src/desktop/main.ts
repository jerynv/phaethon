import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HostOp } from "../shared/host.ts";
import { startCore, type CoreProcess } from "./core-process.ts";

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

// Headless capture (scripts/capture.mjs) renders offscreen and skips the single-instance lock.
if (!captureTo && !app.requestSingleInstanceLock()) {
  app.quit();
}

const distDir = path.join(__dirname, "..");
const webRoot = path.join(distDir, "web");
let core: CoreProcess | undefined;
let mainWindow: BrowserWindow | undefined;
const signInWindows = new Map<number, BrowserWindow>();
let quitting = false;

function csp(port: number): string {
  return [
    "default-src 'self'",
    `connect-src 'self' http://127.0.0.1:${port} ws://127.0.0.1:${port}`,
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

function serveApp(port: number): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const root = path.resolve(webRoot);
    let file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) return new Response("Forbidden", { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp(port));
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) {
      event.preventDefault();
      if (isSafeExternal(url)) void shell.openExternal(url);
    }
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 380,
    minHeight: 480,
    title: "Phaethon",
    show: false,
    paintWhenInitiallyHidden: Boolean(captureTo),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17171a" : "#fafafa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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
  window.once("ready-to-show", () => {
    if (!captureTo) window.show();
  });
  void window.loadURL(devUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}

async function capture(window: BrowserWindow): Promise<void> {
  window.webContents.setFrameRate(30);
  await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
  await new Promise((r) => setTimeout(r, Number(process.env.PHAETHON_CAPTURE_DELAY || 4000)));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(captureTo!, image.toPNG());
  app.quit();
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
        parent: mainWindow,
        webPreferences: { partition: op.partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      const id = window.id;
      signInWindows.set(id, window);
      window.webContents.setWindowOpenHandler(({ url }) => {
        // Sign-in pages sometimes open their identity provider in a popup; keep it in the same window.
        void window.loadURL(url);
        return { action: "deny" };
      });
      const navigated = (url: string) => core?.emit({ kind: "windowNavigated", window: id, url });
      window.webContents.on("did-navigate", (_e, url) => navigated(url));
      window.webContents.on("did-navigate-in-page", (_e, url) => navigated(url));
      window.on("closed", () => {
        signInWindows.delete(id);
        core?.emit({ kind: "windowClosed", window: id });
      });
      void window.loadURL(op.url);
      return id;
    }
    case "windowCookies": {
      const window = signInWindows.get(op.window);
      if (!window) throw new Error("That sign-in window is closed.");
      const cookies = await window.webContents.session.cookies.get({ url: op.url });
      return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? "", path: c.path ?? "/", secure: c.secure ?? false, httpOnly: c.httpOnly ?? false, expires: c.expirationDate }));
    }
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
  }
}

ipcMain.handle("phaethon:connection", (event) => {
  if (!core || event.sender !== mainWindow?.webContents) throw new Error("The core isn't running.");
  return { url: `ws://127.0.0.1:${core.port}/ws`, token: core.token };
});

app.on("second-instance", () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.whenReady().then(async () => {
  const origins = devUrl ? [new URL(devUrl).origin] : [APP_ORIGIN];
  core = await startCore({
    entry: path.join(distDir, "server", "main.mjs"),
    origins,
    appVersion: app.getVersion(),
    handle,
    onExit: (code) => {
      if (!quitting) {
        dialog.showErrorBox("Phaethon stopped", `Phaethon's core stopped unexpectedly (code ${code}). Restart the app to continue.`);
        app.quit();
      }
    },
  });
  serveApp(core.port);
  mainWindow = createMainWindow();
  mainWindow.on("closed", () => (mainWindow = undefined));
  if (captureTo) void capture(mainWindow);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (quitting || !core) return;
  event.preventDefault();
  quitting = true;
  core.emit({ kind: "quitting" });
  void core.stop().finally(() => app.quit());
});
