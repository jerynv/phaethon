// Development: esbuild watches the core and the desktop shell, Vite serves the
// UI on :5173 with hot reload, and Electron loads it (PHAETHON_DEV_URL).
// Electron restarts when the core or the shell is rebuilt. Ctrl-C stops
// everything this script started, and only that: each child leads its own
// process group, which is what gets signalled.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import electron from "electron";

const root = path.resolve(import.meta.dirname, "..");
const port = 5173;
const devUrl = `http://localhost:${port}`;
const outputs = ["dist/server/main.mjs", "dist/desktop/main.cjs", "dist/desktop/preload.cjs"].map((f) => path.join(root, f));
const started = Date.now();
const children = new Set();
let electronChild;
let stopping = false;

function start(name, command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit", detached: process.platform !== "win32" });
  child.label = name;
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && name !== "electron") {
      console.error(`[dev] ${name} stopped (${signal ?? code}); stopping the rest`);
      void stop(1);
    }
  });
  return child;
}

function kill(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      kill(child, "SIGKILL");
      resolve();
    }, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const all = [...children];
  for (const child of all) kill(child, "SIGTERM");
  await Promise.all(all.map((child) => waitExit(child, 5000)));
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void stop(0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, test, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopping) return;
    if (await test()) return;
    await sleep(150);
  }
  console.error(`[dev] gave up waiting for ${what}`);
  await stop(1);
}

const built = () => outputs.every((f) => fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs >= started - 1000);
const viteUp = () =>
  new Promise((resolve) => {
    const req = http.get(devUrl, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => req.destroy());
  });

function startElectron() {
  // PHAETHON_DEV_ELECTRON_ARGS: extra switches, e.g. headless ones for an unattended check.
  const extra = (process.env.PHAETHON_DEV_ELECTRON_ARGS ?? "").split(" ").filter(Boolean);
  electronChild = start("electron", electron, [...extra, "."], { PHAETHON_DEV_URL: devUrl });
  const mine = electronChild;
  mine.on("exit", () => {
    // Closing the window ends the session; a restart replaces the child first.
    if (!stopping && electronChild === mine) void stop(0);
  });
}

let restartTimer;
function restartElectronSoon() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    if (stopping || !electronChild) return;
    console.log("[dev] core or shell rebuilt; restarting Electron");
    const old = electronChild;
    electronChild = undefined;
    kill(old, "SIGTERM");
    await waitExit(old, 5000);
    if (!stopping) startElectron();
  }, 400);
}

start("esbuild", process.execPath, [path.join(root, "scripts/build-node.mjs"), "--watch"]);
start("vite", process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"]);
await until("the first core and shell build", built);
await until(`Vite on ${devUrl}`, viteUp);
if (!stopping) {
  startElectron();
  for (const dir of ["dist/server", "dist/desktop"]) {
    fs.watch(path.join(root, dir), (_event, file) => {
      if (file && /\.(mjs|cjs)$/.test(String(file))) restartElectronSoon();
    });
  }
}
