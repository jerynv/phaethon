import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nodeCli } from "../tests/cli";
import { expect, startCore, test, type Core } from "./core";

/**
 * Setting up a coding agent from nothing: onboarding installs Claude Code with
 * its maker's installer (a stand-in here that puts the fake CLI where the real
 * one goes), then signs in through the school's own login page.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const win = process.platform === "win32";
const fake = pathToFileURL(path.resolve(import.meta.dirname, "../src/server/cli/__tests__/fakes/fake-claude.mjs")).href;

/** The fake Claude Code, staged, and an "installer" that copies it into ~/.local/bin as the real one would. */
function stage(home: string): void {
  const staged = path.join(home, "staged");
  nodeCli(staged, "claude", `import ${JSON.stringify(fake)};\n`);
  fs.mkdirSync(path.join(home, "fake"), { recursive: true });
  fs.writeFileSync(
    path.join(home, win ? "install.ps1" : "install.sh"),
    win
      ? [`New-Item -ItemType Directory -Force -Path "$env:HOME\\.local\\bin" | Out-Null`, `Copy-Item '${staged}\\claude.cmd','${staged}\\claude.mjs' "$env:HOME\\.local\\bin\\"`].join("\r\n")
      : ["#!/bin/sh", 'mkdir -p "$HOME/.local/bin"', `cp '${staged}/claude' '${staged}/claude.mjs' "$HOME/.local/bin/"`].join("\n"),
  );
}

test("with no coding agent installed, onboarding installs Claude Code and signs in through a school", async ({ page }) => {
  core = await startCore({
    setup: stage,
    env: {
      PHAETHON_CLAUDE_BIN: win ? "__HOME__\\.local\\bin\\claude.cmd" : "__HOME__/.local/bin/claude",
      PHAETHON_CLAUDE_INSTALLER: win ? "__HOME__\\install.ps1" : "__HOME__/install.sh",
      FAKE_DIR: win ? "__HOME__\\fake" : "__HOME__/fake",
      FAKE_LOGIN_SETS: "1",
    },
  });
  await core.open(page, { onboarding: true });
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: /A coding agent/ }).click();
  await expect(page.getByText("None is installed yet.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Install Claude Code from claude.ai" }).click();
  await expect(page.getByText("Claude Code is installed.")).toBeVisible({ timeout: 30_000 });
  expect(fs.existsSync(path.join(core.home, ".local", "bin", win ? "claude.cmd" : "claude"))).toBe(true);

  await page.getByRole("button", { name: "My school or work signs me in (SSO)" }).click();
  try {
    await expect(page.getByText("In use")).toBeVisible({ timeout: 30_000 });
  } catch (e) {
    // What the core and the fake CLI saw, for a failure on another platform.
    const auth = path.join(core.home, "fake", "auth.log");
    console.log(`core log:\n${core.log()}\nauth.log:\n${fs.existsSync(auth) ? fs.readFileSync(auth, "utf8") : "(none)"}`);
    throw e;
  }
  const logins = fs
    .readFileSync(path.join(core.home, "fake", "auth.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).args)
    .filter((a: string[]) => a[1] === "login");
  expect(logins).toEqual([["auth", "login", "--sso"]]);
});
