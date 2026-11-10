import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  dials,
  effective,
  isDefaultAppearance,
  isValidTokenValue,
  resetAppearance,
  sanitizeAppearance,
  withDial,
} from "./appearance-model";
import { matchShortcut } from "../app/shortcuts";
import { relativeTime } from "./platform";

describe("sanitizeAppearance", () => {
  it("turns nonsense into the defaults", () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance([1, 2])).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance({ theme: "purple", readingFont: 3 })).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps valid choices and drops unknown top-level keys the core would refuse", () => {
    const a = sanitizeAppearance({ theme: "dark", readingFont: "lexend", reduceMotion: "on", increaseContrast: "off", extra: 1 });
    expect(a).toEqual({ ...DEFAULT_APPEARANCE, theme: "dark", readingFont: "lexend", reduceMotion: "on", increaseContrast: "off" });
    expect("extra" in a).toBe(false);
  });

  it("keeps tokens this UI doesn't show, so an older file keeps its choices", () => {
    const a = sanitizeAppearance({ tokens: { "--ph-accent-h": 290, "--ph-neutral-c": "0.01", "--st-old": 1, "--ph-bad-": 1 } });
    expect(a.tokens).toEqual({ "--ph-accent-h": 290, "--ph-neutral-c": "0.01" });
  });

  it("refuses token values the core's validator refuses", () => {
    expect(isValidTokenValue("oklch(0.5 0.1 200)")).toBe(true);
    expect(isValidTokenValue("0.02em")).toBe(true);
    expect(isValidTokenValue("var(--x)")).toBe(false);
    expect(isValidTokenValue("calc(1px + 2px)")).toBe(false);
    expect(isValidTokenValue("")).toBe(false);
    expect(isValidTokenValue(Number.NaN)).toBe(false);
    expect(isValidTokenValue("url(x)")).toBe(false);
  });
});

describe("dials", () => {
  it("reads the defaults", () => {
    expect(dials(DEFAULT_APPEARANCE)).toEqual({
      textScale: 1,
      focusRings: false,
      largeTargets: false,
      leading: 1.55,
      tracking: 0,
      wordSpacing: 0,
    });
  });

  it("snaps old values to the nearest offered stop, never below 100% text", () => {
    const a = sanitizeAppearance({ tokens: { "--ph-text-scale": 0.9, "--ph-leading-normal": 1.7, "--ph-tracking-normal": "0.05em" } });
    const d = dials(a);
    expect(d.textScale).toBe(1);
    expect(d.leading).toBe(1.8);
    expect(d.tracking).toBe(0.04);
  });

  it("writes tokens in the old file format and removes defaults", () => {
    let a = withDial(DEFAULT_APPEARANCE, "textScale", 1.5);
    a = withDial(a, "focusRings", true);
    a = withDial(a, "largeTargets", true);
    a = withDial(a, "tracking", 0.08);
    expect(a.tokens).toEqual({ "--ph-text-scale": 1.5, "--ph-focus-rings": 1, "--ph-target-size": 44, "--ph-tracking-normal": "0.08em" });
    a = withDial(a, "textScale", 1);
    expect("--ph-text-scale" in a.tokens).toBe(false);
    expect(isDefaultAppearance(a)).toBe(false);
  });

  it("resets to defaults but keeps tokens it doesn't own", () => {
    const a = sanitizeAppearance({ theme: "dark", tokens: { "--ph-text-scale": 2, "--ph-accent-h": 10 } });
    const r = resetAppearance(a);
    expect(r.theme).toBe("system");
    expect(r.tokens).toEqual({ "--ph-accent-h": 10 });
    expect(isDefaultAppearance(r)).toBe(true);
  });
});

describe("effective", () => {
  const sys = { dark: true, moreContrast: true, reduceMotion: true };
  it("follows the system where asked", () => {
    expect(effective(DEFAULT_APPEARANCE, sys)).toEqual({ dark: true, moreContrast: true, reduceMotion: true });
  });
  it("lets an explicit choice win both ways", () => {
    const a = { ...DEFAULT_APPEARANCE, theme: "light" as const, increaseContrast: "off" as const, reduceMotion: "off" as const };
    expect(effective(a, sys)).toEqual({ dark: false, moreContrast: false, reduceMotion: false });
    const b = { ...DEFAULT_APPEARANCE, theme: "dark" as const, increaseContrast: "on" as const, reduceMotion: "on" as const };
    expect(effective(b, { dark: false, moreContrast: false, reduceMotion: false })).toEqual({ dark: true, moreContrast: true, reduceMotion: true });
  });
});

describe("shortcuts", () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: "", code: "", getModifierState: () => false, ...init }) as KeyboardEvent;
  // Node has no navigator platform: shortcuts use Ctrl.
  it("matches the app shortcuts with Ctrl off a Mac", () => {
    expect(matchShortcut(key({ ctrlKey: true, key: "n" }))).toEqual({ id: "newChat" });
    expect(matchShortcut(key({ ctrlKey: true, key: "k" }))).toEqual({ id: "search" });
    expect(matchShortcut(key({ ctrlKey: true, shiftKey: true, key: "F" }))).toEqual({ id: "search" });
    expect(matchShortcut(key({ ctrlKey: true, key: "\\", code: "Backslash" }))).toEqual({ id: "sidebar" });
    expect(matchShortcut(key({ ctrlKey: true, key: ",", code: "Comma" }))).toEqual({ id: "settings" });
    expect(matchShortcut(key({ ctrlKey: true, key: "3", code: "Digit3" }))).toEqual({ id: "space", index: 2 });
    expect(matchShortcut(key({ ctrlKey: true, altKey: true, key: "¡", code: "Digit2" }))).toEqual({ id: "view", index: 1 });
    expect(matchShortcut(key({ key: "F6" }))).toEqual({ id: "landmark", direction: 1 });
    expect(matchShortcut(key({ key: "F6", shiftKey: true }))).toEqual({ id: "landmark", direction: -1 });
  });
  it("ignores plain typing and AltGr", () => {
    expect(matchShortcut(key({ key: "n" }))).toBeNull();
    expect(matchShortcut(key({ ctrlKey: true, altKey: true, key: "@", code: "Digit2", getModifierState: (k: string) => k === "AltGraph" }))).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 10, 10, 12, 0).getTime();
  it("reads short and stable", () => {
    expect(relativeTime(now - 20_000, now)).toBe("Just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe("Yesterday");
  });
});
