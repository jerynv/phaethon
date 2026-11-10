import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { OLD_APP_IDENTIFIER } from "../env.ts";
import { vaultRoot } from "../core/vault.ts";
import { migrate, migrateLegacyRoot, moves } from "../identity/identity.ts";
import { readSettings, setSetting, settingsFile, updateSettings, validateAppearance } from "./settings.ts";
import "./commands.ts";

const env = tempHome();
afterAll(() => env.cleanup());

function writeSettings(text: string) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), text);
}

beforeEach(() => fs.rmSync(path.join(env.home, "Phaethon"), { recursive: true, force: true }));

describe("vault settings", () => {
  it("round-trips and keeps unknown fields", () => {
    expect(readSettings().backend).toBe("phaethon");
    writeSettings(`{"isolateClaudeConfig": true, "future": 1}`);
    setSetting("backend", "claude-cli");
    const s = readSettings();
    expect(s.backend).toBe("claude-cli");
    expect(s.isolateClaudeConfig).toBe(true);
    expect(fs.readFileSync(settingsFile(), "utf8")).toContain("future");
    expect(fs.existsSync(`${settingsFile()}.tmp`)).toBe(false);
  });

  it("keeps the other settings when one field has the wrong type (fixed Rust bug)", () => {
    writeSettings(JSON.stringify({ backend: "foo", model: 5, isolateClaudeConfig: "yes", provider: "openai", appearance: { theme: "dark" } }));
    const s = readSettings();
    expect(s.backend).toBe("phaethon");
    expect(s.model).toBeNull();
    expect(s.isolateClaudeConfig).toBe(false);
    expect(s.provider).toBe("openai");
    expect(s.appearance).toEqual({ theme: "dark" });
  });

  it("reads legacy names and refuses to overwrite a non-object file", () => {
    writeSettings(`{"backend":"steward","appearance":{"tokens":{"--st-accent-h":200}}}`);
    const s = readSettings();
    expect(s.backend).toBe("phaethon");
    expect((s.appearance as { tokens: Record<string, number> }).tokens["--ph-accent-h"]).toBe(200);
    writeSettings("[1, 2]");
    expect(() => setSetting("backend", "codex-cli")).toThrow("settings.json is not a JSON object; fix or remove it first");
    expect(fs.readFileSync(settingsFile(), "utf8")).toBe("[1, 2]");
    expect(readSettings().backend).toBe("phaethon");
  });

  it("writes pretty JSON with no trailing newline, and updateSettings writes only given fields", () => {
    updateSettings({ provider: "groq", model: undefined });
    expect(fs.readFileSync(settingsFile(), "utf8")).toBe('{\n  "provider": "groq"\n}');
    expect(updateSettings({ model: null }).model).toBeNull();
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))).toEqual({ provider: "groq", model: null });
  });

  it("appearance round-trips through settings and the other settings survive", async () => {
    await call("settings_set_backend", { backend: "claude-cli" });
    const a = { theme: "dark", tokens: { "--ph-accent-h": 290 } };
    await call("appearance_set", { appearance: a });
    expect(readSettings().appearance).toEqual(a);
    expect(readSettings().backend).toBe("claude-cli");
    const view = await call<Record<string, unknown>>("settings_get");
    expect(view.appearance).toEqual(a);
    expect(view.backend).toBe("claude-cli");
    expect(view.vaultPath).toBe(vaultRoot());
    await call("settings_set_backend", { backend: "steward" });
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).backend).toBe("phaethon");
    await expect(call("appearance_set", { appearance: { theme: "neon" } })).rejects.toThrow("theme must be one of: system, light, dark.");
    // A hand-edited invalid appearance comes back as {}.
    setSetting("appearance", { fontUrl: "x" });
    expect((await call<Record<string, unknown>>("settings_get")).appearance).toEqual({});
  });
});

describe("appearance validation", () => {
  it("accepts well-formed objects", () => {
    expect(() => validateAppearance({})).not.toThrow();
    expect(() =>
      validateAppearance({
        version: 1,
        theme: "dark",
        readingFont: "opendyslexic",
        reduceMotion: "on",
        increaseContrast: "system",
        tokens: {
          "--ph-accent-h": 290,
          "--ph-text-scale": 1.25,
          "--ph-tracking-normal": "0.02em",
          "--ph-focus-width": "3px",
          "--ph-some-colour": "oklch(0.62 0.08 168 / 90%)",
          "--ph-other-colour": "oklab(0.7 -0.05 0.02)",
        },
      }),
    ).not.toThrow();
  });

  it("rejects bad shapes", () => {
    const bad: unknown[] = [
      null,
      [],
      "dark",
      { theme: "neon" },
      { readingFont: "comic-sans" },
      { theme: 1 },
      { reduceMotion: "maybe" },
      { version: 0 },
      { version: "1" },
      { fontUrl: "https://example.com" },
      { tokens: [] },
      { tokens: { color: "red" } },
      { tokens: { "--ph-": 1 } },
      { tokens: { "--ph-Accent-h": 1 } },
      { tokens: { "--ph-accent-h;": 1 } },
      { tokens: { "--ph-accent-": 1 } },
      { tokens: { "--x-accent-h": 1 } },
      { tokens: { "--ph-accent-h": null } },
      { tokens: { "--ph-accent-h": true } },
      { tokens: { "--ph-accent-h": { a: 1 } } },
      { tokens: { "--ph-accent": "#ff0000" } },
      { tokens: { "--ph-accent": "rgb(1,2,3)" } },
      { tokens: { "--ph-accent": "hsl(1 2% 3%)" } },
      { tokens: { "--ph-accent": "red; background: url(x)" } },
      { tokens: { "--ph-accent": "url(x)" } },
      { tokens: { "--ph-accent": "var(--ph-danger)" } },
      { tokens: { "--ph-accent": "oklch(1 0 0) url(x)" } },
      { tokens: { "--ph-accent": "oklch(1 0 0" } },
      { tokens: { "--ph-accent": "" } },
      { tokens: { "--ph-accent": "1".repeat(65) } },
    ];
    for (const v of bad) expect(() => validateAppearance(v), JSON.stringify(v)).toThrow();
  });

  it("is bounded", () => {
    const tokens: Record<string, number> = {};
    for (let i = 0; i < 65; i++) tokens[`--ph-t${i}`] = 1;
    expect(() => validateAppearance({ tokens })).toThrow("Too many token overrides (65).");
    const big: Record<string, string> = {};
    for (let i = 0; i < 64; i++) big[`--ph-${String(i).padStart(59, "0")}`] = "1".repeat(64);
    expect(() => validateAppearance({ tokens: big })).toThrow(/Appearance is too large/);
  });
});

describe("~/Steward migration", () => {
  const home = () => env.home;
  const p = (rel: string) => path.join(home(), rel);
  beforeEach(() => fs.rmSync(p("Steward"), { recursive: true, force: true }));

  it("moves the legacy vault once and renames state folders", () => {
    fs.mkdirSync(p("Steward/default/.steward"), { recursive: true });
    fs.mkdirSync(p("Steward/default/spaces/school/.steward"), { recursive: true });
    fs.writeFileSync(p("Steward/default/spaces/school/.steward/thread.json"), "[]");
    fs.writeFileSync(p("Steward/default/.steward/settings.json"), `{"backend":"steward","appearance":{"tokens":{"--st-accent-h":200}}}`);
    migrateLegacyRoot(home());
    expect(fs.existsSync(p("Steward"))).toBe(false);
    expect(fs.statSync(p("Phaethon/default/spaces/school/.phaethon/thread.json")).isFile()).toBe(true);
    const s = readSettings();
    expect(s.backend).toBe("phaethon");
    expect((s.appearance as { tokens: Record<string, number> }).tokens["--ph-accent-h"]).toBe(200);
    // A second run, or an old folder next to a new one with files, changes nothing.
    fs.mkdirSync(p("Steward/default"), { recursive: true });
    migrateLegacyRoot(home());
    expect(fs.statSync(p("Steward/default")).isDirectory()).toBe(true);
    expect(fs.statSync(p("Phaethon/default/spaces/school/.phaethon/thread.json")).isFile()).toBe(true);
  });

  it("an empty skeleton gives way to the old vault", () => {
    fs.mkdirSync(p("Phaethon/default/spaces/work"), { recursive: true });
    fs.mkdirSync(p("Steward/default/spaces/work/.steward"), { recursive: true });
    fs.writeFileSync(p("Steward/default/spaces/work/.steward/session"), "x");
    migrateLegacyRoot(home());
    expect(fs.existsSync(p("Steward"))).toBe(false);
    expect(fs.statSync(p("Phaethon/default/spaces/work/.phaethon/session")).isFile()).toBe(true);
    expect(fs.readdirSync(home()).filter((n) => n.startsWith(".Phaethon-skeleton"))).toEqual([]);
  });

  it("never deletes ~/Phaethon while the move can't happen (fixed Rust bug)", () => {
    fs.mkdirSync(p("Phaethon/default/spaces/school"), { recursive: true });
    fs.mkdirSync(p("Steward/default"), { recursive: true });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === p("Steward")) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      return real(from, to);
    });
    try {
      for (let launch = 0; launch < 2; launch++) {
        migrateLegacyRoot(home());
        expect(fs.statSync(p("Phaethon/default/spaces/school")).isDirectory()).toBe(true);
        expect(fs.statSync(p("Steward/default")).isDirectory()).toBe(true);
      }
      expect(fs.readdirSync(home()).filter((n) => n.startsWith(".Phaethon-skeleton"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("app identifier migration", () => {
  const NEW = "io.github.jerynv.phaethon";
  const root = (name: string) => {
    const d = path.join(env.home, `identity-${name}`);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  it("pairs only folders named by the identifier, once each", () => {
    const support = "/Users/a/Library/Application Support";
    expect(moves([path.join(support, NEW), path.join(support, NEW), path.join("/Users/a/Library/Caches", NEW), "/elsewhere"], NEW)).toEqual([
      [path.join(support, OLD_APP_IDENTIFIER), path.join(support, NEW)],
      [path.join("/Users/a/Library/Caches", OLD_APP_IDENTIFIER), path.join("/Users/a/Library/Caches", NEW)],
    ]);
  });

  it("moves the old folder with everything in it, once", () => {
    const r = root("move");
    fs.mkdirSync(path.join(r, OLD_APP_IDENTIFIER, "claude-config/vault"), { recursive: true });
    fs.writeFileSync(path.join(r, OLD_APP_IDENTIFIER, "full-access.json"), '["x"]');
    const said = migrate(moves([path.join(r, NEW)], NEW));
    expect(said.length).toBe(1);
    expect(fs.existsSync(path.join(r, OLD_APP_IDENTIFIER))).toBe(false);
    expect(fs.readFileSync(path.join(r, NEW, "full-access.json"), "utf8")).toBe('["x"]');
    expect(fs.statSync(path.join(r, NEW, "claude-config/vault")).isDirectory()).toBe(true);
    expect(migrate(moves([path.join(r, NEW)], NEW))).toEqual([]);
  });

  it("never overwrites a folder already at the new name", () => {
    const r = root("both");
    fs.mkdirSync(path.join(r, OLD_APP_IDENTIFIER));
    fs.writeFileSync(path.join(r, OLD_APP_IDENTIFIER, "full-access.json"), "old");
    fs.mkdirSync(path.join(r, NEW));
    fs.writeFileSync(path.join(r, NEW, "full-access.json"), "new");
    const said = migrate(moves([path.join(r, NEW)], NEW));
    expect(said[0]).toMatch(/^left/);
    expect(fs.readFileSync(path.join(r, NEW, "full-access.json"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(r, OLD_APP_IDENTIFIER, "full-access.json"), "utf8")).toBe("old");
  });
});
