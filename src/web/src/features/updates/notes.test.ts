import { describe, expect, it } from "vitest";
import { isNewer, parseNotes } from "./notes";

const RELEASE_031 = `Download the installer for your operating system from the assets below. Phaethon 0.2 and later can also update from inside the app.

- Figures in replies are drawn again. A visualization written as a TikZ figure showed its source instead of the picture; it's compiled and drawn now, earlier replies included.
- No coding agent yet? Onboarding and Settings can install Claude Code or Codex for you.
- Emails can carry files from your space.
`;

const RELEASE_030 = `Pre-alpha desktop build. Phaethon is still in development and is not ready for real data.

**New in 0.3.0**

- **Memory that fades when it stops mattering.** Events and notes come up only when they're relevant.
- **People.** A card per person.

Download the installer for your operating system from the assets below:

- **macOS:** \`Phaethon-0.3.0-mac-arm64.dmg\` (Apple Silicon)
- **Windows:** \`Phaethon-0.3.0-win-x64.exe\`

This build isn't signed with an Apple Developer certificate, so macOS blocks it the first time you open it. Open System Settings › Privacy & Security and choose **Open Anyway**.`;

describe("parseNotes", () => {
  it("keeps the changes and drops the web page's download instructions", () => {
    const blocks = parseNotes(RELEASE_031);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: "list",
      items: [
        { lead: "Figures in replies are drawn again.", text: expect.stringContaining("TikZ figure") },
        { lead: null, text: "No coding agent yet? Onboarding and Settings can install Claude Code or Codex for you." },
        { lead: null, text: "Emails can carry files from your space." },
      ],
    });
  });

  it("turns bold leads into leads, drops headings, file lists and Gatekeeper steps", () => {
    const blocks = parseNotes(RELEASE_030);
    expect(blocks[0]).toEqual({ kind: "text", text: "Pre-alpha desktop build. Phaethon is still in development and is not ready for real data." });
    expect(blocks[1]).toEqual({
      kind: "list",
      items: [
        { lead: "Memory that fades when it stops mattering.", text: "Events and notes come up only when they're relevant." },
        { lead: "People.", text: "A card per person." },
      ],
    });
    expect(blocks).toHaveLength(2);
  });

  it("is empty for no notes", () => {
    expect(parseNotes(null)).toEqual([]);
    expect(parseNotes("  \n ")).toEqual([]);
  });
});

describe("isNewer", () => {
  it("compares numerically", () => {
    expect(isNewer("0.3.10", "0.3.9")).toBe(true);
    expect(isNewer("0.3.1", "0.3.1")).toBe(false);
    expect(isNewer("v0.4.0", "0.3.9")).toBe(true);
    expect(isNewer("0.3.0", "0.3.1")).toBe(false);
    expect(isNewer("garbage", "0.3.1")).toBe(false);
  });
});
